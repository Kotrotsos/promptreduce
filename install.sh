#!/usr/bin/env sh
# Installs the promptreduce binary for macOS or Linux.
#   From a checkout:   sh install.sh            (uses dist/, builds it first with bun if missing)
#   From the internet: curl -fsSL https://raw.githubusercontent.com/Kotrotsos/promptreduce/main/install.sh | sh
# PROMPTREDUCE_REPO=owner/repo installs a fork's release; PROMPTREDUCE_DIR changes the target directory.
set -eu
REPO="${PROMPTREDUCE_REPO:-Kotrotsos/promptreduce}"
DIR="${PROMPTREDUCE_DIR:-$HOME/.local/bin}"
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64) ASSET=promptreduce-macos-arm64 ;;
  Darwin-x86_64) ASSET=promptreduce-macos-x64 ;;
  Linux-x86_64) ASSET=promptreduce-linux-x64 ;;
  *) echo "no prebuilt binary for $OS $ARCH; build from source with bun run build" >&2; exit 1 ;;
esac
mkdir -p "$DIR"
HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/package.json" ] && grep -q '"name": "promptreduce"' "$HERE/package.json"; then
  # Running inside a checkout: install the local build.
  if [ ! -f "$HERE/dist/$ASSET" ]; then
    command -v bun >/dev/null 2>&1 || { echo "no dist/$ASSET and bun is not installed; install bun or download a release" >&2; exit 1; }
    echo "building $ASSET"
    (cd "$HERE" && bun build --compile --minify --target="bun-$(echo "$ASSET" | sed 's/promptreduce-//; s/macos/darwin/')" src/cli.ts --outfile "dist/$ASSET" >/dev/null)
  fi
  cp "$HERE/dist/$ASSET" "$DIR/promptreduce"
  echo "installed $DIR/promptreduce from $HERE/dist/$ASSET"
else
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
  echo "downloading $URL"
  curl -fsSL "$URL" -o "$DIR/promptreduce"
  echo "installed $DIR/promptreduce"
fi
chmod +x "$DIR/promptreduce"
[ "$OS" = Darwin ] && xattr -d com.apple.quarantine "$DIR/promptreduce" 2>/dev/null || true
case ":$PATH:" in *":$DIR:"*) ;; *) echo "add $DIR to your PATH, for example: export PATH=\"$DIR:\$PATH\"" ;; esac
echo "next: promptreduce analyze     (your cost shape)"
echo "      promptreduce setup --all  (point Claude Code at the proxy and start it at login)"
