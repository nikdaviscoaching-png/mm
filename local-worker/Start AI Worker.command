#!/bin/zsh
set -eu
WORKER_DIR="${0:A:h}"
BUNDLED_PYTHON="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
if [[ -x "$BUNDLED_PYTHON" ]]; then
  PYTHON="$BUNDLED_PYTHON"
else
  PYTHON="$(command -v python3 || true)"
fi
if [[ -z "$PYTHON" ]] || ! "$PYTHON" -c 'import numpy, PIL' 2>/dev/null; then
  echo 'This Mac needs Python 3 with Pillow and NumPy. See docs/LOCAL-WORKER.md.'
  read '?Press Return to close.'
  exit 1
fi
exec "$PYTHON" "$WORKER_DIR/bridge.py"
