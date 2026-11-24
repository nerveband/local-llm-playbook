#!/bin/zsh
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
REPO_DIR="${SCRIPT_DIR:h}"

EXT_DIR="$HOME/.local/share/pi-local-extensions"
mkdir -p "$EXT_DIR" "$HOME/.local/bin"

npm install --prefix "$EXT_DIR" --no-audit --no-fund --legacy-peer-deps pi-handoff pi-subagents pi-hashline-edit@0.8.4

for bin_name in pi-local pi-outline pi-preflight pi-verify-ui; do
  if [[ -f "$REPO_DIR/bin/$bin_name" ]]; then
    chmod +x "$REPO_DIR/bin/$bin_name"
    ln -sf "$REPO_DIR/bin/$bin_name" "$HOME/.local/bin/$bin_name"
  fi
done

if [[ -f "$SCRIPT_DIR/ornith-splash" ]]; then
  chmod +x "$SCRIPT_DIR/ornith-splash"
  cp "$SCRIPT_DIR/ornith-splash" "$HOME/.local/bin/ornith-splash"
  chmod +x "$HOME/.local/bin/ornith-splash"
fi

print "Installed local extensions in $EXT_DIR and linked helpers in $HOME/.local/bin"
