#!/usr/bin/env python3
"""Regenerates the README figures:  python3 docs/make_figures.py   (needs matplotlib + Pillow)

  docs/aws-architecture.png   the AWS deployment
  docs/pipeline.gif           index + search, stage by stage
  docs/demo.gif               terminal replay of a recorded quickstart run (output copied; long lines abridged with ...)
"""
import io, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Rectangle
from PIL import Image

OUT = os.path.dirname(os.path.abspath(__file__))
INK, ORANGE, GREEN, BLUE, RED, DOCKER, GREY, PAPER = "#232F3E", "#FF9900", "#3F8624", "#147EBA", "#DD344C", "#2496ED", "#8A949E", "#F7F8FA"
RANKC = ["#FF9900", "#2E86DE", "#3F8624"]
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9})


def rbox(ax, x, y, w, h, fc="white", ec=INK, lw=1.4, ls="-", r=0.8, z=1):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={r}", fc=fc, ec=ec, lw=lw, ls=ls, zorder=z))


def arrow(ax, a, b, color=INK, lw=1.4, style="-|>", ls="-", rad=0.0, z=5):
    ax.add_patch(FancyArrowPatch(a, b, arrowstyle=style, mutation_scale=12, color=color, lw=lw, ls=ls,
                                 connectionstyle=f"arc3,rad={rad}", zorder=z))


def label(ax, x, y, s, color=INK, size=9, weight="normal", ha="center", va="center", bg=None, z=6, family=None):
    kw = dict(bbox=dict(fc=bg, ec="none", pad=1.5)) if bg else {}
    ax.text(x, y, s, color=color, fontsize=size, fontweight=weight, ha=ha, va=va, zorder=z, family=family, **kw)


# ------------------------------------------------------------------ AWS architecture
def aws_architecture():
    fig, ax = plt.subplots(figsize=(13, 8), dpi=150)
    ax.set_xlim(0, 130); ax.set_ylim(0, 80); ax.axis("off")
    rbox(ax, 22, 2, 106, 76, fc="#FFFFFF", ec=INK, lw=2, r=1.5)
    label(ax, 24, 76, "AWS Cloud  ·  region us-east-1", weight="bold", size=11, ha="left", va="top")
    rbox(ax, 25, 5, 77, 66, fc="#F4F9F1", ec=GREEN, lw=1.4, ls="--")
    label(ax, 27, 69.5, "Default VPC", color=GREEN, weight="bold", ha="left", va="top")
    rbox(ax, 28, 8, 71, 58, fc="#F1F7FC", ec=BLUE, lw=1.3, ls="--")
    label(ax, 30, 64.5, "Availability Zone us-east-1a", color=BLUE, weight="bold", ha="left", va="top")
    rbox(ax, 31, 11, 65, 49, fc="#FFF6F7", ec=RED, lw=1.3, ls=":")
    label(ax, 50, 58.6, "Security group: 22 + HTTP from your IP only · all traffic inside the group",
          color=RED, size=7.8, ha="left", va="top")
    for i, (name, lines) in enumerate([("master", ["sshd :2222", "mpirun  /data/hosts", "rank 0, 3, 6 …", "MASTER_CMD (optional)"]),
                                       ("w1", ["sshd :2222", "", "rank 1, 4, 7 …", ""]),
                                       ("w2", ["sshd :2222", "", "rank 2, 5, 8 …", ""])]):
        x = 34 + i * 21
        rbox(ax, x, 22, 17, 32, fc="white", ec=ORANGE, lw=1.8)
        ax.add_patch(Rectangle((x, 49), 17, 5, fc=ORANGE, ec=ORANGE, zorder=2))
        label(ax, x + 8.5, 51.5, f"EC2  ·  {name}", color="white", weight="bold", size=9)
        rbox(ax, x + 1.0, 28, 15, 19.5, fc="#EAF5FD", ec=DOCKER, lw=1.3, z=2)
        label(ax, x + 8.5, 45.7, "Docker container", color=DOCKER, weight="bold", size=8.3)
        for j, l in enumerate(lines):
            label(ax, x + 8.5, 42.3 - j * 3.3, l, size=7.8)
        label(ax, x + 8.5, 24.8, "r5.large · 2 vCPU · 16 GB", color=GREY, size=7.4)
        rbox(ax, x + 1.0, 13, 15, 6.5, fc="#EEF6EA", ec=GREEN, lw=1.2)
        label(ax, x + 8.5, 17.4, "EBS gp3  /data", color=GREEN, weight="bold", size=8)
        label(ax, x + 8.5, 14.9, "shards · index part", size=7.3)
        arrow(ax, (x + 8.5, 22), (x + 8.5, 19.6), color=GREEN)
    for x in (51.2, 72.2):
        arrow(ax, (x, 38), (x + 3.6, 38), color=RED, style="<|-|>", lw=2.2)
    label(ax, 63.5, 9.6, "MPI between containers over ssh :2222  ·  Allreduce · Alltoallv · Gatherv", color=RED, size=8.2, weight="bold")
    # Elastic IP + user
    rbox(ax, 36, 57.6, 13, 4.2, fc=ORANGE, ec=ORANGE, r=1.2, z=4)
    label(ax, 42.5, 59.7, "Elastic IP", color="white", weight="bold", size=8.5)
    arrow(ax, (42.5, 57.6), (42.5, 54.3), color=ORANGE, lw=1.8)
    rbox(ax, 2, 50, 17, 14, fc=PAPER, ec=GREY)
    label(ax, 10.5, 60.5, "You", weight="bold", size=10)
    label(ax, 10.5, 56.8, "ssh  ·  aws CLI", size=8)
    label(ax, 10.5, 53.6, "web front end :8000", size=8)
    arrow(ax, (19, 59.7), (36, 59.7), color=INK, lw=1.6)
    # managed services
    svc = [(105, 57, "Amazon ECR", ORANGE, ["papermill-engine", "one image digest", "for every node"]),
           (105, 36, "Amazon S3", GREEN, ["shard bucket", "shard-NNN.jsonl.gz", "copied in-region"]),
           (105, 15, "IAM", RED, ["instance profile", "ECR pull/push (repo)", "S3 GetObject (bucket)"])]
    for x, y, t, c, ls in svc:
        rbox(ax, x, y, 21, 15, fc="white", ec=c, lw=1.8)
        ax.add_patch(Rectangle((x, y + 10.5), 21, 4.5, fc=c, ec=c, zorder=2))
        label(ax, x + 10.5, y + 12.75, t, color="white", weight="bold", size=9.5)
        for j, l in enumerate(ls):
            label(ax, x + 10.5, y + 8 - j * 3, l, size=7.9)
    arrow(ax, (105, 64), (96.5, 48), color=ORANGE, rad=0.15)
    label(ax, 115.5, 54.6, "docker compose pull", color=ORANGE, size=7.6)
    arrow(ax, (105, 43), (96.5, 38), color=GREEN)
    label(ax, 115.5, 33.6, "aws s3 cp", color=GREEN, size=7.6)
    arrow(ax, (105, 22), (96.5, 26), color=RED, ls="--")
    label(ax, 115.5, 12.6, "instance role", color=RED, size=7.6)
    fig.savefig(os.path.join(OUT, "aws-architecture.png"), bbox_inches="tight", facecolor="white")
    plt.close(fig)


# ------------------------------------------------------------------ pipeline animation
STAGES = [
    ("1 · Partition", "shard i of the command line goes to rank i % P"),
    ("2 · Parse in parallel", "T threads per rank inflate files, tokenise ~1 MB chunks, scatter postings into 256 hash buckets"),
    ("3 · Sort buckets", "each bucket sorted by hash in parallel  →  inverted lists + local df"),
    ("4 · Global df", "MPI_Alltoallv: (hash, local df) → owner rank = hash % P → summed → sent back"),
    ("5 · Write", "MPI_Allreduce gives N; every rank writes its own index part on its own node"),
    ("6 · Search", "query → df via Allreduce(MAX) → each rank scores its own documents → local top-10"),
    ("7 · Merge", "MPI_Gatherv to rank 0 → sort by score ↓, id ↑ → 10 results, identical on any layout"),
]


def pipeline_frame(k):
    fig, ax = plt.subplots(figsize=(11, 6.2), dpi=100)
    ax.set_xlim(0, 110); ax.set_ylim(0, 62); ax.axis("off")
    fig.patch.set_facecolor("white")
    title, sub = STAGES[k]
    label(ax, 55, 58.5, title, size=17, weight="bold")
    label(ax, 55, 54.3, sub, size=10.5, color="#3B4652")
    for s in range(len(STAGES)):
        ax.add_patch(Rectangle((33 + s * 6.4, 50.3), 5.4, 1.1, fc=ORANGE if s <= k else "#E3E6EA", ec="none"))
    on = lambda st: k == st
    # shards row
    for i in range(9):
        c = RANKC[i % 3] if k >= 0 else GREY
        rbox(ax, 8 + i * 10.6, 43, 8.4, 4.4, fc=c if on(0) else "white", ec=c, lw=1.6, r=0.6)
        label(ax, 12.2 + i * 10.6, 45.2, f"shard {i}", size=8, color="white" if on(0) else c, weight="bold")
    for r in range(3):
        x = 6 + r * 35
        rbox(ax, x, 6, 30, 34, fc="#FBFBFC", ec=RANKC[r], lw=2)
        label(ax, x + 15, 37.6, f"rank {r}  ·  node {['master', 'w1', 'w2'][r]}", weight="bold", color=RANKC[r], size=10)
        if on(0):
            for i in range(r, 9, 3):
                arrow(ax, (12.2 + i * 10.6, 43), (x + 15, 39.8), color=RANKC[r], lw=1.2)
        # threads
        for t in range(2):
            col = RANKC[r] if on(1) else "#D5D9DE"
            rbox(ax, x + 2 + t * 13.5, 30.5, 12.5, 4.6, fc=col, ec=col, r=0.5)
            label(ax, x + 8.25 + t * 13.5, 32.8, f"thread {t}", size=8, color="white" if on(1) else GREY)
        # buckets grid
        for b in range(16):
            bx, by = x + 2 + (b % 8) * 3.3, 21.5 + (b // 8) * 3.6
            if on(1):
                fc = RANKC[r] if (b * 7 + r) % 3 else "#FFD9A0"
            elif on(2):
                fc = "#7FB77E"
            elif k > 2:
                fc = "#C8E1C6"
            else:
                fc = "#EEF0F2"
            ax.add_patch(Rectangle((bx, by), 2.8, 3.0, fc=fc, ec="white", lw=0.8))
        label(ax, x + 15.2, 20.0, "256 hash buckets", size=7.2, color=GREY)
        # index part
        fc = RANKC[r] if on(4) else ("#E8EBEE" if k < 4 else "#F3F4F6")
        rbox(ax, x + 3, 13.6, 24, 5, fc=fc, ec=RANKC[r] if k >= 4 else "#CFD4DA", lw=1.4, r=0.6)
        label(ax, x + 15, 16.1, f"/data/index/part-000{r}.bin", size=8, color="white" if on(4) else INK, family="DejaVu Sans Mono")
        # local top-10
        fc = RANKC[r] if on(5) else "#F3F4F6"
        rbox(ax, x + 6, 7.6, 18, 4.4, fc=fc, ec=RANKC[r] if k >= 5 else "#CFD4DA", lw=1.4, r=0.6)
        label(ax, x + 15, 9.8, "local top-10", size=8.5, color="white" if on(5) else INK, weight="bold")
    if on(3):
        for a in range(3):
            for b in range(3):
                if a != b:
                    arrow(ax, (21 + a * 35, 27), (21 + b * 35, 27.6), color=RANKC[a], lw=1.6, rad=0.35 if a < b else -0.35)
        label(ax, 55, 3.2, "MPI_Alltoallv  ×2   (request local df  →  reply global df)", color=INK, size=9.5, weight="bold")
    if on(4):
        label(ax, 55, 3.2, "MPI_Allreduce(SUM)  →  N", color=INK, size=9.5, weight="bold")
    if on(5):
        label(ax, 55, 3.2, "MPI_Allreduce(MAX) on the query's df values", color=INK, size=9.5, weight="bold")
    if on(6):
        rbox(ax, 24, 0.4, 62, 3.8, fc=INK, ec=INK, r=0.6)
        label(ax, 55, 2.3, "MPI_Gatherv → rank 0 merges (score ↓, id ↑) → prints  id score × 10", color="white", size=8.8, weight="bold")
        for r, tx in ((0, 34), (1, 55), (2, 76)):
            arrow(ax, (21 + r * 35, 7.6), (tx, 4.3), color=RANKC[r], lw=1.8)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor="white")
    plt.close(fig)
    return Image.open(buf).convert("RGB")


def pipeline_gif():
    frames = [pipeline_frame(k) for k in range(len(STAGES))]
    pal = [f.quantize(colors=96, method=Image.Quantize.MEDIANCUT) for f in frames]
    pal[0].save(os.path.join(OUT, "pipeline.gif"), save_all=True, append_images=pal[1:],
                duration=[2600] * (len(pal) - 1) + [4000], loop=0, optimize=True)


# ------------------------------------------------------------------ terminal demo (recorded output; '...' = abridged)
SESSION = [
    ("$ ", 'docker run --rm -v "$PWD/demo:/data" papermill-mpi /opt/engine index 0 1 2 3 | tail -1'),
    ("", "[engine] P=1 T=2 shards=4 rank0 units=5 rank0 passes=1"),
    ("", "[engine] N=6400 postings=815737 rank-terms=181416 ... total 0.42s | peak RSS (max over ranks) 43 MiB"),
    ("", "100"),
    ("$ ", 'docker run --rm -v "$PWD/demo:/data" papermill-mpi /opt/engine search "qxbravo qxalpha" | head -3'),
    ("", "SENT-0072 1"), ("", "SENT-0158 1"), ("", "SENT-0219 1"),
    ("$ ", "docker run ... papermill-mpi mpirun --oversubscribe -np 3 -x OMP_NUM_THREADS /opt/engine index 0 1 2 3 | tail -1"),
    ("", "[engine] P=3 T=2 shards=4 rank0 units=3 rank0 passes=1"),
    ("", "100"),
    ("", "[engine] N=6400 postings=815737 rank-terms=235920 ... total 0.53s | peak RSS (max over ranks) 43 MiB"),
    ("$ ", 'docker run ... papermill-mpi mpirun --oversubscribe -np 3 /opt/engine search "qxbravo qxalpha" | head -3'),
    ("", "SENT-0072 1"), ("", "SENT-0158 1"), ("", "SENT-0219 1"),
    ("", "# same answer on 1 rank and on 3 ranks"),
]


def term_frame(lines, cursor):
    W, H, lh = 1000, 470, 21
    fig = plt.figure(figsize=(W / 100, H / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, W); ax.set_ylim(H, 0); ax.axis("off")
    fig.patch.set_facecolor("#1E2430")
    ax.add_patch(Rectangle((0, 0), W, 30, fc="#2B3240", ec="none"))
    for i, c in enumerate(("#FF5F56", "#FFBD2E", "#27C93F")):
        ax.add_patch(matplotlib.patches.Circle((20 + i * 20, 15), 6, fc=c, ec="none"))
    ax.text(W / 2, 16, "papermill-mpi  ·  quickstart (recorded run, synthetic corpus)", color="#AAB4C3", ha="center", va="center", fontsize=10)
    shown = lines[-19:]
    for i, (p, t) in enumerate(shown):
        y = 50 + i * lh
        if p:
            ax.text(14, y, "$", color="#7EE787", fontsize=10.5, family="DejaVu Sans Mono", va="center")
            ax.text(30, y, t, color="#E6EDF3", fontsize=10.5, family="DejaVu Sans Mono", va="center")
        else:
            col = "#8B949E" if t.startswith(("[engine]", "#")) else ("#FFA657" if t.startswith("SENT") else "#79C0FF")
            ax.text(14, y, t, color=col, fontsize=10.5, family="DejaVu Sans Mono", va="center")
    if cursor:
        y = 50 + len(shown) * lh if not shown or not shown[-1][0] else 50 + (len(shown) - 1) * lh
        ax.add_patch(Rectangle((14 if not shown or not shown[-1][0] else 30 + 6.35 * len(shown[-1][1]), y - 8), 8, 16, fc="#E6EDF3", ec="none"))
    buf = io.BytesIO(); fig.savefig(buf, format="png", facecolor=fig.get_facecolor()); plt.close(fig)
    return Image.open(buf).convert("RGB")


def demo_gif():
    frames, durs, lines = [], [], []
    for p, t in SESSION:
        if p:  # type the command in 3 steps
            for frac in (0.33, 0.66, 1.0):
                cur = lines + [(p, t[: max(1, int(len(t) * frac))])]
                frames.append(term_frame(cur, True)); durs.append(160)
            lines.append((p, t)); durs[-1] = 450
        else:
            lines.append((p, t))
            frames.append(term_frame(lines, False)); durs.append(260)
    durs[-1] = 3500
    pal = [f.quantize(colors=48, method=Image.Quantize.MEDIANCUT) for f in frames]
    pal[0].save(os.path.join(OUT, "demo.gif"), save_all=True, append_images=pal[1:], duration=durs, loop=0, optimize=True)


if __name__ == "__main__":
    aws_architecture()
    pipeline_gif()
    demo_gif()
    for f in ("aws-architecture.png", "pipeline.gif", "demo.gif"):
        print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, "KiB")
