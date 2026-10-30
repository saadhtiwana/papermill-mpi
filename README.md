<div align="center">

# papermill-mpi

**Search ~2.5M arXiv papers on a 3-node AWS cluster.**<br>
C++17 · MPI + OpenMP · Docker · same answer on any threads × ranks.

![C++17](https://img.shields.io/badge/C%2B%2B-17-00599C?logo=cplusplus&logoColor=white)
![OpenMPI](https://img.shields.io/badge/OpenMPI-4.1-2F6DB5)
![OpenMP](https://img.shields.io/badge/OpenMP-threads-5C9A3A)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-EC2%20·%20ECR%20·%20S3-FF9900?logo=amazonwebservices&logoColor=white)
![MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

<img src="docs/img/ui-demo.gif" width="820" alt="Web UI: a search, then a 3-rank index run with live progress">

</div>

## What it does

- **TF-IDF over words + word pairs** for 200 shards of arXiv titles and abstracts
- **Three modes:** 1 thread · OpenMP threads · MPI ranks × threads across nodes
- **Deterministic:** byte-identical top-10 on every layout, checked against a Python reference
- **AWS native:** EC2 ×3, one image in ECR, shards from S3, IAM role, Elastic IP

## Architecture

<img src="docs/aws-architecture.png" width="900" alt="AWS architecture">

<img src="docs/pipeline.gif" width="860" alt="Index and search pipeline">

Shards are split across ranks, parsed by threads into hash buckets, and document counts are exchanged with
`MPI_Alltoallv`. Each node keeps its own index part; a search gathers each rank's top-10 on rank 0.

## Quickstart

```bash
docker build -t papermill-mpi .
python3 tests/gen_corpus.py demo && cp examples/settings.example.txt demo/settings.txt

docker run --rm -v "$PWD/demo:/data" papermill-mpi /opt/engine index 0 1 2 3
docker run --rm -v "$PWD/demo:/data" papermill-mpi /opt/engine search "qxbravo qxalpha"
```

MPI in one container: put `mpirun --oversubscribe -np 3` before `/opt/engine` in both commands (search needs the same `-np`).

<img src="docs/demo.gif" width="820" alt="1 rank vs 3 MPI ranks: same results">

## Web UI

A small console for the engine: search, index runs with live progress, benchmarks and node status.
[`web/server.py`](web/server.py) is standard-library Python that runs `/opt/engine` as a subprocess (the same
commands as above, streamed over server-sent events); [`web/static/`](web/static) is plain HTML, CSS and JS with no build step.

```bash
docker run --rm -p 127.0.0.1:8080:8080 -v "$PWD/demo:/data" -e ROLE=master \
  -e MASTER_CMD="PAPERMILL_WEB_HOST=0.0.0.0 python3 /opt/web/server.py" papermill-mpi
# open http://localhost:8080
```

Without a hostfile, "Cluster" mode runs the ranks in the one container. On AWS, set
`MASTER_CMD="PAPERMILL_WEB_HOST=0.0.0.0 PAPERMILL_WEB_PORT=8000 python3 /opt/web/server.py"` in `aws/config.env`
before `aws/04_deploy.sh`; the server then uses `/data/hosts` and `MPIRUN_ARGS` for `mpirun`. It has no login and
starts index runs, so keep the port limited to your own IP (`HTTP_ALLOW_CIDRS`).

| Variable | Default | |
|---|---|---|
| `PAPERMILL_WEB_HOST` / `PAPERMILL_WEB_PORT` | `127.0.0.1` / `8080` | bind address |
| `PAPERMILL_DATA` | `/data` | settings, shards and index |
| `PAPERMILL_ENGINE` | `/opt/engine` | engine binary |
| `PAPERMILL_HOSTFILE` | `$PAPERMILL_DATA/hosts` if present | `mpirun --hostfile`; none = local ranks |
| `PAPERMILL_MPIRUN_ARGS` | `$MPIRUN_ARGS` | extra `mpirun` arguments |
| `PAPERMILL_SIZES` | `S=1,M=20,L=200` | size name = shard count (clipped to the shards on disk) |
| `PAPERMILL_MAX_THREADS` / `PAPERMILL_MAX_RANKS` | `4` / `6` | stepper limits |
| `PAPERMILL_NODES` | `master,w1,w2` | node names on the cluster page |
| `PAPERMILL_STATE` | `$PAPERMILL_DATA/web` | run history and current layout |

API: `POST /api/index {mode: seq|omp|mpi, threads, ranks, size}` · `GET /api/index/events` (SSE progress) ·
`GET /api/status` · `POST /api/search {q}` · `GET /api/runs` · `GET /api/cluster`.

| | Light | Dark |
|---|---|---|
| Search | <img src="docs/img/ui-search-light-desktop.png" width="400"> | <img src="docs/img/ui-search-dark-desktop.png" width="400"> |
| Index | <img src="docs/img/ui-index-light-desktop.png" width="400"> | <img src="docs/img/ui-index-dark-desktop.png" width="400"> |
| Benchmarks | <img src="docs/img/ui-benchmarks-light-desktop.png" width="400"> | <img src="docs/img/ui-benchmarks-dark-desktop.png" width="400"> |
| Cluster | <img src="docs/img/ui-cluster-light-desktop.png" width="400"> | <img src="docs/img/ui-cluster-dark-desktop.png" width="400"> |

<p>
<img src="docs/img/ui-search-light-mobile.png" width="200" alt="Search on a phone">
<img src="docs/img/ui-index-dark-mobile.png" width="200" alt="Index on a phone, dark">
<img src="docs/img/ui-benchmarks-light-mobile.png" width="200" alt="Benchmarks on a phone">
<img src="docs/img/ui-cluster-dark-mobile.png" width="200" alt="Cluster on a phone, dark">
</p>

Screenshots and the GIF come from [`docs/shoot.py`](docs/shoot.py) (Playwright) on the synthetic corpus
(`tests/gen_corpus.py demo --shards 8 --docs 20000`, `PAPERMILL_SIZES=S=2,M=4,L=8`), so the ids are made up.

## Deploy on AWS

```bash
cp aws/config.env.example aws/config.env     # region, instance type, shard bucket
bash aws/01_infra.sh && bash aws/02_launch.sh && bash aws/05_build.sh && bash aws/04_deploy.sh
bash aws/07_run.sh 3 2 index 0 1 2 3          # 3 ranks × 2 threads
bash aws/07_run.sh 3 2 search "dark matter halo"
./stop.sh   ./start.sh   ./cleanup.sh
```

~$0.41/h running on 3 × r5.large, ~$0.02/h stopped.

## Benchmarks

| Corpus | Sequential | OpenMP ×2 | MPI 3×2 |
|---|---|---|---|
| 1 shard (12,470 papers) | 0.797 s | 0.656 s | 1.100 s |
| 20 shards (N = 253,763) | 8.706 s ¹ | soon | soon |
| 200 shards (~2.5M papers) | soon | soon | soon |

Each run also indexes 2,000 sentinel docs. ¹ on m7i-flex.large; others on 3 × r5.large. Hash collisions found so far: **0** (1.29M features checked).

## Tests

```bash
docker run --rm -v "$PWD":/work:ro papermill-mpi bash /work/tests/run_tests.sh   # ALL TESTS PASSED
```

Settings and env vars: [`examples/settings.example.txt`](examples/settings.example.txt) · [`engine/common.hpp`](engine/common.hpp)

## License

MIT © saadhtiwana
