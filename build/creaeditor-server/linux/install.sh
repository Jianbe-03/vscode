#!/usr/bin/env sh
#---------------------------------------------------------------------------------------------
# CreaEditor Server for Linux: installs the server from an extracted tarball and runs it as a
# systemd service (an alternative to Docker).
#
#   install/linux/install.sh [--host <address>] [--port <port>] [--data-dir <folder>]
#
# As root: installs into /opt/creaeditor-server and runs a system service as the user
#          `creaeditor` (home and data in /var/lib/creaeditor-server).
# As a user: installs into ~/.local/lib/creaeditor-server and runs a user service (data in
#          ~/.creaeditor-server). Run `loginctl enable-linger $USER` once so it keeps running
#          after you log out.
# --host: default this machine's Tailscale address when Tailscale runs, else 127.0.0.1.
# Remove with install/linux/uninstall.sh.
#---------------------------------------------------------------------------------------------
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${CREAEDITOR_SERVER_SOURCE:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
PORT=31600
HOST=""
DATA_DIR=""

while [ $# -gt 0 ]; do
	case "$1" in
		--host) HOST="$2"; shift ;;
		--port) PORT="$2"; shift ;;
		--data-dir) DATA_DIR="$2"; shift ;;
		*) echo "Unknown argument: $1" >&2; exit 1 ;;
	esac
	shift
done

if [ "$(uname -s)" != "Linux" ]; then
	echo "This installer is for Linux. On macOS use install/macos/install.sh." >&2
	exit 1
fi
if [ ! -x "$SRC/bin/creaeditor-server" ] || [ ! -x "$SRC/node" ]; then
	echo "No CreaEditor Server found in $SRC (run this from the extracted tarball)." >&2
	exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
	echo "systemd was not found. Run the server with Docker instead, or start it yourself: $SRC/bin/creaeditor-server serve" >&2
	exit 1
fi

if [ -z "$HOST" ]; then
	if command -v tailscale >/dev/null 2>&1; then
		HOST="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
	fi
	HOST="${HOST:-127.0.0.1}"
fi

if [ "$(id -u)" -eq 0 ]; then
	DEST=/opt/creaeditor-server
	SERVICE_HOME=/var/lib/creaeditor-server
	DATA_DIR="${DATA_DIR:-$SERVICE_HOME/data}"
	UNIT=/etc/systemd/system/creaeditor-server.service
	if ! id creaeditor >/dev/null 2>&1; then
		useradd --system --create-home --home-dir "$SERVICE_HOME" --shell /usr/sbin/nologin creaeditor
	fi
	USER_LINE="User=creaeditor"
	WANTED_BY=multi-user.target
	SYSTEMCTL="systemctl"
	BIN_DIR=/usr/local/bin
else
	DEST="$HOME/.local/lib/creaeditor-server"
	SERVICE_HOME="$HOME"
	DATA_DIR="${DATA_DIR:-$HOME/.creaeditor-server}"
	UNIT="$HOME/.config/systemd/user/creaeditor-server.service"
	USER_LINE=""
	WANTED_BY=default.target
	SYSTEMCTL="systemctl --user"
	BIN_DIR="$HOME/.local/bin"
fi

echo "Installing CreaEditor Server into $DEST"
$SYSTEMCTL stop creaeditor-server >/dev/null 2>&1 || true
rm -rf "$DEST.new"
mkdir -p "$DEST.new"
cp -R "$SRC/." "$DEST.new/"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
mkdir -p "$BIN_DIR"
ln -sf "$DEST/bin/creaeditor-server" "$BIN_DIR/creaeditor-server"

mkdir -p "$DATA_DIR" "$(dirname "$UNIT")"
chmod 700 "$DATA_DIR"
if [ "$(id -u)" -eq 0 ]; then
	chown -R creaeditor: "$SERVICE_HOME" "$DATA_DIR"
fi

escape() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }
sed \
	-e "s|@@ROOT@@|$(escape "$DEST")|g" \
	-e "s|@@DATA_DIR@@|$(escape "$DATA_DIR")|g" \
	-e "s|@@HOME@@|$(escape "$SERVICE_HOME")|g" \
	-e "s|@@HOST@@|$(escape "$HOST")|g" \
	-e "s|@@PORT@@|$(escape "$PORT")|g" \
	-e "s|@@USER_LINE@@|$(escape "$USER_LINE")|g" \
	-e "s|@@WANTED_BY@@|$(escape "$WANTED_BY")|g" \
	"$SCRIPT_DIR/creaeditor-server.service" > "$UNIT"

$SYSTEMCTL daemon-reload
$SYSTEMCTL enable --now creaeditor-server

echo "Waiting for the server to start..."
i=0
while [ $i -lt 60 ]; do
	if [ -f "$DATA_DIR/pairing.txt" ]; then
		break
	fi
	i=$((i + 1))
	sleep 1
done

RUN_AS=""
if [ "$(id -u)" -eq 0 ]; then
	RUN_AS="runuser -u creaeditor --"
fi
$RUN_AS "$DEST/bin/creaeditor-server" status --data-dir "$DATA_DIR" || {
	echo "The server did not start. See: journalctl $( [ "$(id -u)" -eq 0 ] || echo --user ) -u creaeditor-server" >&2
	exit 1
}
echo
$RUN_AS "$DEST/bin/creaeditor-server" pair --data-dir "$DATA_DIR"
echo "For another code later: $RUN_AS creaeditor-server pair --data-dir \"$DATA_DIR\""
if [ "$(id -u)" -ne 0 ]; then
	echo "To keep the server running after you log out: loginctl enable-linger $USER"
fi
