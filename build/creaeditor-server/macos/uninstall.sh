#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
# CreaEditor Server for macOS: stops the launch agent and removes the server.
#
#   install/macos/uninstall.sh [--purge]
#
#   --purge  also deletes ~/.creaeditor-server (chats, accounts, secrets, paired devices) and the logs
#---------------------------------------------------------------------------------------------
set -euo pipefail

LABEL="nl.creacoon.creaeditor-server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PURGE=0
for arg in "$@"; do
	case "$arg" in
		--purge) PURGE=1 ;;
		*) echo "Unknown argument: $arg" >&2; exit 1 ;;
	esac
done

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

for bin_dir in /usr/local/bin "$HOME/.local/bin"; do
	if [ -L "$bin_dir/creaeditor-server" ]; then
		rm -f "$bin_dir/creaeditor-server"
	fi
done

rm -rf "$HOME/Applications/CreaEditor Server"
if [ -d /usr/local/lib/creaeditor-server ]; then
	if [ -w /usr/local/lib ]; then
		rm -rf /usr/local/lib/creaeditor-server
	else
		sudo rm -rf /usr/local/lib/creaeditor-server
	fi
fi

if [ "$PURGE" -eq 1 ]; then
	rm -rf "$HOME/.creaeditor-server" "$HOME/Library/Logs/CreaEditor Server"
	echo "CreaEditor Server and its data were removed."
else
	echo "CreaEditor Server was removed. Its data stays in ~/.creaeditor-server (use --purge to delete it)."
fi
