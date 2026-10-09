#!/usr/bin/env sh
#---------------------------------------------------------------------------------------------
# CreaEditor Server for Linux: stops the systemd service and removes the server.
#
#   install/linux/uninstall.sh [--purge]
#
#   --purge  also deletes the data (chats, accounts, secrets, paired devices)
#---------------------------------------------------------------------------------------------
set -eu

PURGE=0
for arg in "$@"; do
	case "$arg" in
		--purge) PURGE=1 ;;
		*) echo "Unknown argument: $arg" >&2; exit 1 ;;
	esac
done

if [ "$(id -u)" -eq 0 ]; then
	systemctl disable --now creaeditor-server >/dev/null 2>&1 || true
	rm -f /etc/systemd/system/creaeditor-server.service /usr/local/bin/creaeditor-server
	systemctl daemon-reload
	rm -rf /opt/creaeditor-server
	DATA=/var/lib/creaeditor-server
else
	systemctl --user disable --now creaeditor-server >/dev/null 2>&1 || true
	rm -f "$HOME/.config/systemd/user/creaeditor-server.service" "$HOME/.local/bin/creaeditor-server"
	systemctl --user daemon-reload
	rm -rf "$HOME/.local/lib/creaeditor-server"
	DATA="$HOME/.creaeditor-server"
fi

if [ "$PURGE" -eq 1 ]; then
	rm -rf "$DATA"
	if [ "$(id -u)" -eq 0 ] && id creaeditor >/dev/null 2>&1; then
		userdel creaeditor || true
	fi
	echo "CreaEditor Server and its data were removed."
else
	echo "CreaEditor Server was removed. Its data stays in $DATA (use --purge to delete it)."
fi
