#!/usr/bin/env python3
"""compare.py ENGINE_OUT REF_OUT : both files contain blocks "## query" + "id score" lines. 1e-6 relative tolerance."""
import sys
def blocks(path):
    out, cur = {}, None
    for line in open(path):
        line = line.rstrip("\n")
        if line.startswith("## "): cur = line[3:]; out[cur] = []
        elif line.strip() and cur is not None:
            i, s = line.split(); out[cur].append((i, float(s)))
    return out
E, R = blocks(sys.argv[1]), blocks(sys.argv[2])
bad = 0
for q in R:
    e, r = E.get(q), R[q]
    if e is None: print("MISSING", q); bad += 1; continue
    ok = len(e) == len(r)
    for (ei, es), (ri, rs) in zip(e, r):
        if abs(es - rs) > 1e-6 * max(abs(rs), 1e-300): ok = False
        if ei != ri and abs(es - rs) > 1e-6 * abs(rs): ok = False
        if ei != ri:  # allowed only inside an exact-score tie group
            if not any(i == ei and abs(s - es) <= 1e-6 * abs(s) for i, s in r): ok = False
    if not ok:
        bad += 1; print("DIFF", repr(q)); print("  engine", e); print("  ref   ", r)
print(f"{len(R) - bad}/{len(R)} queries match"); sys.exit(1 if bad else 0)
