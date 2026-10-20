# ZC95 Web Manager

The browser version of the ZC95 Lua Manager. It runs on a Linux server and you use it from any browser
on your network (PC, phone, tablet):

- **Scripts** tab (opens by default): choose a folder of `.lua` files **on the server**, upload a script to
  ZC95 slot 0-4, list / delete the scripts on the ZC95, and copy `.lua` files from your device to the server.
- **Control** tab: start a pattern and drive it (menu options, soft button, channel power), the same as
  `remote_access/webgui.py`. Several browsers can be open at once and stay in sync.

The server keeps one connection to the ZC95 and reconnects automatically. It uses `lib/ZcAsync.py` and
`lib/WebHub.py` copied unchanged from `zc95_lua/remote_access`.

## Files

```
zc95_web/
  app.py                  web server (FastAPI)
  requirements.txt        Python packages
  lib/                    ZcAsync.py + WebHub.py (from remote_access)
  static/                 index.html, app.css, app.js (the web page)
  scripts/examples/       example Lua scripts (copied to the server's scripts folder on first install)
  deploy/install.sh       installer / updater for Rocky/Alma/RHEL or Debian/Ubuntu
  deploy/zc95-web.service systemd service
  deploy/zc95-web.env     settings template (port, scripts folder, optional password)
```

## Setting it up on a Linux server (port 8080)

Works on **Rocky Linux / AlmaLinux / RHEL 8 or 9** and on Debian 11+ / Ubuntu 22.04+, including in a
Proxmox LXC. The installer works out which one it's on. The server must be able to reach the ZC95's IP
on port 80, so it needs to be on the same network.

### 1. Copy the folder to the server

From Windows (PowerShell), replacing `SERVER` with the server's IP address:

```
scp -r A:\Claude_dev\zc95_web root@SERVER:/root/
```

### 2. Run the installer

```
ssh root@SERVER "bash /root/zc95_web/deploy/install.sh"
```

The installer:

- installs Python and `rsync`:
  - **Rocky/RHEL** (`dnf`): `python3.12`, or `python3.11` if 3.12 isn't available. The stock `python3` is
    too old on Rocky 8 (3.6), and Python 3.9 or newer is needed.
  - **Debian/Ubuntu** (`apt`): `python3` and `python3-venv`.
- creates a `zc95web` system user
- copies the app to `/opt/zc95-web` and installs the Python packages into `/opt/zc95-web/venv`
- creates `/etc/zc95-web/zc95-web.env` (port **8080**) the first time only
- creates the scripts folder `/var/lib/zc95-web/scripts` and puts the example scripts in it on first install
- on SELinux systems (Rocky), resets the copied files to their default SELinux labels
- installs and starts the `zc95-web` systemd service, which starts again on boot
- opens port 8080 in **firewalld** (Rocky) or **ufw** (Ubuntu) if that firewall is running

When it finishes, it prints the address, e.g. `http://192.168.0.160:8080/`.

### 3. First use

1. Browse to `http://SERVER:8080/`.
2. Type the ZC95's IP address and click **Connect**. The status at the top right turns green.
3. Click **Browse...** to choose a folder under `/var/lib/zc95-web/scripts`, then **Read**.
4. Click **Save settings** so the IP and folder are used every time (they're stored on the server).

### If the page doesn't load (Rocky)

- Check the service is running: `systemctl status zc95-web`. If it isn't, `journalctl -u zc95-web -n 50` says why.
- Check the port is open: `firewall-cmd --list-ports` should include `8080/tcp`. If it doesn't, run
  `firewall-cmd --permanent --add-port=8080/tcp && firewall-cmd --reload`.
- If SELinux blocks it, `ausearch -m avc -ts recent` shows a denial. This is unlikely, because the service
  runs unconfined.

### Updating

Copy the folder again and re-run the installer (steps 1 and 2). It updates the code and restarts the
service, but keeps your settings and scripts.

## Getting scripts onto the server

You can only pick folders under the scripts root (`/var/lib/zc95-web/scripts` by default). To add scripts:

- use **Add file...** on the Scripts tab to copy `.lua` files from the device you're browsing on, or
- copy them in with scp and give them to the service user:

  ```
  scp -r C:\path\to\my_scripts root@SERVER:/var/lib/zc95-web/scripts/
  ssh root@SERVER "chown -R zc95web:zc95web /var/lib/zc95-web/scripts"
  ```

## Configuration

Edit `/etc/zc95-web/zc95-web.env` on the server, then run `systemctl restart zc95-web`.

| Setting | Default | |
|---|---|---|
| `ZC95_WEB_PORT` | `8080` | Port for the web page |
| `ZC95_WEB_HOST` | `0.0.0.0` | `0.0.0.0` = reachable from the network; `127.0.0.1` = this server only |
| `ZC95_SCRIPTS_ROOT` | `/var/lib/zc95-web/scripts` | The only folder tree the Scripts tab can browse |
| `ZC95_DATA_DIR` | `/var/lib/zc95-web` | Where `settings.json` (IP + folder) is kept |
| `ZC95_WEB_USER` / `ZC95_WEB_PASSWORD` | `zc95` / blank | Set a password to require a login. Blank means no login. |

If you move `ZC95_SCRIPTS_ROOT`, make that folder owned by `zc95web` so **Add file...** can write to it.

**Security:** with no password, anyone on your network who can reach port 8080 can upload scripts and
control the ZC95. Set `ZC95_WEB_PASSWORD` unless the network is trusted. Don't expose the port to the internet.

## Day-to-day

```
systemctl status zc95-web       # is it running?
journalctl -u zc95-web -f       # live log
systemctl restart zc95-web      # after editing the .env file
```

Stopping or restarting the service stops any pattern that's running. Closing the browser does **not**
(the same as `webgui.py`). Use **Stop** first.

## Running it without installing (testing)

On any machine with Python 3.8+:

```
pip install -r requirements.txt
python3 app.py
```

Then browse to `http://localhost:8080/`. Settings go in `./data`, and the Scripts tab browses `./scripts`.

## Credits

`lib/ZcAsync.py`, `lib/WebHub.py`, the example Lua scripts and the Control tab's design come from the
[ZC95 project](https://github.com/CrashOverride85/zc95). The desktop version of this app is
[zc95_app](https://github.com/SedyDev23/zc95_app).

## Licence

GNU General Public License v3.0, the same as the ZC95 project; see [LICENSE](LICENSE). The files copied from
the ZC95 project remain under that project's copyright.
