#!/usr/bin/env bash
# Installs or updates the ZC95 Web Manager.
#
# Works out which Linux it's on from /etc/os-release and installs the prerequisites
# (Python 3.9+, rsync, git) with that system's package manager:
#   Rocky / AlmaLinux / RHEL / Oracle / CentOS Stream 8+, Fedora   dnf
#   Debian 11+, Ubuntu 22.04+, Raspberry Pi OS, Mint               apt
#   openSUSE Leap / Tumbleweed, SLES                               zypper
#   Arch, Manjaro                                                  pacman
# Needs systemd (fine in Proxmox LXC containers).
#
# Run as root from the copied source folder:   bash /root/zc95_web/deploy/install.sh
# See what it would do without changing anything:   bash install.sh --check
# Safe to re-run: it updates the code and restarts the service, and never
# touches /etc/zc95-web/zc95-web.env or /var/lib/zc95-web (settings + scripts).
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/zc95-web
CONF=/etc/zc95-web
DATA=/var/lib/zc95-web
USER_NAME=zc95web
OS_RELEASE="${ZC95_OS_RELEASE:-/etc/os-release}"   # overridable for testing --check
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

fail() { echo "ERROR: $*" >&2; exit 1; }

# Python 3.9 or newer with the venv module, for FastAPI
py_ok() { "$1" -c 'import sys, venv; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; }

# ---------- work out the OS ----------

ID="" ID_LIKE="" VERSION_ID="" PRETTY_NAME=""
if [ -r "$OS_RELEASE" ]; then
  eval "$(grep -E '^(ID|ID_LIKE|VERSION_ID|PRETTY_NAME)=' "$OS_RELEASE")"
fi
MAJOR="${VERSION_ID%%.*}"
IDS=" $ID $ID_LIKE "

case "$IDS" in
  *" fedora "*|*" rhel "*|*" centos "*) FAMILY=rhel ;;
  *" debian "*|*" ubuntu "*)            FAMILY=debian ;;
  *" suse "*|*" opensuse "*|*" sles "*) FAMILY=suse ;;
  *" arch "*)                            FAMILY=arch ;;
  *)
    # No (or unknown) os-release: go by the package manager that's present
    if   command -v dnf     >/dev/null 2>&1; then FAMILY=rhel
    elif command -v apt-get >/dev/null 2>&1; then FAMILY=debian
    elif command -v zypper  >/dev/null 2>&1; then FAMILY=suse
    elif command -v pacman  >/dev/null 2>&1; then FAMILY=arch
    else FAMILY=unknown
    fi ;;
esac

# Python package names to try, newest first. EL8's python3 is 3.6, EL9's is 3.9 and openSUSE
# Leap's is 3.6, so on those prefer the newer versioned packages from the standard repos.
case "$FAMILY" in
  rhel)
    PKG="dnf"
    command -v dnf >/dev/null 2>&1 || PKG="yum"
    BASE_PKGS="rsync git"
    if [ "$ID" = "fedora" ]; then
      PY_PKGS="python3"
    else
      [ -z "$MAJOR" ] || [ "$MAJOR" -ge 8 ] 2>/dev/null || fail "$PRETTY_NAME is too old - version 8 or newer is needed."
      PY_PKGS="python3.12 python3.11 python3"
      BASE_PKGS="$BASE_PKGS policycoreutils"   # restorecon, for SELinux labels
    fi ;;
  debian)
    PKG="apt-get"
    BASE_PKGS="rsync git ca-certificates"
    PY_PKGS="python3+python3-venv" ;;          # "+" = install together
  suse)
    PKG="zypper"
    BASE_PKGS="rsync git"
    PY_PKGS="python312 python311 python3" ;;
  arch)
    PKG="pacman"
    BASE_PKGS="rsync git"
    PY_PKGS="python" ;;
  *)
    fail "Couldn't work out how to install packages on this system (${PRETTY_NAME:-unknown OS}).
Install Python 3.9+ (with venv), rsync and git yourself, then re-run this script."
    ;;
esac

echo "==> System"
echo "    ${PRETTY_NAME:-unknown OS} (id: ${ID:-?}, family: $FAMILY, package manager: $PKG)"
echo "    packages: $BASE_PKGS, plus Python - the first available of: ${PY_PKGS//+/ + }"
if [ ! -d /run/systemd/system ]; then
  [ "$CHECK_ONLY" -eq 1 ] && echo "    WARNING: systemd isn't running here - the service can't be installed"
  [ "$CHECK_ONLY" -eq 1 ] || fail "systemd isn't running on this system, so the service can't be installed."
fi
if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "    (--check: nothing changed)"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || fail "Run as root."

# ---------- install prerequisites ----------

pkg_install() {   # pkg_install <package>... ; returns non-zero if any are unavailable
  case "$PKG" in
    dnf|yum) "$PKG" install -y -q "$@" >/dev/null 2>&1 ;;
    apt-get) apt-get install -y -qq "$@" >/dev/null 2>&1 ;;
    zypper)  zypper --non-interactive --quiet install --no-recommends "$@" >/dev/null 2>&1 ;;
    pacman)  pacman -S --needed --noconfirm "$@" >/dev/null 2>&1 ;;
  esac
}

echo "==> Packages"
case "$PKG" in
  apt-get) export DEBIAN_FRONTEND=noninteractive; apt-get update -qq ;;
  zypper)  zypper --non-interactive --quiet refresh >/dev/null ;;
esac

# shellcheck disable=SC2086
pkg_install $BASE_PKGS || fail "Couldn't install: $BASE_PKGS
(on Arch, run 'pacman -Syu' first; on RHEL, check the system is registered for its repos)"

PY_INSTALLED=""
for pkg in $PY_PKGS; do
  # shellcheck disable=SC2086
  if pkg_install ${pkg//+/ }; then
    PY_INSTALLED="${pkg//+/ }"
    break
  fi
done
[ -n "$PY_INSTALLED" ] || echo "    no Python package could be installed - looking for an existing Python"

PY=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3.9 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && py_ok "$candidate"; then
    PY="$(command -v "$candidate")"
    break
  fi
done
[ -n "$PY" ] || fail "Python 3.9 or newer (with venv) is needed, but none is available on $PRETTY_NAME.
(Ubuntu 20.04 and Debian 10 only ship older versions - upgrade the OS, or install a newer Python yourself.)"
echo "    installed: $BASE_PKGS ${PY_INSTALLED:-}"
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
