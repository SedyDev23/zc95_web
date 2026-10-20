#!/usr/bin/env bash
# Installs or updates the ZC95 Web Manager.
# Supports Rocky / AlmaLinux / RHEL 8+ (dnf) and Debian / Ubuntu (apt), including LXC containers.
# Run as root from the copied source folder:   bash /root/zc95_web/deploy/install.sh
# Safe to re-run: it updates the code and restarts the service, and never
# touches /etc/zc95-web/zc95-web.env or /var/lib/zc95-web (settings + scripts).
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/zc95-web
CONF=/etc/zc95-web
DATA=/var/lib/zc95-web
USER_NAME=zc95web

[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }

# Python 3.9 or newer, for FastAPI
py_ok() { "$1" -c 'import sys, venv; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; }

echo "==> Packages"
if command -v dnf >/dev/null 2>&1; then
  # Rocky / Alma / RHEL: the default python3 is 3.6 (EL8) or 3.9 (EL9), so prefer a newer
  # AppStream build when there is one. On EL these include venv, so there's no -venv package.
  dnf install -y -q rsync >/dev/null
  dnf install -y -q python3.12 >/dev/null 2>&1 || dnf install -y -q python3.11 >/dev/null 2>&1 || dnf install -y -q python3 >/dev/null
elif command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq python3 python3-venv rsync >/dev/null
else
  echo "Unsupported system: needs dnf (Rocky/Alma/RHEL) or apt (Debian/Ubuntu)."
  exit 1
fi

PY=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && py_ok "$candidate"; then
    PY="$(command -v "$candidate")"
    break
  fi
done
[ -n "$PY" ] || { echo "Python 3.9 or newer with venv is required, but none was found."; exit 1; }
echo "    using $("$PY" --version) ($PY)"

echo "==> User and folders"
NOLOGIN="$(command -v nologin || echo /sbin/nologin)"
id "$USER_NAME" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell "$NOLOGIN" "$USER_NAME"
install -d -m 0755 "$APP" "$CONF"
install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$DATA" "$DATA/scripts"

if [ ! -f "$CONF/zc95-web.env" ]; then
  install -m 0640 -g "$USER_NAME" "$SRC/deploy/zc95-web.env" "$CONF/zc95-web.env"
  echo "    created $CONF/zc95-web.env"
fi

# First install only: seed the scripts folder with the example Lua scripts
if [ -z "$(ls -A "$DATA/scripts")" ] && [ -d "$SRC/scripts" ]; then
  cp -r "$SRC/scripts/." "$DATA/scripts/"
  chown -R "$USER_NAME:$USER_NAME" "$DATA/scripts"
  echo "    copied example scripts to $DATA/scripts"
fi

echo "==> Code -> $APP"
rsync -a --delete --exclude venv --exclude data --exclude scripts --exclude __pycache__ "$SRC"/ "$APP"/
# (Re)build the virtualenv if it's missing or was made with a Python that's too old
if [ -d "$APP/venv" ] && ! py_ok "$APP/venv/bin/python"; then
  echo "    rebuilding virtualenv"
  rm -rf /opt/zc95-web/venv
fi
if [ ! -x "$APP/venv/bin/python" ]; then
  "$PY" -m venv "$APP/venv"
fi
"$APP/venv/bin/python" -m pip install --quiet --upgrade pip
"$APP/venv/bin/python" -m pip install --quiet -r "$APP/requirements.txt"
chown -R root:root "$APP"
chmod -R go-w "$APP"

install -m 0644 "$APP/deploy/zc95-web.service" /etc/systemd/system/zc95-web.service

# SELinux (Rocky/RHEL): give the copied files their default labels
if command -v restorecon >/dev/null 2>&1; then
  restorecon -R "$APP" "$CONF" "$DATA" /etc/systemd/system/zc95-web.service || true
fi

echo "==> Service"
systemctl daemon-reload
systemctl enable zc95-web >/dev/null 2>&1
systemctl restart zc95-web
sleep 2
systemctl --no-pager --lines=0 status zc95-web | head -n 3 || true

PORT="$(sed -n 's/^ZC95_WEB_PORT=\([0-9]*\).*/\1/p' "$CONF/zc95-web.env")"
PORT="${PORT:-8080}"
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --quiet --permanent --add-port="$PORT/tcp" && firewall-cmd --quiet --reload \
    && echo "    opened port $PORT in firewalld"
elif command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null && echo "    opened port $PORT in ufw"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
echo
echo "ZC95 Web Manager is running: http://${IP:-<server-ip>}:${PORT}/"
echo "Scripts folder: $DATA/scripts   Settings: $CONF/zc95-web.env"
echo "Logs: journalctl -u zc95-web -f"
