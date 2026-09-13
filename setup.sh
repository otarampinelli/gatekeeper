#!/usr/bin/env bash
set -euo pipefail

GATEKEEPER_HOME="${GATEKEEPER_HOME:-$HOME/.gatekeeper}"
GATEKEEPER_BIN_DIR="${GATEKEEPER_BIN_DIR:-$HOME/.local/bin}"
GATEKEEPER_REPO="${GATEKEEPER_REPO:-https://github.com/otarampinelli/gatekeeper.git}"

if [ -d "$GATEKEEPER_HOME/.git" ]; then
  git -C "$GATEKEEPER_HOME" pull --ff-only --quiet
  echo "updated $GATEKEEPER_HOME"
else
  git clone --depth 1 --quiet "$GATEKEEPER_REPO" "$GATEKEEPER_HOME"
  echo "installed $GATEKEEPER_HOME"
fi

chmod +x "$GATEKEEPER_HOME/bin/gk.mjs"
mkdir -p "$GATEKEEPER_BIN_DIR"
ln -sf "$GATEKEEPER_HOME/bin/gk.mjs" "$GATEKEEPER_BIN_DIR/gk"
echo "linked $GATEKEEPER_BIN_DIR/gk -> $GATEKEEPER_HOME/bin/gk.mjs"

case ":$PATH:" in
  *":$GATEKEEPER_BIN_DIR:"*) ;;
  *) echo "warning: $GATEKEEPER_BIN_DIR is not on your PATH — add it to your shell profile" ;;
esac

echo "note: if your shell aliases 'gk' to something else (oh-my-zsh's git plugin binds it"
echo "to gitk), either drop that alias or invoke $GATEKEEPER_HOME/bin/gk.mjs directly"
