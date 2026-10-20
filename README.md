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
  deploy/install.sh       installer / updater; detects the Linux distro and installs what it needs
  deploy/zc95-web.service systemd service
  deploy/zc95-web.env     settings template (port, scripts folder, optional password)
  Dockerfile, docker-compose.yml, docker/   run it as a Docker container instead
```

There are two ways to run it on a server: [in Docker](#running-it-in-docker), or
[installed directly](#setting-it-up-on-a-linux-server-port-8080) as a systemd service. Use one or the
other, not both (they'd both want port 8080).

## Running it in Docker

Needs Docker with the compose plugin (`docker compose`). The server must be on the same network as the
ZC95; the container reaches it through Docker's normal networking, so nothing special is needed.

### Build and start it from this folder

Copy the folder to the server (or `git clone https://github.com/SedyDev23/zc95_web.git`), then in it:

```
docker compose up -d --build
```

Browse to `http://<server-ip>:8080/`, enter the ZC95's IP, click **Connect**, then **Save settings**.

### Or use the published image (no build)

Each version tag publishes the image to `ghcr.io/sedydev23/zc95-web`. In `docker-compose.yml`, swap
`build: .` and `image: zc95-web` for `image: ghcr.io/sedydev23/zc95-web:latest`, then:

```
docker compose up -d
```

Or without compose:

```
docker run -d --name zc95-web --restart unless-stopped -p 8080:8080 -v zc95-data:/data -v zc95-scripts:/scripts ghcr.io/sedydev23/zc95-web:latest
```

(The first time it's published, GitHub makes the image private. To let servers pull it without logging
in, open the package on GitHub, then **Package settings** > **Change visibility** > **Public**.)

### Settings and data

| | |
|---|---|
| `zc95-data` volume (`/data`) | The saved IP and folder |
| `zc95-scripts` volume (`/scripts`) | The Lua scripts the Scripts tab can browse. The examples are copied in on first start. |
| `ZC95_PORT` | Host port (default `8080`) |
| `ZC95_WEB_PASSWORD` / `ZC95_WEB_USER` | Optional login. Leave the password blank for no login. |

Put the settings in a `.env` file next to `docker-compose.yml`, for example:

```
ZC95_PORT=8080
ZC95_WEB_PASSWORD=choose-a-password
```

To add scripts, use **Add file...** on the Scripts tab, or copy them into the volume:

```
docker cp my_script.lua zc95-web:/scripts/
```

To use a host folder for scripts instead of the volume, change the `/scripts` line in
`docker-compose.yml` to e.g. `./scripts:/scripts`. The container runs as uid 1000, so the folder must be
writable by it (`chown -R 1000:1000 scripts`).

### Day-to-day

```
docker compose logs -f              # live log
docker compose restart              # restart
docker compose down                 # stop; any running pattern is stopped first
docker compose up -d --build        # after updating the files
```

### Docker on Rocky Linux

```
dnf -y install dnf-plugins-core
dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker
firewall-cmd --permanent --add-port=8080/tcp && firewall-cmd --reload
```

## Setting it up on a Linux server (port 8080)

The installer reads `/etc/os-release` to work out which Linux it's on, then installs the prerequisites
with that system's package manager:

| Distro | Package manager | Python it installs |
|---|---|---|
| Rocky, AlmaLinux, RHEL, Oracle Linux, CentOS Stream 8+ | `dnf` | `python3.12`, else `python3.11`, else `python3` |
| Fedora | `dnf` | `python3` |
| Debian 11+, Ubuntu 22.04+, Raspberry Pi OS, Mint | `apt` | `python3` + `python3-venv` |
| openSUSE Leap / Tumbleweed, SLES | `zypper` | `python312`, else `python311`, else `python3` |
| Arch, Manjaro | `pacman` | `python` |

It also installs `rsync` and `git`. It needs systemd, which Proxmox LXC containers have. It stops with a
clear message on systems it can't handle, such as CentOS 7 or Alpine, or where only Python older than 3.9
is available, such as Ubuntu 20.04.

To see what it detects and would install, without changing anything:

```
bash /root/zc95_web/deploy/install.sh --check
```

The server must be able to reach the ZC95's IP on port 80, so it needs to be on the same network.

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

- installs Python 3.9+, `rsync` and `git` for your distro (see the table above). On Rocky it prefers
  `python3.12`, because the stock `python3` is too old on Rocky 8 (3.6).
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
