(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const statusEl = $("status");
  const statusTextEl = $("status-text");
  const ipInput = $("ip-input");
  const logEl = $("log");

  let ws = null;
  let reconnectDelayMs = 1000;
  let zcConnected = false;
  let savedSettings = { ip: "", scripts_dir: "" };

  // ---------- helpers ----------

  function log(text, kind) {
    const line = document.createElement("div");
    if (kind) line.className = "log-" + kind;
    line.textContent = new Date().toLocaleTimeString() + "  " + text;
    logEl.appendChild(line);
    while (logEl.childElementCount > 500) logEl.firstElementChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function api(method, url, body) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    let data = null;
    try { data = await response.json(); } catch (e) { /* no body */ }
    if (!response.ok) {
      const detail = data && data.detail;
      throw new Error(typeof detail === "string" ? detail : (response.status + " " + response.statusText));
    }
    return data;
  }

  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function fillList(listEl, items, placeholder) {
    listEl.innerHTML = "";
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "placeholder";
      li.textContent = placeholder;
      listEl.appendChild(li);
    }
    for (const item of items) listEl.appendChild(item);
  }

  function selectable(listEl, li, onSelect) {
    li.addEventListener("click", () => {
      for (const other of listEl.children) other.classList.remove("selected");
      li.classList.add("selected");
      if (onSelect) onSelect();
    });
    return li;
  }

  function selectedItem(listEl) {
    return listEl.querySelector("li.selected");
  }

  // ---------- tabs ----------

  const tabs = document.querySelectorAll(".tab");
  let currentView = "scripts";

  function showView(view) {
    currentView = view;
    for (const tab of tabs) tab.classList.toggle("active", tab.dataset.view === view);
    $("view-scripts").hidden = view !== "scripts";
    $("view-control").hidden = view !== "control";
    if (view === "control" && zcConnected && !patternRunning) send({ cmd: "get_patterns" });
  }

  for (const tab of tabs) tab.addEventListener("click", () => showView(tab.dataset.view));

  // ---------- server connection + status ----------

  function setStatus(state, text) {
    statusEl.className = "status status-" + state;
    statusTextEl.textContent = text;
  }

  function connect() {
    setStatus("connecting", "connecting to server…");
    const scheme = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(scheme + location.host + "/ws");

    ws.onopen = () => {
      reconnectDelayMs = 1000;
      log("Connected to server");
    };

    ws.onclose = () => {
      setStatus("disconnected", "server offline");
      zcConnected = false;
      setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10000);
    };

    ws.onerror = () => ws.close();
    ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
  }

  function updateZcStatus(message) {
    const ip = message.ip;
    if (!ip) {
      setStatus("disconnected", "no ZC95 IP set");
    } else if (message.connected) {
      setStatus("connected", "ZC95 connected (" + ip + ")");
    } else if (message.reachable) {
      setStatus("connecting", "ZC95 available, connecting… (" + ip + ")");
    } else {
      setStatus("disconnected", "ZC95 not reachable (" + ip + ")");
    }

    const wasConnected = zcConnected;
    zcConnected = message.connected;
    if (zcConnected && !wasConnected) {
      log("Connected to ZC95 at " + ip, "ok");
      refreshRemote();
    } else if (!zcConnected && wasConnected) {
      log("ZC95 disconnected", "error");
    }
  }

  function handleMessage(message) {
    switch (message.type) {
      case "status": updateZcStatus(message); break;
      case "patterns": patterns = message.patterns; renderPatternList(); break;
      case "pattern_detail": showPatternRunning(message.detail); break;
      case "pattern_stopped": showPatternPicker(); break;
      case "power_status": updatePowerStatus(message.status); break;
      case "power_request": updatePowerRequest(message); break;
      case "menu_option_changed": updateMenuOption(message.menu_id, message.value); break;
      case "upload_progress": updateUploadProgress(message); break;
      case "lua_output":
        log((message.text_type === "Error" ? "[lua error] " : "[lua] ") + message.text, message.text_type === "Error" ? "error" : null);
        break;
      case "lua_error": log("Script stopped due to an error", "error"); break;
      case "error": log(message.message, "error"); break;
      case "log": log(message.message); break;
    }
  }

  // ---------- settings ----------

  async function loadSettings() {
    try {
      savedSettings = await api("GET", "/api/settings");
      ipInput.value = savedSettings.ip;
      currentFolder = savedSettings.scripts_dir || "";
      showFolder();
      await readFolder(true);
    } catch (e) {
      log("Couldn't load settings: " + e.message, "error");
    }
  }

  $("save-settings-btn").addEventListener("click", async () => {
    try {
      savedSettings = await api("POST", "/api/settings", { ip: ipInput.value.trim(), scripts_dir: currentFolder });
      log("Settings saved (IP " + (savedSettings.ip || "<blank>") + ", folder /" + savedSettings.scripts_dir + ")", "ok");
    } catch (e) {
      log("Couldn't save settings: " + e.message, "error");
    }
  });

  async function connectNow() {
    const ip = ipInput.value.trim();
    if (!ip) { log("Enter the ZC95's IP address first", "error"); return; }
    log("Connecting to ZC95 at " + ip + "…");
    try {
      await api("POST", "/api/connect", { ip });
    } catch (e) {
      log(e.message, "error");
    }
  }

  $("connect-btn").addEventListener("click", connectNow);
  ipInput.addEventListener("keydown", (e) => { if (e.key === "Enter") connectNow(); });

  // ---------- scripts folder ----------

  let currentFolder = "";
  let localScripts = [];

  function showFolder() {
    $("folder-path").textContent = "/" + currentFolder;
  }

  async function readFolder(quiet) {
    const listEl = $("local-list");
    try {
      const data = await api("GET", "/api/folders?path=" + encodeURIComponent(currentFolder));
      localScripts = data.scripts;
      fillList(listEl, localScripts.map((name) => {
        const li = document.createElement("li");
        li.textContent = name;
        li.dataset.name = name;
        li.addEventListener("dblclick", upload);
        return selectable(listEl, li);
      }), "No .lua files in this folder");
      if (!quiet) log("Found " + localScripts.length + " .lua script(s) in /" + data.path);
    } catch (e) {
      fillList(listEl, [], "Couldn't read folder");
      log("Couldn't read folder /" + currentFolder + ": " + e.message, "error");
    }
  }

  $("read-btn").addEventListener("click", () => readFolder(false));

  // Folder picker dialog: browses folders on the server, under its scripts root
  const dialog = $("folder-dialog");
  let dialogPath = "";
  let dialogParent = null;

  async function browseTo(path) {
    const listEl = $("folder-list");
    try {
      const data = await api("GET", "/api/folders?path=" + encodeURIComponent(path));
      dialogPath = data.path;
      dialogParent = data.parent;
      $("folder-dialog-path").textContent = "/" + data.path;
      $("folder-up").disabled = data.parent === null;
      $("folder-dialog-info").textContent = data.scripts.length + " .lua file(s) here. Folders are under " + data.root + " on the server.";
      fillList(listEl, data.folders.map((name) => {
        const li = document.createElement("li");
        li.textContent = name;
        li.addEventListener("click", () => browseTo((data.path ? data.path + "/" : "") + name));
        return li;
      }), "No sub-folders");
    } catch (e) {
      log("Couldn't open folder: " + e.message, "error");
    }
  }

  $("browse-btn").addEventListener("click", async () => {
    await browseTo(currentFolder);
    dialog.showModal();
  });
  $("folder-up").addEventListener("click", () => { if (dialogParent !== null) browseTo(dialogParent); });
  $("folder-cancel").addEventListener("click", () => dialog.close());
  $("folder-choose").addEventListener("click", () => {
    currentFolder = dialogPath;
    showFolder();
    dialog.close();
    readFolder(false);
  });

  // Copy .lua files from this device into the current server folder
  $("add-file-input").addEventListener("change", async (event) => {
    for (const file of event.target.files) {
      try {
        await api("POST", "/api/local-scripts", { path: currentFolder, name: file.name, content: await file.text() });
        log("Saved " + file.name + " to /" + currentFolder, "ok");
      } catch (e) {
        log("Couldn't save " + file.name + ": " + e.message, "error");
      }
    }
    event.target.value = "";
    readFolder(true);
  });

  // ---------- scripts on the ZC95 ----------

  const remoteListEl = $("remote-list");
  const scriptButtons = [$("upload-btn"), $("refresh-btn"), $("delete-btn")];

  function setBusy(busy) {
    for (const btn of scriptButtons) btn.disabled = busy;
  }

  function showRemote(scripts) {
    fillList(remoteListEl, scripts.map((script) => {
      const li = document.createElement("li");
      li.textContent = script.Index + " - " + (script.Name || "(empty)");
      li.dataset.index = script.Index;
      if (!script.Name) li.classList.add("empty-slot");
      // Selecting a slot here also picks it as the upload target
      return selectable(remoteListEl, li, () => { $("slot-select").value = String(script.Index); });
    }), "Not loaded");
  }

  async function refreshRemote() {
    setBusy(true);
    try {
      showRemote(await api("GET", "/api/zc95/scripts"));
    } catch (e) {
      log("Couldn't list scripts on ZC95: " + e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    const item = selectedItem($("local-list"));
    if (!item || !item.dataset.name) { log("Select a script to upload", "error"); return; }
    const slot = parseInt($("slot-select").value, 10);
    log("Uploading " + item.dataset.name + " to slot " + slot + "…");
    setBusy(true);
    try {
      showRemote(await api("POST", "/api/zc95/upload", { path: currentFolder, name: item.dataset.name, slot }));
    } catch (e) {
      log(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function updateUploadProgress(message) {
    const bar = $("upload-progress");
    bar.max = Math.max(message.total, 1);
    bar.value = Math.max(message.line, 0);
  }

  async function deleteSlot() {
    const item = selectedItem(remoteListEl);
    if (!item || item.dataset.index === undefined) { log("Select a slot on the right to delete", "error"); return; }
    const index = parseInt(item.dataset.index, 10);
    if (!confirm("Delete the script in slot " + index + " on the ZC95?")) return;
    setBusy(true);
    try {
      showRemote(await api("DELETE", "/api/zc95/scripts/" + index));
    } catch (e) {
      log("Delete failed: " + e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  $("upload-btn").addEventListener("click", upload);
  $("refresh-btn").addEventListener("click", refreshRemote);
  $("delete-btn").addEventListener("click", deleteSlot);

  // ---------- control view (ported from remote_access/web_static/app.js) ----------

  const patternPickerEl = $("pattern-picker");
  const patternSelectEl = $("pattern-select");
  const patternRunningEl = $("pattern-running");
  const patternNameEl = $("pattern-name");
  const triphaseBadgeEl = $("triphase-badge");
  const softButtonRowEl = $("soft-button-row");
  const softButtonEl = $("soft-button");
  const menuItemsEl = $("menu-items");
  const channelsEl = $("channels");
  const tmplMinMax = $("tmpl-min-max");
  const tmplMultiChoice = $("tmpl-multi-choice");
  const tmplChannel = $("tmpl-channel");

  let patterns = [];
  let patternRunning = false;
  const powerValues = [0, 0, 0, 0];
  const channelEls = [];
  const minMaxControls = new Map();
  const multiChoiceControls = new Map();

  // Other tabs/devices can move the same sliders - don't yank one out from under an active drag
  function bindDragGuard(slider) {
    const setDragging = (dragging) => { slider.dataset.dragging = dragging ? "1" : ""; };
    slider.addEventListener("pointerdown", () => setDragging(true));
    slider.addEventListener("pointerup", () => setDragging(false));
    slider.addEventListener("pointercancel", () => setDragging(false));
  }

  const isDragging = (slider) => slider.dataset.dragging === "1";

  function renderPatternList() {
    const previous = patternSelectEl.value;
    patternSelectEl.innerHTML = "";
    for (const pattern of patterns) {
      const option = document.createElement("option");
      option.value = pattern.Id;
      option.textContent = pattern.Name;
      patternSelectEl.appendChild(option);
    }
    if (patterns.some((p) => String(p.Id) === previous)) patternSelectEl.value = previous;
  }

  $("start-btn").addEventListener("click", () => {
    const id = parseInt(patternSelectEl.value, 10);
    if (!Number.isNaN(id)) send({ cmd: "start_pattern", id });
  });
  $("reload-patterns-btn").addEventListener("click", () => send({ cmd: "get_patterns" }));
  $("stop-btn").addEventListener("click", () => send({ cmd: "stop_pattern" }));

  function showPatternPicker() {
    patternRunning = false;
    patternPickerEl.hidden = false;
    patternRunningEl.hidden = true;
  }

  function showPatternRunning(detail) {
    patternRunning = true;
    patternPickerEl.hidden = true;
    patternRunningEl.hidden = false;
    patternNameEl.textContent = detail.Name;

    // PatternDetail lacks PatternList's "(!)" triphase prefix, so cross-reference the list
    const listEntry = patterns.find((p) => p.Id === detail.Id);
    triphaseBadgeEl.hidden = !(listEntry && listEntry.Name.startsWith("(!)"));

    softButtonRowEl.hidden = !(detail.ButtonA && detail.ButtonA.length > 0);
    softButtonEl.textContent = detail.ButtonA || "Soft button";

    menuItemsEl.innerHTML = "";
    minMaxControls.clear();
    multiChoiceControls.clear();
    for (const item of detail.MenuItems || []) {
      if (item.Type === "MIN_MAX") buildMinMax(item);
      else if (item.Type === "MULTI_CHOICE") buildMultiChoice(item);
    }
    if (!menuItemsEl.childElementCount) {
      menuItemsEl.innerHTML = '<p class="muted">This pattern has no settings.</p>';
    }

    buildChannels();
  }

  function buildMinMax(item) {
    const node = tmplMinMax.content.firstElementChild.cloneNode(true);
    node.querySelector(".menu-title").textContent = item.Title + (item.UoM ? " (" + item.UoM + ")" : "");
    const valueEl = node.querySelector(".menu-value");
    const slider = node.querySelector(".menu-slider");
    slider.min = item.Min;
    slider.max = item.Max;
    slider.step = item.IncrementStep;
    slider.value = item.Default;
    valueEl.textContent = item.Default;

    const control = { slider, valueEl, min: item.Min, max: item.Max, step: item.IncrementStep };
    minMaxControls.set(item.Id, control);
    bindDragGuard(slider);

    slider.addEventListener("input", () => { valueEl.textContent = slider.value; });
    slider.addEventListener("change", () => {
      send({ cmd: "menu_min_max", menu_id: item.Id, value: parseInt(slider.value, 10) });
    });
    node.querySelector(".btn-dec").addEventListener("click", () => stepMinMax(item.Id, -control.step));
    node.querySelector(".btn-inc").addEventListener("click", () => stepMinMax(item.Id, control.step));
    menuItemsEl.appendChild(node);
  }

  function stepMinMax(menuId, delta) {
    const control = minMaxControls.get(menuId);
    if (!control) return;
    const value = Math.max(control.min, Math.min(control.max, parseInt(control.slider.value, 10) + delta));
    control.slider.value = value;
    control.valueEl.textContent = value;
    send({ cmd: "menu_min_max", menu_id: menuId, value });
  }

  function buildMultiChoice(item) {
    const node = tmplMultiChoice.content.firstElementChild.cloneNode(true);
    node.querySelector(".menu-title").textContent = item.Title;
    const group = node.querySelector(".choice-group");
    const buttons = new Map();
    for (const choice of item.Choices) {
      const btn = document.createElement("button");
      btn.className = "choice-btn";
      btn.type = "button";
      btn.textContent = choice.Name;
      if (choice.Id === item.Default) btn.classList.add("active");
      btn.addEventListener("click", () => {
        setMultiChoiceActive(item.Id, choice.Id);
        send({ cmd: "menu_multi_choice", menu_id: item.Id, choice_id: choice.Id });
      });
      group.appendChild(btn);
      buttons.set(choice.Id, btn);
    }
    multiChoiceControls.set(item.Id, { buttons });
    menuItemsEl.appendChild(node);
  }

  function setMultiChoiceActive(menuId, choiceId) {
    const control = multiChoiceControls.get(menuId);
    if (!control) return;
    for (const [id, btn] of control.buttons) btn.classList.toggle("active", id === choiceId);
  }

  function updateMenuOption(menuId, value) {
    if (minMaxControls.has(menuId)) {
      const control = minMaxControls.get(menuId);
      if (isDragging(control.slider)) return;
      control.slider.value = value;
      control.valueEl.textContent = value;
    } else if (multiChoiceControls.has(menuId)) {
      setMultiChoiceActive(menuId, value);
    }
  }

  // Soft button: held down while pressed, released on pointer up/cancel/leave
  (function bindSoftButton() {
    let pressed = false;
    const press = (e) => {
      e.preventDefault();
      if (pressed) return;
      pressed = true;
      softButtonEl.classList.add("pressed");
      send({ cmd: "soft_button", pressed: true });
    };
    const release = () => {
      if (!pressed) return;
      pressed = false;
      softButtonEl.classList.remove("pressed");
      send({ cmd: "soft_button", pressed: false });
    };
    softButtonEl.addEventListener("pointerdown", press);
    softButtonEl.addEventListener("pointerup", release);
    softButtonEl.addEventListener("pointercancel", release);
    softButtonEl.addEventListener("pointerleave", release);
    softButtonEl.style.touchAction = "none";
  })();

  const CHANNEL_STEP = 10; // 1000-basis units, i.e. 1%

  function buildChannels() {
    channelsEl.innerHTML = "";
    channelEls.length = 0;
    for (let i = 0; i < 4; i++) {
      const node = tmplChannel.content.firstElementChild.cloneNode(true);
      node.querySelector(".channel-label").textContent = "Channel " + (i + 1);
      const slider = node.querySelector(".channel-slider");
      const percentEl = node.querySelector(".channel-percent");
      slider.value = 0;
      powerValues[i] = 0;
      bindDragGuard(slider);
      slider.addEventListener("input", () => setChannelPower(i, parseInt(slider.value, 10)));
      node.querySelector(".btn-dec").addEventListener("click", () => stepChannelPower(i, -CHANNEL_STEP));
      node.querySelector(".btn-inc").addEventListener("click", () => stepChannelPower(i, CHANNEL_STEP));
      channelEls[i] = {
        slider, percentEl,
        barMax: node.querySelector(".channel-bar-max"),
        barActual: node.querySelector(".channel-bar-actual"),
        barLimit: node.querySelector(".channel-bar-limit"),
      };
      channelsEl.appendChild(node);
    }
  }

  function setChannelPower(index, value) {
    powerValues[index] = value;
    channelEls[index].slider.value = value;
    channelEls[index].percentEl.textContent = Math.round(value / 10) + "%";
    send({ cmd: "set_power", chan1: powerValues[0], chan2: powerValues[1], chan3: powerValues[2], chan4: powerValues[3] });
  }

  function stepChannelPower(index, delta) {
    setChannelPower(index, Math.max(0, Math.min(1000, powerValues[index] + delta)));
  }

  function updatePowerStatus(status) {
    for (const channel of status.Channels) {
      const el = channelEls[channel.Channel - 1];
      if (!el) continue;
      el.barMax.style.width = (channel.MaxOutputPower / 10) + "%";
      el.barActual.style.width = (channel.OutputPower / 10) + "%";
      el.barLimit.style.left = (channel.PowerLimit / 10) + "%";
    }
  }

  // Power requested by any connected browser - keeps the sliders in sync across tabs/devices
  function updatePowerRequest(message) {
    const values = [message.chan1, message.chan2, message.chan3, message.chan4];
    for (let i = 0; i < 4; i++) {
      const el = channelEls[i];
      if (!el || isDragging(el.slider)) continue;
      powerValues[i] = values[i];
      el.slider.value = values[i];
      el.percentEl.textContent = Math.round(values[i] / 10) + "%";
    }
  }

  // ---------- log + theme ----------

  $("log-clear").addEventListener("click", () => { logEl.innerHTML = ""; });

  const THEME_KEY = "zc95-theme";
  const themeToggleBtn = $("theme-toggle");

  function currentTheme() {
    const light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    return document.documentElement.getAttribute("data-theme") || (light ? "light" : "dark");
  }

  function updateThemeToggleIcon() {
    const dark = currentTheme() === "dark";
    themeToggleBtn.textContent = dark ? "🌙" : "☀️";
    themeToggleBtn.title = dark ? "Switch to light theme" : "Switch to dark theme";
  }

  themeToggleBtn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* theme just won't persist */ }
    updateThemeToggleIcon();
  });

  // ---------- start ----------

  updateThemeToggleIcon();
  showRemote([]);
  showView("scripts");
  loadSettings();
  connect();
})();
