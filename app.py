#!/usr/bin/env python3
"""
ZC95 Web Manager - browser version of zc95_lua_manager.py.

Two tabs, served from one small web server:
  Scripts - pick a folder of .lua files on this server, upload them to the ZC95's
            slots 0-4, list / delete what's on the ZC95 (lua_manage.py / lua_upload.py)
  Control - start a pattern and drive it (webgui.py's remote control)

One upstream connection to the ZC95 is shared by every browser tab/device, using the
unchanged lib/ZcAsync.py and lib/WebHub.py from remote_access.

Configuration is by environment variable (see deploy/zc95-web.env):
  ZC95_WEB_HOST      address to listen on            (default 0.0.0.0)
  ZC95_WEB_PORT      port to listen on               (default 8080)
  ZC95_SCRIPTS_ROOT  folder the Scripts tab can browse (default ./scripts)
  ZC95_DATA_DIR      where settings.json is kept     (default ./data)
  ZC95_WEB_USER / ZC95_WEB_PASSWORD   optional HTTP basic auth (off when password is blank)

Run:  python3 app.py
"""
import asyncio
import base64
import json
import logging
import os
import secrets
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lib.WebHub import WebHub
from lib.ZcAsync import ZcAsyncError

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
SCRIPTS_ROOT = os.path.realpath(os.environ.get("ZC95_SCRIPTS_ROOT") or os.path.join(APP_DIR, "scripts"))
DATA_DIR = os.environ.get("ZC95_DATA_DIR") or os.path.join(APP_DIR, "data")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
WEB_USER = os.environ.get("ZC95_WEB_USER") or "zc95"
WEB_PASSWORD = os.environ.get("ZC95_WEB_PASSWORD") or ""

CONNECT_TIMEOUT = 8      # seconds to wait for the ZC95 websocket to open
MONITOR_INTERVAL = 5     # seconds between reachability checks / reconnect attempts
MAX_SCRIPT_BYTES = 256 * 1024
CONTROL_COMMANDS = {"start_pattern", "stop_pattern", "set_power", "menu_min_max", "menu_multi_choice", "soft_button"}

logger = logging.getLogger("zc95web")


# ---------- settings ----------

def load_settings():
  try:
    with open(SETTINGS_FILE, "r") as f:
      return json.load(f)
  except (OSError, ValueError):
    return {}


def save_settings(settings):
  os.makedirs(DATA_DIR, exist_ok=True)
  tmp = SETTINGS_FILE + ".tmp"
  with open(tmp, "w") as f:
    json.dump(settings, f, indent=2)
  os.replace(tmp, SETTINGS_FILE)


# ---------- scripts folder (confined to SCRIPTS_ROOT) ----------

def resolve_folder(rel):
  """Turn a path relative to SCRIPTS_ROOT into an absolute one, refusing anything outside it."""
  path = os.path.realpath(os.path.join(SCRIPTS_ROOT, (rel or "").lstrip("/\\")))
  if path != SCRIPTS_ROOT and not path.startswith(SCRIPTS_ROOT + os.sep):
    raise HTTPException(400, "Folder is outside the scripts root")
  if not os.path.isdir(path):
    raise HTTPException(404, "Folder not found: " + (rel or "/"))
  return path


def relative(path):
  rel = os.path.relpath(path, SCRIPTS_ROOT)
  return "" if rel == "." else rel.replace(os.sep, "/")


def script_path(folder_rel, name):
  if not name or "/" in name or "\\" in name or name.startswith(".") or not name.lower().endswith(".lua"):
    raise HTTPException(400, "Invalid script name")
  return os.path.join(resolve_folder(folder_rel), name)


# ---------- ZC95 connection ----------

class Hub(WebHub):
  """WebHub, plus: errors the ZC95 reports on its own (e.g. a bad Lua line during upload) go to the browsers."""

  async def _handle_unsolicited(self, message):
    if message.get("Result") == "ERROR" and message.get("Error"):
      await self._broadcast({"type": "error", "message": message["Error"]})
    await super()._handle_unsolicited(message)


class Manager:
  """Owns the browser clients and the (re)connectable Hub for the currently configured IP."""

  def __init__(self):
    self.clients = set()
    self.hub = None
    self.ip = load_settings().get("ip", "")
    self.reachable = False
    self.connect_lock = asyncio.Lock()
    self.script_lock = asyncio.Lock()   # one upload/delete at a time
    self.last_error = None

  @property
  def connected(self):
    task = self.hub.zc._reader_task if self.hub else None
    return task is not None and not task.done()

  def status(self):
    return {"type": "status", "ip": self.ip, "reachable": self.reachable, "connected": self.connected}

  async def broadcast(self, message):
    raw = json.dumps(message)
    for client in list(self.clients):
      try:
        await client.send_text(raw)
      except Exception:
        self.clients.discard(client)

  async def ensure(self):
    """Return a connected Hub, connecting (or reconnecting to a new IP) if needed."""
    async with self.connect_lock:
      if self.connected and self.hub.ip == self.ip:
        return self.hub
      await self.drop()
      if not self.ip:
        raise ZcAsyncError("No ZC95 IP address set")

      hub = Hub(self.ip)
      hub._clients = self.clients   # share one client set, so WebHub broadcasts reach every browser
      try:
        await asyncio.wait_for(hub.connect(), CONNECT_TIMEOUT)
      except Exception as e:  # timeout, refused, handshake rejected, ...
        await hub.close()
        raise ZcAsyncError("Could not connect to ZC95 at " + self.ip + " (" + (str(e) or type(e).__name__) + ")")

      self.hub = hub
      self.last_error = None
      logger.info("Connected to ZC95 at %s", self.ip)
      await self.broadcast(self.status())
      for client in list(self.clients):
        try:
          await hub._send_full_state(client)
        except Exception:
          self.clients.discard(client)
      return hub

  async def drop(self, stop_pattern=False):
    hub, self.hub = self.hub, None
    if hub is None:
      return
    if stop_pattern and hub._pattern_detail is not None:
      try:
        await hub.zc.request({"Type": "PatternStop"}, "Ack", timeout=2)
      except Exception:
        pass
    had_pattern = hub._pattern_detail is not None
    await hub.close()
    if had_pattern:
      await self.broadcast({"type": "pattern_stopped"})
    await self.broadcast(self.status())

  async def set_ip(self, ip):
    if ip != self.ip:
      self.ip = ip
      await self.drop()
      self.reachable = await self.check_reachable()
      await self.broadcast(self.status())

  async def check_reachable(self):
    if not self.ip:
      return False
    host, _, port = self.ip.partition(":")
    try:
      _, writer = await asyncio.wait_for(asyncio.open_connection(host, int(port or 80)), 2)
      writer.close()
      return True
    except (OSError, asyncio.TimeoutError, ValueError):
      return False

  async def monitor(self):
    """Keep the status light current and (re)connect whenever the ZC95 is reachable."""
    was_connected = False
    while True:
      try:
        self.reachable = await self.check_reachable()
        if was_connected and not self.connected:
          logger.info("Lost connection to ZC95")
          await self.broadcast({"type": "error", "message": "Lost connection to ZC95"})
          await self.drop()
        if self.reachable and not self.connected:
          try:
            await self.ensure()
          except ZcAsyncError as e:
            if str(e) != self.last_error:
              self.last_error = str(e)
              logger.warning("%s", e)
        was_connected = self.connected
        await self.broadcast(self.status())
      except Exception:
        logger.exception("monitor")
      await asyncio.sleep(MONITOR_INTERVAL)

  async def refresh_patterns(self, hub):
    hub._patterns = (await hub.zc.request({"Type": "GetPatterns"}, "PatternList"))["Patterns"]
    await self.broadcast({"type": "patterns", "patterns": hub._patterns})


manager = None


@asynccontextmanager
async def lifespan(app):
  global manager
  manager = Manager()
  os.makedirs(SCRIPTS_ROOT, exist_ok=True)
  task = asyncio.create_task(manager.monitor())
  logger.info("Scripts root: %s", SCRIPTS_ROOT)
  try:
    yield
  finally:
    task.cancel()
    await manager.drop(stop_pattern=True)   # don't leave a pattern running when the service stops


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


# ---------- optional basic auth ----------

def authorised(header):
  if not WEB_PASSWORD:
    return True
  if not header or not header.lower().startswith("basic "):
    return False
  try:
    user, _, password = base64.b64decode(header[6:]).decode("utf-8").partition(":")
  except Exception:
    return False
  return secrets.compare_digest(user, WEB_USER) and secrets.compare_digest(password, WEB_PASSWORD)


@app.middleware("http")
async def basic_auth(request: Request, call_next):
  if not authorised(request.headers.get("authorization")):
    return Response("Login required", status_code=401, headers={"WWW-Authenticate": 'Basic realm="ZC95"'})
  return await call_next(request)


# ---------- settings API ----------

class SettingsIn(BaseModel):
  ip: str = ""
  scripts_dir: str = ""


@app.get("/api/settings")
async def get_settings():
  settings = load_settings()
  return {"ip": settings.get("ip", ""), "scripts_dir": settings.get("scripts_dir", ""), "scripts_root": SCRIPTS_ROOT}


@app.post("/api/settings")
async def post_settings(body: SettingsIn):
  ip = body.ip.strip()
  folder = relative(resolve_folder(body.scripts_dir.strip()))
  settings = load_settings()
  settings.update(ip=ip, scripts_dir=folder)
  try:
    save_settings(settings)
  except OSError as e:
    raise HTTPException(500, "Couldn't save settings: " + str(e))
  await manager.set_ip(ip)
  return {"ip": ip, "scripts_dir": folder}


@app.post("/api/connect")
async def connect_now(body: SettingsIn):
  """Use this IP now (without saving it) and connect."""
  await manager.set_ip(body.ip.strip())
  try:
    await manager.ensure()
  except ZcAsyncError as e:
    raise HTTPException(502, str(e))
  return manager.status()


# ---------- server folders / local scripts ----------

@app.get("/api/folders")
async def list_folder(path: str = ""):
  folder = resolve_folder(path)
  entries = sorted(os.listdir(folder), key=str.lower)
  folders = [e for e in entries if not e.startswith(".") and os.path.isdir(os.path.join(folder, e))]
  scripts = [e for e in entries if e.lower().endswith(".lua") and os.path.isfile(os.path.join(folder, e))]
  rel = relative(folder)
  parent = None if folder == SCRIPTS_ROOT else relative(os.path.dirname(folder))
  return {"path": rel, "parent": parent, "folders": folders, "scripts": scripts, "root": SCRIPTS_ROOT}


class ScriptIn(BaseModel):
  path: str = ""
  name: str
  content: str


@app.post("/api/local-scripts")
async def add_local_script(body: ScriptIn):
  """Save a .lua file from the browser into a folder on this server."""
  if len(body.content.encode("utf-8")) > MAX_SCRIPT_BYTES:
    raise HTTPException(400, "Script is too large")
  target = script_path(body.path, body.name)
  with open(target, "w", encoding="utf-8", newline="\n") as f:
    f.write(body.content)
  return {"saved": body.name}


@app.get("/api/local-scripts/view")
async def view_local_script(path: str, name: str):
  with open(script_path(path, name), "r", encoding="utf-8", errors="replace") as f:
    return {"name": name, "content": f.read(MAX_SCRIPT_BYTES)}


# ---------- scripts on the ZC95 ----------

async def zc_hub():
  try:
    return await manager.ensure()
  except ZcAsyncError as e:
    raise HTTPException(502, str(e))


@app.get("/api/zc95/scripts")
async def zc95_scripts():
  hub = await zc_hub()
  try:
    return (await hub.zc.request({"Type": "GetLuaScripts"}, "LuaScripts"))["Scripts"]
  except ZcAsyncError as e:
    raise HTTPException(502, str(e))


class UploadIn(BaseModel):
  path: str = ""
  name: str
  slot: int


@app.post("/api/zc95/upload")
async def zc95_upload(body: UploadIn):
  if not 0 <= body.slot <= 4:
    raise HTTPException(400, "Slot must be 0-4")
  try:
    with open(script_path(body.path, body.name), "r", encoding="utf-8") as f:
      lines = f.read().splitlines()
  except OSError as e:
    raise HTTPException(400, "Can't read script: " + str(e))

  hub = await zc_hub()
  if manager.script_lock.locked():
    raise HTTPException(409, "Another upload or delete is in progress")

  async with manager.script_lock:
    total = len(lines)
    progress = {"type": "upload_progress", "name": body.name, "slot": body.slot, "line": 0, "total": total}
    await manager.broadcast(progress)
    step = "start of upload"
    try:
      await hub.zc.request({"Type": "LuaStart", "Index": body.slot}, "Ack")
      for number, text in enumerate(lines):
        step = "line " + str(number + 1)
        await hub.zc.request({"Type": "LuaLine", "LineNumber": number, "Text": text.rstrip()}, "Ack")
        if number % 5 == 4 or number == total - 1:
          await manager.broadcast(dict(progress, line=number + 1))
      step = "end of upload (the ZC95 checks the script here - look for Lua errors)"
      await hub.zc.request({"Type": "LuaEnd"}, "Ack")
      scripts = (await hub.zc.request({"Type": "GetLuaScripts"}, "LuaScripts"))["Scripts"]
      await manager.refresh_patterns(hub)
    except ZcAsyncError as e:
      await manager.broadcast(dict(progress, line=-1))
      raise HTTPException(502, "Upload failed at " + step + ": " + str(e))

  await manager.broadcast({"type": "log", "message": "Uploaded " + body.name + " to slot " + str(body.slot)})
  return scripts


@app.delete("/api/zc95/scripts/{slot}")
async def zc95_delete(slot: int):
  if not 0 <= slot <= 4:
    raise HTTPException(400, "Slot must be 0-4")
  hub = await zc_hub()
  async with manager.script_lock:
    try:
      await hub.zc.request({"Type": "DeleteLuaScript", "Index": slot}, "Ack")
      scripts = (await hub.zc.request({"Type": "GetLuaScripts"}, "LuaScripts"))["Scripts"]
      await manager.refresh_patterns(hub)
    except ZcAsyncError as e:
      raise HTTPException(502, str(e))
  await manager.broadcast({"type": "log", "message": "Deleted slot " + str(slot)})
  return scripts


# ---------- live updates + pattern control ----------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
  if not authorised(websocket.headers.get("authorization")):
    await websocket.close(code=1008)
    return
  await websocket.accept()
  manager.clients.add(websocket)
  try:
    await websocket.send_text(json.dumps(manager.status()))
    if manager.connected:
      await manager.hub._send_full_state(websocket)
    while True:
      message = await websocket.receive_json()
      cmd = message.get("cmd")
      if cmd != "get_patterns" and cmd not in CONTROL_COMMANDS:
        continue
      if not manager.connected:
        await websocket.send_text(json.dumps({"type": "error", "message": "Not connected to the ZC95"}))
        continue
      try:
        if cmd == "get_patterns":
          await manager.refresh_patterns(manager.hub)
        else:
          await manager.hub.handle_client_message(message)
      except (ZcAsyncError, KeyError, TypeError, ValueError) as e:
        await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
  except (WebSocketDisconnect, RuntimeError):
    pass
  finally:
    manager.clients.discard(websocket)


# Mounted last so it doesn't shadow the routes above; serves static/index.html at "/"
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
  logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
  uvicorn.run(app, host=os.environ.get("ZC95_WEB_HOST", "0.0.0.0"), port=int(os.environ.get("ZC95_WEB_PORT", "8080")))
