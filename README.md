# papermill-mpi

**Distributed TF-IDF search over ~2.5M arXiv papers: one C++17 binary, three execution modes, identical answers on any layout.**

![C++17](https://img.shields.io/badge/C%2B%2B-17-00599C?logo=cplusplus&logoColor=white)
![OpenMPI](https://img.shields.io/badge/OpenMPI-4.1-2F6DB5)
![OpenMP](https://img.shields.io/badge/OpenMP-threads-5C9A3A)
![Docker](https://img.shields.io/badge/Docker-one%20image-2496ED?logo=docker&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-EC2%20%C2%B7%20ECR%20%C2%B7%20S3-FF9900?logo=amazonwebservices&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

papermill-mpi indexes arXiv titles + abstracts (200 gzip JSONL shards, ~12.6K papers each) into a TF-IDF index over
**unigrams and bigrams**, and answers top-10 queries. The same program runs

- **sequentially** (1 process, 1 thread),
- on **one machine** with OpenMP (T threads),
- on a **cluster** with MPI + OpenMP (P ranks × T threads across nodes),

and the results are **byte-identical for every threads × ranks combination**, checked against an independent Python
reference implementation.

```
                       Elastic IP :8000 (optional web front end, MASTER_CMD)
                                     │
 ┌────────────── master ─────────────┴──┐  ┌─────────── worker 1 ──────────┐  ┌─────────── worker 2 ──────────┐
 │ container (ROLE=master), sshd :2222  │  │ container (ROLE=worker)       │  │ container (ROLE=worker)       │
 │ mpirun --hostfile /data/hosts        │  │ sshd :2222                    │  │ sshd :2222                    │
 │ rank 0  shards 0,3,6…  T threads     │  │ rank 1  shards 1,4,7…         │  │ rank 2  shards 2,5,8…         │
 │   parse ─► 256 hash buckets ─► sort  │  │   parse ─► buckets ─► sort    │  │   parse ─► buckets ─► sort    │
 └───────┬──────────────────────────────┘  └──────────────┬────────────────┘  └──────────────┬────────────────┘
         │      MPI_Allreduce(N)                          │                                  │
         ├────── MPI_Alltoallv: (hash, local df) ─► owner rank = hash % P ─► global df ─► back ┤
         │                                                │                                  │
   /data/index/part-0000.bin                    /data/index/part-0001.bin          /data/index/part-0002.bin
         │                                                │                                  │
  search: every rank scores its own docs ─► local top-10 ─► MPI_Gatherv ─► rank 0 merges ─► "id score" × 10
```

## How it works

**Tokenisation** (documents and queries go through the same code, settings read at run time):
lower-case → maximal `[a-z0-9]` runs (JSON escapes and UTF-8 decoded in place; non-ASCII characters split tokens,
except the two code points whose Python `lower()` is ASCII) → drop tokens shorter than `min_token_len` → drop
stoplist words (before stemming) → `plural_s` (len > 3, ends in `s` but not `ss`: drop the `s`) → unigrams + bigrams
of consecutive surviving tokens (`graph_neural`), so a bigram can span a removed stopword.

**Scoring**: weight = tf × idf, optional L2 norm; query weight = count × idf over features that exist (df > 0),
L2-normalised; score = dot product; up to 10 results with score > 0.
tf ∈ {raw, 1 + ln c, 0.5 + 0.5 c/maxc}, idf ∈ {ln N/df, ln((1+N)/(1+df)) + 1, BM25 idf}.

**64-bit feature hashing.** A feature is the 64-bit hash of its text (FNV-1a + splitmix64 finaliser; a bigram hashes
the string `a_b`, which no unigram can equal). No feature strings are stored or copied. `engine collisions K`
re-reads the corpus, stores the real text beside every hash in K hash-range passes and reports any hash with two
different texts: 0 collisions so far (table below).

**Compact postings.** Parser threads scatter postings into 256 buckets by the top 8 hash bits (no locks), then the
buckets are sorted in parallel. A posting is 12 bytes: hash + one 32-bit word (doc id << 8 | count); counts ≥ 255
go to a small sorted side table.

**Hash-partitioned global df.** N comes from `MPI_Allreduce`. Every feature has an owner rank (hash mod P): ranks
send (hash, local df) to the owners with `MPI_Alltoallv`, owners merge the P sorted runs and return the global df
with a second `Alltoallv`. Each rank then writes its own index part on its own node.

**Distributed top-k with deterministic ties.** Ranks agree on the query's df values with `MPI_Allreduce(MAX)`, score
their own documents from the memory-mapped part, keep a local top-10, and rank 0 merges the `MPI_Gatherv` result by
score descending, then id ascending. Sums run in a fixed order (query features in hash order, L2 lengths over
value-sorted weights), so equal scores stay bit-equal on every layout.

**Multi-pass low-memory mode.** If a rank's postings would not fit in RAM (estimated from input size vs
`MemAvailable` and ranks per node), it indexes the hash range in several passes, streaming each pass's postings to
disk. Output is byte-identical for any number of passes.

## Quickstart (Docker, local)

```bash
docker build -t papermill-mpi .
python3 tests/gen_corpus.py demo && cp examples/settings.example.txt demo/settings.txt   # synthetic corpus

docker run --rm -v "$PWD/demo:/data" papermill-mpi /opt/engine index 0 1 2 3
docker run --rm -v "$PWD/demo:/data" papermill-mpi /opt/engine search "qxbravo qxalpha"

# 3 MPI ranks x 2 threads inside one container (search must use the same -np as the index)
docker run --rm -v "$PWD/demo:/data" -e OMP_NUM_THREADS=2 papermill-mpi \
  mpirun --oversubscribe -np 3 -x OMP_NUM_THREADS /opt/engine index 0 1 2 3
docker run --rm -v "$PWD/demo:/data" papermill-mpi mpirun --oversubscribe -np 3 /opt/engine search "qxbravo qxalpha"
```

Index runs print progress (0…100, one per line) on stdout and a timing summary on stderr.

## Cluster deploy on AWS

Three identical nodes in one AZ, one container per node from **one image digest** in ECR, `network_mode: host`,
`restart: unless-stopped`, sshd on 2222 for MPI (key login only), a shared mpiuser key, and `/data/hosts` on the master.

```bash
cp aws/config.env.example aws/config.env      # region, instance type, shard bucket, shard list, DATA_SRC
bash aws/01_infra.sh      # key pair, security group (22 + HTTP from your IP, all traffic within the group), IAM, ECR
bash aws/02_launch.sh     # 3 nodes + Elastic IP on the master
bash aws/05_build.sh      # build on the master (amd64, next to ECR), push, record the digest
bash aws/04_deploy.sh     # data files (sha256-checked), shards from S3, ssh key, compose up, /data/hosts
bash aws/07_run.sh 3 2 index 0 1 2 3          # 3 ranks x 2 threads
bash aws/07_run.sh 3 2 search "dark matter halo"
./stop.sh / ./start.sh    # pay for disks only while stopped; containers come back by themselves
./cleanup.sh              # prints everything it would delete, asks for "yes"
```

`aws/06_redeploy.sh` rolls a new digest to all nodes; `aws/03_resize.sh TYPE` changes the instance type in place.

## Benchmarks

Wall time per index run, measured by an external front end; nodes have 2 vCPUs (1 core + HT).

| Corpus | Nodes | Sequential | OpenMP T=2 | MPI 3 × 2 | Notes |
|---|---|---|---|---|---|
| 1 shard (12,470 papers) + 2,000 sentinel docs | 3 × r5.large | 0.797 s | 0.656 s | 1.100 s | dominated by start-up |
| 20 shards (N = 253,763) | m7i-flex.large | 8.706 s | coming soon | coming soon | 36.7M postings, 7.0M features, peak RSS 928 MiB |
| 200 shards (~2.5M papers) | 3 × r5.large | coming soon | coming soon | coming soon | |

| Collision check | Distinct features | Collisions |
|---|---|---|
| 2 shards + 2,000 sentinel docs | 1,293,020 | 0 |
| synthetic test corpus | 181,416 | 0 |
| 200 shards | coming soon | coming soon |

## Configuration

`settings.txt` (see [examples/settings.example.txt](examples/settings.example.txt)): `tf`, `idf`, `norm`,
`min_token_len`, `stemming` (`plural_s` | `none`), `stoplist` (comma-separated).

| Variable | Default | Meaning |
|---|---|---|
| `PAPERMILL_DATA` | `/data` | data root |
| `PAPERMILL_SETTINGS` | `$PAPERMILL_DATA/settings.txt` | settings file |
| `PAPERMILL_SHARD_PATTERN` | `shards/shard-%03d.jsonl.gz` | shard number → file (relative to the root unless absolute) |
| `PAPERMILL_EXTRA` | `$PAPERMILL_DATA/extra.jsonl` if present | extra documents read on every index run (empty = none) |
| `PAPERMILL_INDEX` | `$PAPERMILL_DATA/index` | per-node index directory |
| `PAPERMILL_PASSES` | automatic | force the number of hash-range passes |
| `OMP_NUM_THREADS` | all cores | threads per rank (`omp_get_max_threads()`) |

Input lines are JSON objects `{"id": "...", "text": "..."}` in any key order.

## Testing

- [`reference.py`](reference.py): a deliberately simple Python implementation (string dictionaries, no hashing).
- [`tests/run_tests.sh`](tests/run_tests.sh) runs inside the image and checks, at 1e-6 relative tolerance and then
  byte-for-byte across layouts:
  a worked toy example with an exact tie; hand-written edge cases (`uses`→`use`, `papers`/`paper`, `ss` endings,
  bigrams across stopwords, escapes, non-ASCII, counts ≥ 255, all-stopword and unknown queries) under three settings
  files covering every tf/idf/norm option; a synthetic corpus ([`tests/gen_corpus.py`](tests/gen_corpus.py)) with and
  without gzip shards; layouts 1×1, 1×4 and 3 ranks × 2 threads; forced 2- and 3-pass runs; stale-index refusal;
  and the collision check.

```bash
docker run --rm -v "$PWD":/work:ro papermill-mpi bash /work/tests/run_tests.sh     # ends with ALL TESTS PASSED
```

## Design decisions and lessons learned

- **Determinism is a design constraint, not luck.** Exactly equal scores became different in the last bit once the
  L2 sums ran in hash order; summing value-sorted weights made ties exact again on every layout.
- **Hash, then verify.** 64-bit feature hashes halve memory and remove string copies; a separate exact
  collision check makes the trade-off measurable instead of assumed.
- **12-byte postings + multi-pass** were added when a 20-shard run (928 MiB peak) projected about 7 GiB for a
  sequential full-corpus run, too close to an 8 GB node; the full-corpus measurement is coming soon.
- **One image digest everywhere.** MPI needs the same OpenMPI and the same binary on every node; building on the
  master (close to ECR) avoided pushing hundreds of MB over a slow uplink.
- **`mpirun` forwards stdin to rank 0**: inside a `while read` loop it silently eats the remaining input; give it
  `< /dev/null`.
- **OpenMPI adds OS threads.** A singleton (no `mpirun`) forks an `orted` and keeps two runtime threads; the engine
  requests an isolated singleton (`ess_singleton_isolated`), leaving one progress thread compiled into Ubuntu's
  OpenMPI 4.1.
- **Restrict MPI to the VPC interface** (`btl_tcp_if_include` / `oob_tcp_if_include`) when containers use host
  networking, or OpenMPI may try the `docker0` bridge.

## License

[MIT](LICENSE) © saadhtiwana
