#!/usr/bin/env python3
"""Reference implementation of the scoring spec (README, "How it works"); a slow, obvious oracle for tests.

    python3 reference.py --data DIR [--shards 0 1 ... --jobs J] [--extra FILE | --no-extra] QUERY [QUERY ...]

Same file layout as the engine: DIR/settings.txt, DIR/shards/shard-NNN.jsonl.gz, extra docs DIR/extra.jsonl if present.

Prints, for every query, a line "## <query>" followed by up to 10 lines "id score".
Fast path: if norm != l2, only the df of the query features is needed, so one streaming pass
over the corpus is enough (L fits in memory). With norm=l2 the full df table is built.
"""
import argparse, gzip, json, math, os, re
from collections import Counter
from multiprocessing import Pool

TOK = re.compile(r"[a-z0-9]+")


def load_settings(path):
    s = {}
    for line in open(path, encoding="utf-8"):
        if "=" in line:
            k, v = line.rstrip("\n").split("=", 1)
            s[k.strip()] = v.strip()
    s["min_token_len"] = int(s.get("min_token_len", "1"))
    s["stop"] = set(w.strip() for w in s.get("stoplist", "").split(",") if w.strip())
    return s


def features(text, S):
    toks = []
    for t in TOK.findall(text.lower()):
        if len(t) < S["min_token_len"] or t in S["stop"]:
            continue
        if S.get("stemming") == "plural_s" and len(t) > 3 and t.endswith("s") and not t.endswith("ss"):
            t = t[:-1]
        toks.append(t)
    return Counter(toks + [a + "_" + b for a, b in zip(toks, toks[1:])])


def tf(c, maxc, S):
    return {"raw": c, "log": 1 + math.log(c), "aug": 0.5 + 0.5 * c / maxc}[S["tf"]]


def idf(df, N, S):
    return {"plain": lambda: math.log(N / df),
            "smooth": lambda: math.log((1 + N) / (1 + df)) + 1,
            "bm25": lambda: math.log(1 + (N - df + 0.5) / (df + 0.5))}[S["idf"]]()


def docs_of(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                d = json.loads(line)
                yield d["id"], d["text"]


def scan(args):
    """One file: N, df restricted to `want` (None = all), and per-doc counts of wanted features."""
    path, S, want = args
    n, df, hits = 0, Counter(), []
    for did, text in docs_of(path):
        n += 1
        f = features(text, S)
        keys = f.keys() if want is None else (want & f.keys())
        df.update(keys)
        if want is not None and keys:
            hits.append((did, max(f.values()), {k: f[k] for k in keys}))
        elif want is None:
            hits.append((did, max(f.values()) if f else 0, dict(f)))
    return n, df, hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--shards", type=int, nargs="*", default=[])
    ap.add_argument("--settings", default=None)
    ap.add_argument("--shard-pattern", default="shards/shard-%03d.jsonl.gz")
    ap.add_argument("--extra", default=None)
    ap.add_argument("--no-extra", action="store_true")
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("queries", nargs="+")
    a = ap.parse_args()
    S = load_settings(a.settings or os.path.join(a.data, "settings.txt"))
    files = [os.path.join(a.data, a.shard_pattern % s) for s in a.shards]
    extra = a.extra or os.path.join(a.data, "extra.jsonl")
    if not a.no_extra and (a.extra or os.path.exists(extra)):
        files.append(extra)
    qf = [features(q, S) for q in a.queries]
    full = S.get("norm") == "l2"
    want = None if full else set().union(*[set(q) for q in qf])
    with Pool(a.jobs) as p:
        parts = p.map(scan, [(f, S, want) for f in files]) if a.jobs > 1 else list(map(scan, [(f, S, want) for f in files]))
    N = sum(p[0] for p in parts)
    df = Counter()
    for p in parts:
        df.update(p[1])
    docs = [h for p in parts for h in p[2]]
    norms = {}
    if full:
        for did, maxc, f in docs:
            norms[did] = math.sqrt(sum((tf(c, maxc, S) * idf(df[k], N, S)) ** 2 for k, c in f.items()))
    for q, f in zip(a.queries, qf):
        qv = {k: c * idf(df[k], N, S) for k, c in f.items() if df.get(k, 0) > 0}
        qn = math.sqrt(sum(v * v for v in qv.values()))
        res = []
        if qn > 0:
            for did, maxc, dfe in docs:
                sc = 0.0
                for k, v in qv.items():
                    if k in dfe:
                        w = tf(dfe[k], maxc, S) * idf(df[k], N, S)
                        if full:
                            w = w / norms[did] if norms[did] > 0 else 0.0
                        sc += (v / qn) * w
                if sc > 0:
                    res.append((did, sc))
        res.sort(key=lambda x: x[0])
        res.sort(key=lambda x: -x[1])
        print("## " + q)
        for did, sc in res[:10]:
            print(f"{did} {sc:.12g}")


if __name__ == "__main__":
    main()
