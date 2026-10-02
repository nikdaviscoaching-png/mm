#!/bin/bash
# Compiles and runs the app's Metal overlay shaders on the CPU and compares them with the unit-tested Swift reference.
#   tools/msl-shim/run.sh            (from the SpecimenCamera folder; needs swift + clang++ + python3)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/../.."
WORK="${1:-$(mktemp -d)}"; mkdir -p "$WORK"
python3 - "$ROOT/SpecimenCamera/Overlays/OverlayShaders.swift" "$WORK/shader.inc" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'static let source = """\n(.*?)\n    """', src, re.S)
text = m.group(1)
text = text.replace("#include <metal_stdlib>", "").replace("using namespace metal;", "")
open(sys.argv[2], "w").write(text)
PY
CXX="${CXX:-$( [ -x /usr/bin/clang++ ] && echo /usr/bin/clang++ || echo clang++ )}"   # needs clang (vector extensions) with a C++ standard library
"$CXX" -std=c++17 -O2 -w -I"$HERE" -I"$WORK" "$HERE/run.cpp" -o "$WORK/run"
(cd "$ROOT/Packages/SpecimenCore" && swift run -c release specimen-lab msl-dump "$WORK" >/dev/null)
"$WORK/run" "$WORK"
python3 "$HERE/compare.py" "$WORK"
