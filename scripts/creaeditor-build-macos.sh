#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
# CreaEditor: builds CreaEditor.app and an installable .dmg for macOS.
#
#   scripts/creaeditor-build-macos.sh                # full build (installs dependencies)
#   scripts/creaeditor-build-macos.sh --skip-install # reuse node_modules
#
# Output: dist/CreaEditor-darwin-<arch>.dmg (and the .app in ../VSCode-darwin-<arch>/).
# The app is signed with the self-signed "CreaEditor Local Signing" certificate when the login
# keychain has it (set CREAEDITOR_SIGN_IDENTITY to use another), else ad-hoc. A fixed identity keeps
# keychain "Always Allow" answers across rebuilds. There is no Apple Developer ID: on the Mac that
# built it, it opens normally. On other Macs, right-click > Open the first time, or run:
#   xattr -dr com.apple.quarantine /Applications/CreaEditor.app
#---------------------------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARCH="${CREAEDITOR_ARCH:-$(uname -m)}"
case "$ARCH" in
	arm64) NODE_ARCH=arm64 ;;
	x86_64 | x64) ARCH=x64; NODE_ARCH=x64 ;;
	*) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

SKIP_INSTALL=0
for arg in "$@"; do
	case "$arg" in
		--skip-install) SKIP_INSTALL=1 ;;
		*) echo "Unknown argument: $arg" >&2; exit 1 ;;
	esac
done

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

# 1. The exact Node.js version the build expects (.nvmrc), kept inside the repo so the
#    system Node is never touched.
NODE_VERSION="$(cat .nvmrc)"
NODE_DIR="$ROOT/.build/tools/node-v$NODE_VERSION-darwin-$NODE_ARCH"
if [ ! -x "$NODE_DIR/bin/node" ]; then
	step "Downloading Node.js $NODE_VERSION"
	mkdir -p "$ROOT/.build/tools"
	TARBALL="node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
	(
		cd "$ROOT/.build/tools"
		curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
		curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $TARBALL\$" | shasum -a 256 -c -
		tar xzf "$TARBALL"
		rm "$TARBALL"
	)
fi
export PATH="$NODE_DIR/bin:$PATH"
export VSCODE_ARCH="$ARCH"
# electronjs.org/headers redirects and sometimes times out; use the artifacts host directly.
export npm_config_disturl="https://artifacts.electronjs.org/headers/dist"

if [ "$SKIP_INSTALL" -eq 0 ]; then
	step "Installing dependencies"
	npm ci
fi

# The Copilot Chat extension's postinstall lays out the Copilot SDK (node_modules/@github/copilot/sdk)
# that product packaging needs. Re-run it when an earlier install was interrupted.
if [ ! -f "$ROOT/extensions/copilot/node_modules/@github/copilot/sdk/index.js" ]; then
	step "Preparing the Copilot Chat extension SDK"
	(cd "$ROOT/extensions/copilot" && npx tsx ./script/postinstall.ts)
fi

step "Downloading built-in extensions"
npm run download-builtin-extensions

step "Building CreaEditor ($ARCH)"
npm run gulp "vscode-darwin-$ARCH-min"

BUILD_PARENT="$(dirname "$ROOT")"
APP="$BUILD_PARENT/VSCode-darwin-$ARCH/CreaEditor.app"
if [ ! -d "$APP" ]; then
	echo "Build output not found: $APP" >&2
	exit 1
fi

SIGN_IDENTITY="${CREAEDITOR_SIGN_IDENTITY:-CreaEditor Local Signing}"
if security find-identity -p codesigning | grep -qF "\"$SIGN_IDENTITY\""; then
	step "Signing with \"$SIGN_IDENTITY\""
	codesign --force --deep --sign "$SIGN_IDENTITY" "$APP"
else
	step "Ad-hoc signing (no \"$SIGN_IDENTITY\" certificate in the keychain)"
	codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict "$APP"

step "Creating DMG"
mkdir -p "$ROOT/dist"
DMG="$ROOT/dist/CreaEditor-darwin-$ARCH.dmg"
rm -f "$DMG"

# build/darwin/create-dmg.ts (dmgbuild) needs Python >= 3.10 for the styled drag-to-Applications
# window. Use uv's managed Python if the system one is too old; fall back to a plain DMG.
if command -v uv >/dev/null 2>&1; then
	PY="$(uv python find '>=3.10' 2>/dev/null || true)"
	if [ -z "$PY" ]; then
		uv python install 3.12 >/dev/null 2>&1 || true
		PY="$(uv python find '>=3.10' 2>/dev/null || true)"
	fi
	if [ -n "$PY" ]; then
		PYBIN="$ROOT/.build/tools/python-bin"
		mkdir -p "$PYBIN"
		ln -sf "$PY" "$PYBIN/python3.12"
		export PATH="$PYBIN:$PATH"
	fi
fi

if ! node build/darwin/create-dmg.ts "$BUILD_PARENT" "$ROOT/dist"; then
	echo "Styled DMG creation failed, creating a plain DMG instead." >&2
	STAGING="$(mktemp -d)"
	cp -R "$APP" "$STAGING/"
	ln -s /Applications "$STAGING/Applications"
	hdiutil create -volname "CreaEditor" -srcfolder "$STAGING" -ov -format ULMO "$DMG"
	rm -rf "$STAGING"
fi

step "Done"
echo "App: $APP"
ls -lh "$ROOT"/dist/*.dmg
