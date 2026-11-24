#!/bin/zsh
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
REPO_DIR="${SCRIPT_DIR:h}"

EXT_DIR="$HOME/.local/share/pi-local-extensions"
mkdir -p "$EXT_DIR" "$HOME/.local/bin"

npm install --prefix "$EXT_DIR" --no-audit --no-fund pi-handoff pi-subagents

chmod +x "$REPO_DIR/bin/pi-local"
ln -sf "$REPO_DIR/bin/pi-local" "$HOME/.local/bin/pi-local"

print "Installed local extensions in $EXT_DIR"
print "Linked $HOME/.local/bin/pi-local -> $REPO_DIR/bin/pi-local"
