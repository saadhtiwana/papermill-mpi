#!/usr/bin/env python3
"""Deterministic synthetic corpus for tests and demos.

    python3 tests/gen_corpus.py OUTDIR [--shards K] [--docs N] [--sentinels M] [--seed S]

Writes OUTDIR/shards/shard-000.jsonl.gz ... (Zipf-distributed pseudo-words with plurals, 'ss' endings, digits,
short words, stopwords, non-ASCII and JSON escapes), OUTDIR/extra.jsonl (sentinel documents built from a few
made-up words, full of exact score ties) and OUTDIR/queries.txt (queries over that vocabulary).
"""
import argparse, gzip, json, os, random

STOP = "a an and are as at be by for from in is it of on or that the this to was we with which".split()
ODD = ["café", "naïve", "Kelvin", "İstanbul", "x86-64", "data2vec", "3D-printing", "model's",
       "class", "glass", "process", "lens", "bus", "gas", "uses", "papers", "\"quoted\"", "back\\slash"]


def vocab(rng, n):
    syl = ["ka", "lo", "mi", "ne", "ro", "ta", "vu", "zen", "qua", "tor", "ix", "an", "el", "or", "ul", "pri", "sto", "gra", "phe", "dyn"]
    words = set()
    while len(words) < n:
        w = "".join(rng.choice(syl) for _ in range(rng.randint(1, 4)))
        words.add(w)
    words = sorted(words)
    rng.shuffle(words)
    return words


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--shards", type=int, default=4)
    ap.add_argument("--docs", type=int, default=1500)
    ap.add_argument("--sentinels", type=int, default=400)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    V = vocab(rng, 3000)
    V += [w + "s" for w in V[:300]] + ODD
    weights = [1.0 / (i + 1) ** 1.07 for i in range(len(V))]
    os.makedirs(os.path.join(a.out, "shards"), exist_ok=True)

    def sentence(k):
        ws = rng.choices(V, weights, k=k)
        for i in range(len(ws)):
            r = rng.random()
            if r < 0.18: ws[i] = rng.choice(STOP)
            elif r < 0.22: ws[i] = ws[i].capitalize()
            elif r < 0.24: ws[i] = str(rng.randint(0, 999))
        return " ".join(ws)

    for s in range(a.shards):
        path = os.path.join(a.out, "shards", f"shard-{s:03d}.jsonl.gz")
        with gzip.open(path, "wt", encoding="utf-8") as f:
            for i in range(a.docs):
                text = sentence(rng.randint(4, 12)).capitalize() + ". " + sentence(rng.randint(30, 160)) + "."
                f.write(json.dumps({"id": f"{2100 + s:04d}.{i:05d}", "text": text}, ensure_ascii=(s % 2 == 0)) + "\n")
    sent = ["qxalpha", "qxbravo", "qxcharlie", "qxdelta", "qxecho", "qxfoxtrot"]
    with open(os.path.join(a.out, "extra.jsonl"), "w") as f:
        for i in range(a.sentinels):
            k = rng.randint(1, 8)
            f.write(json.dumps({"id": f"SENT-{i:04d}", "text": " ".join(rng.choice(sent[:rng.randint(1, 6)]) for _ in range(k))}) + "\n")
    common = V[:40]
    qs = ["qxalpha", "qxbravo qxalpha", "qxfoxtrot", "qxdelta qxdelta qxecho"]
    qs += [" ".join(rng.sample(common, rng.randint(1, 4))) for _ in range(12)]
    qs += [f"{V[i]} {V[i + 1]}" for i in range(0, 10, 2)] + ["the of and", "nosuchwordanywhere", V[2] + "s", V[5].upper()]
    with open(os.path.join(a.out, "queries.txt"), "w") as f:
        f.write("\n".join(qs) + "\n")


if __name__ == "__main__":
    main()
