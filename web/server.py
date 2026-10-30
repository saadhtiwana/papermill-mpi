#!/usr/bin/env python3
"""papermill-mpi web console: index runs, search and cluster status over HTTP (standard library only).

    PAPERMILL_WEB_HOST=0.0.0.0 python3 web/server.py

In the image it is started on the master through MASTER_CMD (see README, "Web console"). The engine is run as a
subprocess, exactly as on the command line:
    seq  OMP_NUM_THREADS=1 /opt/engine index ...
    omp  OMP_NUM_THREADS=T /opt/engine index ...
    mpi  mpirun -np R [--hostfile H] -x OMP_NUM_THREADS -x PAPERMILL_DATA ... /opt/engine index ...
A search reuses the layout (ranks) of the last index run, because every rank opens its own index part.

Configuration (environment):
    PAPERMILL_WEB_HOST     bind address                          127.0.0.1
    PAPERMILL_WEB_PORT     port                                  8080
    PAPERMILL_DATA         data root (settings, shards, index)   /data
    PAPERMILL_ENGINE       engine binary                         /opt/engine
    PAPERMILL_HOSTFILE     mpirun hostfile; none = local ranks   $PAPERMILL_DATA/hosts if it exists
    PAPERMILL_MPIRUN_ARGS  extra mpirun arguments                $MPIRUN_ARGS (set by the deploy scripts)
    PAPERMILL_SIZES        size name=shard count, comma list     S=1,M=20,L=200 (clipped to the shards present)
    PAPERMILL_MAX_THREADS  upper limit for threads per rank      4
    PAPERMILL_MAX_RANKS    upper limit for MPI ranks             6
    PAPERMILL_NODES        node names shown on the cluster page  master,w1,w2
    PAPERMILL_STATE        run history and layout state          $PAPERMILL_DATA/web
"""
import glob
import json
import mimetypes
import os
import re
import shlex
import socket
import subprocess
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


def env(k, d=""):
    v = os.environ.get(k, "")
    return v if v else d


DATA = env("PAPERMILL_DATA", "/data")
ENGINE = env("PAPERMILL_ENGINE", "/opt/engine")
HOSTFILE = env("PAPERMILL_HOSTFILE", os.path.join(DATA, "hosts"))
MPIRUN_ARGS = shlex.split(env("PAPERMILL_MPIRUN_ARGS", env("MPIRUN_ARGS")))
MAX_THREADS = int(env("PAPERMILL_MAX_THREADS", "4"))
MAX_RANKS = int(env("PAPERMILL_MAX_RANKS", "6"))
NODES = [n.strip() for n in env("PAPERMILL_NODES", "master,w1,w2").split(",") if n.strip()]
STATE = env("PAPERMILL_STATE", os.path.join(DATA, "web"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
RUNS = os.path.join(STATE, "runs.jsonl")
LAYOUT = os.path.join(STATE, "layout.json")
SHARD_RE = re.compile(r"shard-(\d{3})\.jsonl(\.gz)?$")
MODES = {"seq": "Sequential", "omp": "Single node", "mpi": "Cluster"}

lock = threading.Lock()
job = None  # the running (or last) index job, a dict; guarded by lock


def hostfile():
    return HOSTFILE if os.path.isfile(HOSTFILE) else None


def local_shards():
    out = []
    for p in glob.glob(os.path.join(DATA, "shards", "shard-*")):
        m = SHARD_RE.search(p)
        if m:
            out.append(int(m.group(1)))
    return sorted(set(out))


def sizes():
    have = local_shards()
    out = []
    for item in env("PAPERMILL_SIZES", "S=1,M=20,L=200").split(","):
        name, _, n = item.partition("=")
        if name.strip() and n.strip().isdigit():
            k = min(int(n), len(have))
            out.append({"name": name.strip(), "shards": k, "requested": int(n)})
    return out


def launcher(mode, threads, ranks):
    """argv prefix and environment for one engine call."""
    e = dict(os.environ, PAPERMILL_DATA=DATA, OMP_NUM_THREADS=str(threads))
    if mode != "mpi":
        return [ENGINE], e
    argv = ["mpirun", "-np", str(ranks), "-x", "OMP_NUM_THREADS", "-x", "PAPERMILL_DATA"]
    hf = hostfile()
    argv += ["--hostfile", hf] if hf else ["--oversubscribe"]
    return argv + MPIRUN_ARGS + [ENGINE], e


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def runs():
    out = []
    try:
        with open(RUNS) as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    return out


def public(j):
    keys = ("id", "mode", "threads", "ranks", "size", "shards", "status", "progress", "started", "finished",
            "seconds", "engine_seconds", "docs", "peak_mib", "error")
    return {k: j.get(k) for k in keys}


# ------------------------------------------------------------------ index runs
def run_index(j):
    argv, e = launcher(j["mode"], j["threads"], j["ranks"])
    argv = argv + ["index"] + [str(s) for s in j["shard_list"]]
    t0 = time.monotonic()
    try:
        p = subprocess.Popen(argv, env=e, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, bufsize=1)
    except OSError as ex:
        finish(j, "failed", time.monotonic() - t0, "", str(ex))
        return
    err = []
    t = threading.Thread(target=lambda: err.extend(p.stderr), daemon=True)
    t.start()
    for line in p.stdout:
        line = line.strip()
        if line.isdigit():
            with lock:
                j["progress"] = int(line)
    p.wait()
    t.join()
    finish(j, "ok" if p.returncode == 0 else "failed", time.monotonic() - t0, "".join(err), None)


def finish(j, status, seconds, log, error):
    m = re.search(r"N=(\d+).*total ([\d.]+)s.*peak RSS \(max over ranks\) ([\d.]+) MiB", log)
    if status != "ok" and not error:
        lines = [l for l in log.splitlines() if l.strip()]
        error = lines[-1][:300] if lines else "engine exited with an error"
    with lock:
        j.update(status=status, seconds=round(seconds, 3), finished=time.time(), error=error)
        if m:
            j.update(docs=int(m.group(1)), engine_seconds=float(m.group(2)), peak_mib=float(m.group(3)))
        rec = public(j)
    os.makedirs(STATE, exist_ok=True)
    with open(RUNS, "a") as f:
        f.write(json.dumps(rec) + "\n")
    if status == "ok":
        write_json(LAYOUT, {"mode": j["mode"], "threads": j["threads"], "ranks": j["ranks"], "size": j["size"],
                            "docs": j.get("docs"), "built": j["finished"], "run": j["id"]})


def start_index(body):
    global job
    mode = body.get("mode")
    if mode not in MODES:
        return 400, {"error": "mode must be seq, omp or mpi"}
    try:
        threads = 1 if mode == "seq" else int(body.get("threads", 1))
        ranks = int(body.get("ranks", 3)) if mode == "mpi" else 1
    except (TypeError, ValueError):
        return 400, {"error": "threads and ranks must be integers"}
    if not 1 <= threads <= MAX_THREADS or not 1 <= ranks <= MAX_RANKS:
        return 400, {"error": f"threads 1..{MAX_THREADS}, ranks 1..{MAX_RANKS}"}
    size = next((s for s in sizes() if s["name"] == body.get("size")), None)
    if not size:
        return 400, {"error": "unknown size"}
    with lock:
        if job and job["status"] == "running":
            return 409, {"error": "an index run is already in progress", "run": public(job)}
        job = {"id": uuid.uuid4().hex[:8], "mode": mode, "threads": threads, "ranks": ranks, "size": size["name"],
               "shards": size["shards"], "shard_list": local_shards()[:size["shards"]], "status": "running",
               "progress": 0, "started": time.time()}
        j = job
    threading.Thread(target=run_index, args=(j,), daemon=True).start()
    return 202, {"run": public(j)}


# ------------------------------------------------------------------ search
def search(body):
    q = str(body.get("q", "")).strip()
    if not q:
        return 400, {"error": "empty query"}
    if len(q) > 500:
        return 400, {"error": "query too long (500 characters at most)"}
    lay = read_json(LAYOUT, None)
    if not lay:
        return 409, {"error": "no index yet: run an index first"}
    with lock:
        if job and job["status"] == "running":
            return 409, {"error": "an index run is in progress; search again when it finishes"}
    argv, e = launcher(lay["mode"], lay["threads"], lay["ranks"])
    t0 = time.monotonic()
    p = subprocess.run(argv + ["search", q], env=e, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                       timeout=120)
    ms = (time.monotonic() - t0) * 1000
    if p.returncode != 0:
        lines = [l for l in p.stderr.splitlines() if l.strip()]
        return 500, {"error": lines[-1] if lines else "search failed"}
    results = []
    for i, line in enumerate(p.stdout.splitlines()):
        doc, _, score = line.rpartition(" ")
        if doc:
            results.append({"rank": i + 1, "id": doc, "score": float(score), "score_text": score})
    return 200, {"q": q, "results": results, "latency_ms": round(ms, 1), "layout": lay}


# ------------------------------------------------------------------ cluster
PROBE = r"""
import json, os, socket, glob
mem = 0
for l in open('/proc/meminfo'):
    if l.startswith('MemTotal:'): mem = int(l.split()[1]) * 1024
d = os.environ.get('PAPERMILL_DATA', '/data')
print(json.dumps({'host': socket.gethostname(), 'vcpus': os.cpu_count(), 'mem_bytes': mem,
                  'shards': len(glob.glob(os.path.join(d, 'shards', 'shard-*.jsonl*'))),
                  'index_parts': len(glob.glob(os.path.join(d, 'index', 'part-*.bin')))}), flush=True)
"""


def cluster():
    hf = hostfile()
    hosts = []
    if hf:
        with open(hf) as f:
            hosts = [l.split()[0] for l in f if l.strip() and not l.startswith("#")]
    out = []
    if not hosts:  # one machine: every node name is a slot on this host
        info = probe_local()
        for n in NODES:
            out.append(dict(info, name=n, address="local", status="online", simulated=len(NODES) > 1))
        return {"mode": "local", "nodes": out}
    for i, h in enumerate(hosts):
        name = NODES[i] if i < len(NODES) else h
        try:
            argv = ["mpirun", "-np", "1", "--host", h, "-x", "PAPERMILL_DATA"] + MPIRUN_ARGS + ["python3", "-c", PROBE]
            p = subprocess.run(argv, env=dict(os.environ, PAPERMILL_DATA=DATA), stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=20)
            info = json.loads(p.stdout.strip().splitlines()[-1])
            out.append(dict(info, name=name, address=h, status="online"))
        except Exception:  # unreachable, timeout or bad output: show the node as offline
            out.append({"name": name, "address": h, "status": "offline"})
    return {"mode": "hostfile", "nodes": out}


def probe_local():
    p = subprocess.run(["python3", "-c", PROBE], env=dict(os.environ, PAPERMILL_DATA=DATA), capture_output=True,
                       text=True, timeout=20)
    try:
        return json.loads(p.stdout)
    except ValueError:
        return {"host": socket.gethostname(), "vcpus": os.cpu_count()}


def status():
    with lock:
        j = public(job) if job else None
    return {"engine": os.access(ENGINE, os.X_OK), "data": DATA, "hostfile": hostfile(), "index": read_json(LAYOUT, None),
            "job": j, "sizes": sizes(), "shards_present": len(local_shards()), "modes": MODES,
            "limits": {"threads": MAX_THREADS, "ranks": MAX_RANKS}, "now": time.time()}


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "papermill-web"

    def log_message(self, fmt, *args):
        pass

    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 65536:
            return None
        try:
            v = json.loads(self.rfile.read(n) or b"{}")
            return v if isinstance(v, dict) else None
        except ValueError:
            return None

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/status":
            return self.send(200, status())
        if path == "/api/runs":
            return self.send(200, {"runs": runs()[::-1]})
        if path == "/api/cluster":
            return self.send(200, cluster())
        if path == "/api/index/events":
            return self.events()
        if path.startswith("/api/"):
            return self.send(404, {"error": "not found"})
        self.static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        b = self.body()
        if b is None:
            return self.send(400, {"error": "body must be a JSON object"})
        if path == "/api/index":
            return self.send(*start_index(b))
        if path == "/api/search":
            try:
                return self.send(*search(b))
            except subprocess.TimeoutExpired:
                return self.send(504, {"error": "search timed out"})
        self.send(404, {"error": "not found"})

    def events(self):
        """Server-sent events: the running job's progress, once per change (and every second), then 'done'."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        last, beat = None, 0.0
        try:
            while True:
                with lock:
                    j = public(job) if job else None
                now = time.monotonic()
                if j != last or now - beat > 1:
                    kind = "progress" if j and j["status"] == "running" else "done"
                    self.wfile.write(f"event: {kind}\ndata: {json.dumps(j)}\n\n".encode())
                    self.wfile.flush()
                    last, beat = j, now
                    if kind == "done":
                        return
                time.sleep(0.1)
        except (BrokenPipeError, ConnectionResetError):
            return

    def static(self, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC, rel))
        if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
            return self.send(404, {"error": "not found"})
        with open(full, "rb") as f:
            b = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith((".html", ".css", ".js", ".svg")):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(b)


def main():
    host, port = env("PAPERMILL_WEB_HOST", "127.0.0.1"), int(env("PAPERMILL_WEB_PORT", "8080"))
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    print(f"papermill web console on http://{host}:{port}  (data {DATA}, engine {ENGINE}, hostfile {hostfile()})",
          flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
