#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
# CreaEditor Server for macOS: installs the server from an extracted tarball and runs it as a
# launch agent (starts at login, restarts when it stops).
#
#   install/macos/install.sh [--system] [--host <address>] [--port <port>] [--data-dir <folder>]
#
#   (default)  installs into ~/Applications/CreaEditor Server
#   --system   installs into /usr/local/lib/creaeditor-server (asks for your password)
#   --host     address to listen on; default: this Mac's Tailscale address when Tailscale runs,
#              else 127.0.0.1 (only this Mac)
#
# Data: ~/.creaeditor-server (chats, accounts, secrets, paired devices). Logs:
# ~/Library/Logs/CreaEditor Server/server.log. Remove with install/macos/uninstall.sh.
#---------------------------------------------------------------------------------------------
set -euo pipefail

LABEL="nl.creacoon.creaeditor-server"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${CREAEDITOR_SERVER_SOURCE:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
DEST="$HOME/Applications/CreaEditor Server"
DATA_DIR="$HOME/.creaeditor-server"
LOG_DIR="$HOME/Library/Logs/CreaEditor Server"
PORT=31600
HOST=""
SYSTEM=0

while [ $# -gt 0 ]; do
	case "$1" in
		--system) SYSTEM=1; DEST="/usr/local/lib/creaeditor-server" ;;
		--host) HOST="$2"; shift ;;
		--port) PORT="$2"; shift ;;
		--data-dir) DATA_DIR="$2"; shift ;;
		*) echo "Unknown argument: $1" >&2; exit 1 ;;
	esac
	shift
done

if [ "$(uname -s)" != "Darwin" ]; then
	echo "This installer is for macOS. On Linux use install/linux/install.sh or Docker." >&2
	exit 1
fi
if [ ! -x "$SRC/bin/creaeditor-server" ] || [ ! -x "$SRC/node" ]; then
	echo "No CreaEditor Server found in $SRC (run this from the extracted tarball)." >&2
	exit 1
fi

if [ -z "$HOST" ]; then
	TAILSCALE=""
	for candidate in tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
		if command -v "$candidate" >/dev/null 2>&1; then TAILSCALE="$candidate"; break; fi
	done
	if [ -n "$TAILSCALE" ]; then
		HOST="$("$TAILSCALE" ip -4 2>/dev/null | head -n 1 || true)"
	fi
	HOST="${HOST:-127.0.0.1}"
fi

echo "Installing CreaEditor Server into $DEST"
SUDO=""
if [ "$SYSTEM" -eq 1 ] && [ ! -w "$(dirname "$DEST")" ]; then
	SUDO="sudo"
fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
# Stop a running server before its files are replaced.
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

if [ "$SRC" != "$DEST" ]; then
	$SUDO mkdir -p "$DEST"
	$SUDO rsync -a --delete "$SRC/" "$DEST/"
fi
# Downloaded tarballs are quarantined; the server is not notarized.
$SUDO xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# The command on the PATH.
for bin_dir in /usr/local/bin "$HOME/.local/bin"; do
	if [ -d "$bin_dir" ] && [ -w "$bin_dir" ]; then
		ln -sf "$DEST/bin/creaeditor-server" "$bin_dir/creaeditor-server"
		echo "Command: $bin_dir/creaeditor-server"
		break
	fi
done

mkdir -p "$DATA_DIR" "$LOG_DIR" "$(dirname "$PLIST")"
chmod 700 "$DATA_DIR"

# XML-escape a value, then escape it for the sed replacement below.
escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' | sed -e 's/[\\|&]/\\&/g'; }
sed \
	-e "s|@@ROOT@@|$(escape "$DEST")|g" \
	-e "s|@@DATA_DIR@@|$(escape "$DATA_DIR")|g" \
	-e "s|@@LOG_DIR@@|$(escape "$LOG_DIR")|g" \
	-e "s|@@HOST@@|$(escape "$HOST")|g" \
	-e "s|@@PORT@@|$(escape "$PORT")|g" \
	"$SCRIPT_DIR/$LABEL.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

echo "Waiting for the server to start..."
for _ in $(seq 1 60); do
	if [ -f "$DATA_DIR/pairing.txt" ] && "$DEST/bin/creaeditor-server" status --data-dir "$DATA_DIR" >/dev/null 2>&1; then
		break
	fi
	sleep 1
done

"$DEST/bin/creaeditor-server" status --data-dir "$DATA_DIR" || {
	echo "The server did not start. See $LOG_DIR/server.log" >&2
	exit 1
}
echo
"$DEST/bin/creaeditor-server" pair --data-dir "$DATA_DIR"
echo "For another code later: creaeditor-server pair --data-dir \"$DATA_DIR\""
echo "Logs: $LOG_DIR/server.log"
