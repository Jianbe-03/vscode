#!/usr/bin/env sh
#---------------------------------------------------------------------------------------------
# CreaEditor Server installer for macOS (launchd) and Linux (systemd).
#
# From the extracted tarball:
#   ./install.sh [options]
# Or in one line, from where the tarballs are published:
#   curl -fsSL <url>/install.sh | CREAEDITOR_SERVER_DOWNLOAD_URL=<url> sh
#   curl -fsSL <url>/install.sh | CREAEDITOR_SERVER_DOWNLOAD_URL=<url> sh -s -- --host 0.0.0.0
#
# Options are passed to install/macos/install.sh or install/linux/install.sh (--host, --port,
# --data-dir; macOS also --system). The download needs
# <url>/creaeditor-server-<darwin|linux>-<arm64|x64>.tar.gz.
#---------------------------------------------------------------------------------------------
set -eu

case "$(uname -s)" in
	Darwin) OS=darwin; INSTALLER=install/macos/install.sh ;;
	Linux) OS=linux; INSTALLER=install/linux/install.sh ;;
	*) echo "CreaEditor Server runs on macOS and Linux (or in Docker)." >&2; exit 1 ;;
esac
case "$(uname -m)" in
	arm64 | aarch64) ARCH=arm64 ;;
	x86_64 | amd64) ARCH=x64 ;;
	*) echo "Unsupported processor: $(uname -m)" >&2; exit 1 ;;
esac

# Run from an extracted tarball: install that.
SELF_DIR=""
case "$0" in
	*/*) SELF_DIR="$(cd "$(dirname "$0")" && pwd)" ;;
esac
if [ -n "$SELF_DIR" ] && [ -x "$SELF_DIR/bin/creaeditor-server" ] && [ -f "$SELF_DIR/$INSTALLER" ]; then
	CREAEDITOR_SERVER_SOURCE="$SELF_DIR" exec "$SELF_DIR/$INSTALLER" "$@"
fi

# Run through a pipe: download the tarball first.
if [ -z "${CREAEDITOR_SERVER_DOWNLOAD_URL:-}" ]; then
	echo "Set CREAEDITOR_SERVER_DOWNLOAD_URL to where creaeditor-server-$OS-$ARCH.tar.gz is published," >&2
	echo "or run install.sh from the extracted tarball." >&2
	exit 1
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="${CREAEDITOR_SERVER_DOWNLOAD_URL%/}/creaeditor-server-$OS-$ARCH.tar.gz"
echo "Downloading $URL"
curl -fsSL "$URL" -o "$TMP/server.tar.gz"
tar -xzf "$TMP/server.tar.gz" -C "$TMP"
CREAEDITOR_SERVER_SOURCE="$TMP/creaeditor-server" "$TMP/creaeditor-server/$INSTALLER" "$@"
