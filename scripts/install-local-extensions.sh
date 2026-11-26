#!/bin/zsh
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
REPO_DIR="${SCRIPT_DIR:h}"

EXT_DIR="$HOME/.local/share/pi-local-extensions"
mkdir -p "$EXT_DIR" "$HOME/.local/bin"

npm install --prefix "$EXT_DIR" --no-audit --no-fund --legacy-peer-deps pi-handoff pi-subagents pi-hashline-edit@0.9.0 pi-code-tool@0.6.2 pi-better-edit@2.21.0 happy-dom

for bin_name in pi-local pi-outline pi-preflight pi-verify-ui; do
  if [[ -f "$REPO_DIR/bin/$bin_name" ]]; then
    chmod +x "$REPO_DIR/bin/$bin_name"
    ln -sf "$REPO_DIR/bin/$bin_name" "$HOME/.local/bin/$bin_name"
  fi
done

for helper_script in ornith-splash surogate-splash inkling-omlx; do
  if [[ -f "$SCRIPT_DIR/$helper_script" ]]; then
    chmod +x "$SCRIPT_DIR/$helper_script"
    cp "$SCRIPT_DIR/$helper_script" "$HOME/.local/bin/$helper_script"
    chmod +x "$HOME/.local/bin/$helper_script"
  fi
done

print "Installed local extensions in $EXT_DIR and linked helpers in $HOME/.local/bin"
