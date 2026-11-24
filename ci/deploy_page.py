#!/usr/bin/env python3
"""Render the CI status page for the Jenkins Deploy stage (standard library only).

deploy_page.py OUT_HTML HISTORY_FILE CHANGED_TXT TEST_LOG
Reads BUILD_NUMBER, BUILD_URL, JOB_URL, PUSHED_BY, GIT_COMMIT from the environment; appends this deploy to
HISTORY_FILE (JSON lines, last 10 kept) and writes OUT_HTML.
"""
import datetime, html, json, os, socket, subprocess, sys

out, hist_path, changed_path, log_path = sys.argv[1:5]
e = lambda s: html.escape(str(s))
git = lambda *a: subprocess.run(["git", *a], capture_output=True, text=True).stdout.strip()
pkt = datetime.timezone(datetime.timedelta(hours=5), "PKT")

def read(p):
    try:
        return open(p, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""

changed = [l.split("\t") for l in read(changed_path).splitlines() if l.strip()]
entry = {
    "build": int(os.environ.get("BUILD_NUMBER", 0)),
    "url": os.environ.get("BUILD_URL", ""),
    "time": datetime.datetime.now(pkt).strftime("%Y-%m-%d %H:%M:%S PKT"),
    "commit": os.environ.get("GIT_COMMIT") or git("rev-parse", "HEAD"),
    "message": git("log", "-1", "--format=%s"),
    "author": git("log", "-1", "--format=%an"),
    "pushed_by": os.environ.get("PUSHED_BY", "") or "manual build",
    "files": [{"status": c[0], "path": c[-1]} for c in changed],
    "host": socket.gethostname(),
}

history = [json.loads(l) for l in read(hist_path).splitlines() if l.strip()]
history = ([h for h in history if h["build"] != entry["build"]] + [entry])[-10:]
with open(hist_path + ".tmp", "w") as f:
    f.write("".join(json.dumps(h) + "\n" for h in history))
os.replace(hist_path + ".tmp", hist_path)

STATUS = {"A": "added", "M": "modified", "D": "deleted", "R": "renamed"}
files = "".join(
    f'<li><span class="tag {e(f["status"][0])}">{STATUS.get(f["status"][0], e(f["status"]))}</span> <code>{e(f["path"])}</code></li>'
    for f in entry["files"]) or "<li><em>no file changes</em></li>"
rows = "".join(
    f'<tr><td><a href="{e(h["url"])}">#{h["build"]}</a></td><td>{e(h["time"])}</td><td><code>{e(h["commit"][:7])}</code></td>'
    f'<td>{e(h["message"])}</td><td>{e(h["pushed_by"])}</td><td>{len(h["files"])}</td><td>✅</td></tr>'
    for h in reversed(history))
job = os.environ.get("JOB_URL", "")

page = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>papermill-mpi CI/CD, Malik Saad Hayat (FA23-BCS-046)</title>
<style>
body{{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1f2328;background:#f6f8fa}}
h1{{font-size:1.5rem;margin:0}} h2{{font-size:1.1rem;margin:0 0 .6rem}} .sub{{color:#59636e;margin:.2rem 0 1.5rem}}
section{{background:#fff;border:1px solid #d1d9e0;border-radius:8px;padding:1rem 1.2rem;margin-bottom:1rem}}
dl{{display:grid;grid-template-columns:max-content 1fr;gap:.3rem 1rem;margin:0}} dt{{color:#59636e}} dd{{margin:0}}
code{{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#eff2f5;padding:.1rem .3rem;border-radius:4px}}
ul{{margin:.3rem 0;padding-left:1.2rem}} .tag{{font-size:12px;padding:.05rem .4rem;border-radius:4px;background:#ddf4ff}}
.tag.A{{background:#dafbe1}} .tag.D{{background:#ffebe9}} table{{border-collapse:collapse;width:100%;font-size:14px}}
th,td{{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #eaeef2}} pre{{background:#0d1117;color:#e6edf3;padding:.8rem;border-radius:6px;overflow:auto;font-size:12.5px;max-height:420px}}
.ok{{color:#1a7f37;font-weight:600}} a{{color:#0969da}}
</style></head><body>
<h1>papermill-mpi CI/CD</h1>
<p class="sub">Malik Saad Hayat (FA23-BCS-046) · GitHub push → webhook → Jenkins on EC2 → build, test, deploy</p>
<section><h2>Latest deploy</h2><dl>
<dt>Build</dt><dd><a href="{e(entry['url'])}">#{entry['build']}</a></dd>
<dt>Time</dt><dd>{e(entry['time'])}</dd>
<dt>Commit</dt><dd><code>{e(entry['commit'][:12])}</code> {e(entry['message'])}</dd>
<dt>Pushed by</dt><dd>{e(entry['pushed_by'])} (author: {e(entry['author'])})</dd>
<dt>EC2 host</dt><dd><code>{e(entry['host'])}</code></dd>
<dt>Status</dt><dd class="ok">Build ✅ · Test ✅</dd>
<dt>Files changed</dt><dd><ul>{files}</ul></dd>
</dl></section>
<section><h2>Build history (last 10 deploys)</h2><table>
<tr><th>Build</th><th>Time</th><th>Commit</th><th>Message</th><th>Pushed by</th><th>Files</th><th>Result</th></tr>{rows}</table></section>
<section><h2>Test output (build #{entry['build']})</h2><pre>{e(read(log_path).strip() or 'no test output')}</pre></section>
<section><h2>Links</h2><ul>
<li><a href="https://github.com/saadhtiwana/papermill-mpi">GitHub repo: saadhtiwana/papermill-mpi</a></li>
<li><a href="{e(job)}">Jenkins job: papermill-mpi-ci</a></li></ul></section>
</body></html>
"""
with open(out + ".tmp", "w", encoding="utf-8") as f:
    f.write(page)
os.replace(out + ".tmp", out)
print(f"deployed build #{entry['build']} -> {out} ({len(entry['files'])} changed files, {len(history)} in history)")
