#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
# CreaEditor: builds the CreaEditor Server (headless agent host + web Agents window) as a tarball.
#
#   scripts/creaeditor-build-server.sh [target] [--skip-install] [--skip-web] [--dry-run]
#
#   target: darwin-arm64 (default on an Apple silicon Mac), darwin-x64, linux-x64, linux-arm64
#
# Output: dist/creaeditor-server-<os>-<arch>.tar.gz with one folder, creaeditor-server/:
#   bin/creaeditor-server     the command (serve, pair, status)
#   node                      the Node.js runtime the server was built for
#   out/                      the bundled server and agent host (build/next, target "server")
#   node_modules/             production dependencies with native modules for the target
#   web/                      the web Agents window (build/next, target "web"), when built
#   agent-sdks/<id>/          the Claude and Codex agent SDKs for the target
#   install/                  macOS (launchd) and Linux (systemd) installers
#
# The server reuses the standard remote server packaging (gulp `vscode-reh-<os>-<arch>-min`). Native
# modules are compiled for the machine that builds, so build each OS on that OS: the Linux tarballs on
# Linux (or in Docker, see build/creaeditor-server/README.md), the macOS one on a Mac. The architecture
# can differ only where the toolchain can cross-compile (npm_config_arch); building on the target is safest.
#---------------------------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

host_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
host_arch="$(uname -m)"
case "$host_arch" in
	arm64 | aarch64) host_arch=arm64 ;;
	x86_64 | amd64) host_arch=x64 ;;
esac

TARGET="$host_os-$host_arch"
SKIP_INSTALL=0
SKIP_WEB=0
DRY_RUN=0
for arg in "$@"; do
	case "$arg" in
		--skip-install) SKIP_INSTALL=1 ;;
		--skip-web) SKIP_WEB=1 ;;
		--dry-run) DRY_RUN=1 ;;
		darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64) TARGET="$arg" ;;
		*) echo "Unknown argument: $arg" >&2; exit 1 ;;
	esac
done
OS="${TARGET%-*}"
ARCH="${TARGET#*-}"

if [ "$OS" != "$host_os" ]; then
	echo "Building $TARGET on $host_os is not supported: native modules are compiled for the building OS." >&2
	echo "Build Linux tarballs on Linux or in Docker (see build/creaeditor-server/README.md)." >&2
	exit 1
fi

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
run() {
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '  [dry run] %s\n' "$*"
	else
		"$@"
	fi
}

# 1. The Node.js version the build expects (.nvmrc), kept inside the repo.
NODE_VERSION="$(cat .nvmrc)"
NODE_DIR="$ROOT/.build/tools/node-v$NODE_VERSION-$host_os-$host_arch"
if [ ! -x "$NODE_DIR/bin/node" ]; then
	step "Downloading Node.js $NODE_VERSION"
	TARBALL="node-v$NODE_VERSION-$host_os-$host_arch.tar.gz"
	run mkdir -p "$ROOT/.build/tools"
	if [ "$DRY_RUN" -eq 0 ]; then
		(
			cd "$ROOT/.build/tools"
			curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
			curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $TARBALL\$" | shasum -a 256 -c -
			tar xzf "$TARBALL"
			rm "$TARBALL"
		)
	fi
fi
export PATH="$NODE_DIR/bin:$PATH"
export VSCODE_ARCH="$ARCH"
export npm_config_arch="$ARCH"
unset ELECTRON_RUN_AS_NODE

if [ "$SKIP_INSTALL" -eq 0 ]; then
	step "Installing dependencies"
	run npm ci
fi

# 2. The server and agent host, bundled and packaged like the VS Code remote server.
step "Building the server ($TARGET)"
run npm run gulp "vscode-reh-$OS-$ARCH-min"
REH="$(dirname "$ROOT")/vscode-reh-$OS-$ARCH"

STAGE="$ROOT/.build/creaeditor-server/$TARGET/creaeditor-server"
step "Assembling $STAGE"
run rm -rf "$(dirname "$STAGE")"
run mkdir -p "$(dirname "$STAGE")"
run cp -R "$REH" "$STAGE"
# The server runs no extension host: leave the extensions out.
run rm -rf "$STAGE/extensions"
if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$STAGE/out/vs/server/node/creaeditorServer/creaeditorServerMain.js" ]; then
	echo "The server bundle has no creaeditorServerMain.js; is it in serverEntryPoints of build/next/index.ts?" >&2
	exit 1
fi

# 3. The web Agents window, served by the server's remote access page.
if [ "$SKIP_WEB" -eq 0 ]; then
	step "Building the web Agents window"
	run npx tsx build/next/index.ts bundle --minify --nls --target web --out out-creaeditor-server-web
	run cp -R "$ROOT/out-creaeditor-server-web" "$STAGE/web"
fi

# 4. The Claude and Codex SDKs for the target, laid out as agentSdkDownloader.ts expects them
#    (<appRoot>/agent-sdks/<id>/node_modules). npm installs the target's platform package.
step "Bundling the Claude and Codex agent SDKs for $TARGET"
sdk_version() { node -p "require('$ROOT/node_modules/$1/package.json').version"; }
for entry in "claude:@anthropic-ai/claude-agent-sdk" "codex:@openai/codex"; do
	id="${entry%%:*}"
	pkg="${entry#*:}"
	version="$(sdk_version "$pkg")"
	run mkdir -p "$STAGE/agent-sdks/$id"
	run npm install --prefix "$STAGE/agent-sdks/$id" --no-save --no-package-lock --omit=dev --os="$OS" --cpu="$ARCH" "$pkg@$version"
done

# 5. The command and the installers.
step "Adding the command and installers"
run mkdir -p "$STAGE/bin" "$STAGE/install"
run cp "$ROOT/build/creaeditor-server/bin/creaeditor-server" "$STAGE/bin/creaeditor-server"
run chmod +x "$STAGE/bin/creaeditor-server"
run cp -R "$ROOT/build/creaeditor-server/macos" "$STAGE/install/macos"
run cp -R "$ROOT/build/creaeditor-server/linux" "$STAGE/install/linux"
run cp "$ROOT/build/creaeditor-server/install.sh" "$STAGE/install.sh"

# 6. The tarball.
step "Packing"
run mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/creaeditor-server-$TARGET.tar.gz"
run tar -C "$(dirname "$STAGE")" -czf "$OUT" creaeditor-server
step "Done"
echo "$OUT"
