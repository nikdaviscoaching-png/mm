import struct, sys
d = sys.argv[1]
def rd(n): return open(f"{d}/{n}", "rb").read()
W, H = struct.unpack("ii", rd("frame.bin")[:8])
ok = True
def cmp_ridge(ref, gpu, name):
    global ok
    r, g = rd(ref), rd(gpu)
    n = W * H; flag_diff = 0; ang_diff = 0; marked = 0
    for i in range(n):
        rf, ra = r[2 * i], r[2 * i + 1]; gf, ga = g[2 * i], g[2 * i + 1]
        if rf: marked += 1
        if rf != gf: flag_diff += 1
        elif rf and abs(ra - ga) > 1 and min(abs(ra - ga), 255 - abs(ra - ga)) > 1: ang_diff += 1
    frac = flag_diff / max(marked, 1)
    print(f"{name}: reference marks {marked}, flag mismatches {flag_diff} ({100*frac:.3f}% of marks), angle mismatches {ang_diff}")
    if frac > 0.002 or ang_diff > 0.002 * marked: ok = False
cmp_ridge("ref_cand.bin", "gpu_cand.bin", "candidates")
cmp_ridge("ref_ridge.bin", "gpu_ridge.bin", "ridges   ")
ref = struct.unpack(f"{len(rd('ref_view.bin'))//4}f", rd("ref_view.bin")); gpu = struct.unpack(f"{len(rd('gpu_view.bin'))//4}f", rd("gpu_view.bin"))
diffs = [abs(a - b) for a, b in zip(ref, gpu)]
print(f"rendered view: {len(ref)} px, max abs diff {max(diffs):.3f}, mean abs diff {sum(diffs)/len(diffs):.5f}, covered px ref {sum(1 for a in ref if a>0.5)} gpu {sum(1 for a in gpu if a>0.5)}")
if max(diffs) > 0.08 or sum(diffs) / len(diffs) > 0.002: ok = False
print("MATCH" if ok else "MISMATCH")
sys.exit(0 if ok else 1)
