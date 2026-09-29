#!/usr/bin/env sh
# Installs the promptreduce binary for macOS or Linux from the latest GitHub release.
#   curl -fsSL https://raw.githubusercontent.com/OWNER/promptreduce/main/install.sh | sh
# Set PROMPTREDUCE_REPO to install from a fork, PROMPTREDUCE_DIR to change the target directory.
set -eu
REPO="${PROMPTREDUCE_REPO:-OWNER/promptreduce}"
DIR="${PROMPTREDUCE_DIR:-$HOME/.local/bin}"
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64) ASSET=promptreduce-macos-arm64 ;;
  Darwin-x86_64) ASSET=promptreduce-macos-x64 ;;
  Linux-x86_64) ASSET=promptreduce-linux-x64 ;;
  *) echo "no prebuilt binary for $OS $ARCH; build from source with bun run build" >&2; exit 1 ;;
esac
URL="https://github.com/$REPO/releases/latest/download/$ASSET"
mkdir -p "$DIR"
echo "downloading $URL"
curl -fsSL "$URL" -o "$DIR/promptreduce"
chmod +x "$DIR/promptreduce"
[ "$OS" = Darwin ] && xattr -d com.apple.quarantine "$DIR/promptreduce" 2>/dev/null || true
echo "installed $DIR/promptreduce"
case ":$PATH:" in *":$DIR:"*) ;; *) echo "add $DIR to your PATH, for example: export PATH=\"$DIR:\$PATH\"" ;; esac
echo "next: promptreduce analyze    (your cost shape)"
echo "      promptreduce setup --all (point Claude Code at the proxy and start it at login)"
