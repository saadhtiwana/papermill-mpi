// papermill web console: hash-routed views over the JSON API in web/server.py. No dependencies.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const fmtSec = (s) => (s == null ? "—" : s < 10 ? s.toFixed(2) + " s" : s < 100 ? s.toFixed(1) + " s" : Math.round(s) + " s");
const fmtMs = (ms) => (ms < 1000 ? ms.toFixed(ms < 100 ? 1 : 0) + " ms" : (ms / 1000).toFixed(2) + " s");
const ARXIV = /^(\d{4}\.\d{4,5}(v\d+)?|[a-z\-]+(\.[A-Z]{2})?\/\d{7})$/;
const ICON_EXT = '<svg class="ext" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5 3 9"/></svg>';
const ICON_INFO = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7.5v3.5M8 5h.01"/></svg>';

const state = {
  status: null,
  clockSkew: 0, // server time - local time, seconds
  mode: "omp",
  threads: 2,
  ranks: 3,
  size: null,
  benchSize: null,
  runs: [],
  stream: null,
  tick: null,
};

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), 4000);
}

function layoutLabel(r) {
  if (!r) return "";
  if (r.mode === "seq") return "Sequential";
  if (r.mode === "omp") return `Single node · ${r.threads} thread${r.threads > 1 ? "s" : ""}`;
  return `Cluster · ${r.ranks} × ${r.threads}`;
}
const layoutShort = (r) => (r.mode === "seq" ? "1 × 1" : r.mode === "omp" ? `1 × ${r.threads}` : `${r.ranks} × ${r.threads}`);

function ago(t) {
  const s = Math.max(0, Date.now() / 1000 + state.clockSkew - t);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------ theme */
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}
function paintTheme() {
  const d = isDark();
  document.documentElement.classList.toggle("is-dark", d);
  $$("[data-theme-toggle]").forEach((b) => b.setAttribute("aria-label", d ? "Switch to light mode" : "Switch to dark mode"));
  $(".theme-label").textContent = d ? "Light mode" : "Dark mode";
}
$$("[data-theme-toggle]").forEach((b) =>
  b.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("pm-theme", next);
    paintTheme();
  })
);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintTheme);

/* ------------------------------------------------------------------ routing */
const VIEWS = ["search", "index", "benchmarks", "cluster"];
const TITLES = { search: "Search", index: "Index", benchmarks: "Benchmarks", cluster: "Cluster" };
function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "search";
  $$(".view").forEach((s) => (s.hidden = s.dataset.view !== v));
  $$("[data-nav]").forEach((a) => (a.dataset.nav === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  document.title = `${TITLES[v]} · papermill`;
  if (v === "benchmarks") loadRuns();
  if (v === "cluster" && !loadCluster.done) loadCluster();
  if (v === "search" && !$("#results").innerHTML) renderSearchIdle();
}
window.addEventListener("hashchange", () => {
  route();
  $("#main").focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

/* ------------------------------------------------------------------ status */
async function loadStatus() {
  try {
    const s = await api("/api/status");
    state.status = s;
    state.clockSkew = s.now - Date.now() / 1000;
    if (!state.size || !s.sizes.some((z) => z.name === state.size)) {
      const first = s.sizes.find((z) => z.shards > 0) || s.sizes[0];
      state.size = first ? first.name : null;
    }
    paintPill();
    renderIndexForm();
    if (s.job && s.job.status === "running") follow(s.job);
  } catch (e) {
    paintPill(e);
  }
}

function paintPill(err) {
  const dot = $("#index-pill .dot");
  const txt = $("#index-pill .index-pill-text");
  const s = state.status;
  if (err || !s) {
    dot.dataset.state = "offline";
    txt.textContent = "Server unreachable";
  } else if (s.job && s.job.status === "running") {
    dot.dataset.state = "running";
    txt.textContent = `Indexing · ${s.job.progress}%`;
  } else if (s.index) {
    dot.dataset.state = "ready";
    txt.textContent = `Ready · ${layoutShort(s.index)} · ${fmtInt(s.index.docs)} docs`;
    txt.title = `${layoutLabel(s.index)}, size ${s.index.size}`;
  } else {
    dot.dataset.state = "none";
    txt.textContent = "No index yet";
  }
}

/* ------------------------------------------------------------------ search */
const RECENT_KEY = "pm-recent";
const recent = () => JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
function remember(q) {
  const r = [q, ...recent().filter((x) => x !== q)].slice(0, 5);
  localStorage.setItem(RECENT_KEY, JSON.stringify(r));
}

function renderSearchIdle() {
  $("#result-meta").innerHTML = "";
  const r = recent();
  const s = state.status;
  if (s && !s.index) {
    $("#results").innerHTML = `<div class="empty">
      <h2>No index yet</h2>
      <p>Search needs an index. Build one from the shards on disk; it takes a few seconds on a small corpus.</p>
      <a class="btn" href="#index">Build an index</a></div>`;
    return;
  }
  $("#results").innerHTML = `<div class="empty">
    <h2>Search the index</h2>
    <p>Queries are tokenized like the documents: lowercased, stopwords removed, plurals folded, adjacent words paired.
       Press <kbd class="kbd">Enter</kbd> to run.</p>
    ${r.length ? `<div class="empty-list" aria-label="Recent searches">${r.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>` : ""}
  </div>`;
}

$("#results").addEventListener("click", (e) => {
  const c = e.target.closest("[data-q]");
  if (!c) return;
  $("#q").value = c.dataset.q;
  runSearch();
});

let searchSeq = 0;
async function runSearch() {
  const q = $("#q").value.trim();
  if (!q) return renderSearchIdle();
  const my = ++searchSeq;
  $("#result-meta").innerHTML = `<span>Searching…</span>`;
  $("#results").setAttribute("aria-busy", "true");
  try {
    const d = await api("/api/search", { q });
    if (my !== searchSeq) return;
    remember(q);
    renderResults(d);
  } catch (e) {
    if (my !== searchSeq) return;
    $("#result-meta").innerHTML = "";
    const noIndex = e.status === 409 && /no index/.test(e.message);
    $("#results").innerHTML = `<div class="empty">
      <h2>${noIndex ? "No index yet" : "Search did not run"}</h2>
      <p>${esc(noIndex ? "Search needs an index. Build one from the shards on disk first." : e.message)}</p>
      ${noIndex ? '<a class="btn" href="#index">Build an index</a>' : ""}</div>`;
  } finally {
    $("#results").removeAttribute("aria-busy");
  }
}

function renderResults(d) {
  const n = d.results.length;
  $("#result-meta").innerHTML = `<span><b class="num">${n}</b> result${n === 1 ? "" : "s"}</span>
    <span><b class="num">${fmtMs(d.latency_ms)}</b> end to end</span>
    <span>${esc(layoutLabel(d.layout))}</span>`;
  if (!n) {
    $("#results").innerHTML = `<div class="empty">
      <h2>No documents match “${esc(d.q)}”</h2>
      <p>Every term is either a stopword, shorter than the minimum length, or absent from the index. Try fewer or different words.</p></div>`;
    return;
  }
  const top = d.results[0].score || 1;
  const rows = d.results
    .map((r, i) => {
      const link = ARXIV.test(r.id)
        ? `<a class="result-id" href="https://arxiv.org/abs/${encodeURIComponent(r.id)}" target="_blank" rel="noopener">${esc(r.id)}${ICON_EXT}</a>`
        : `<span class="result-id">${esc(r.id)}</span>`;
      const w = Math.max(2, (r.score / top) * 100);
      return `<li class="result" style="animation-delay:${i * 18}ms">
        <span class="result-rank">${String(r.rank).padStart(2, "0")}</span>
        ${link}
        <span class="result-bar"><span class="score-bar" aria-hidden="true"><span style="width:${w.toFixed(1)}%;animation-delay:${i * 18}ms"></span></span></span>
        <span class="result-score" title="Score">${esc(r.score_text)}</span></li>`;
    })
    .join("");
  $("#results").innerHTML = `<div class="results-head" aria-hidden="true"><span>#</span><span>Paper</span><span>Relative score</span><span>Score</span></div>
    <ol class="results" aria-label="Results for ${esc(d.q)}">${rows}</ol>`;
}

$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});
$("#q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") e.target.blur();
});
if (/Mac|iPhone|iPad/.test(navigator.platform)) $(".kbd-mod").textContent = "⌘";
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (location.hash !== "#search" && location.hash !== "") location.hash = "#search";
    setTimeout(() => $("#q").select(), 0);
  }
});

/* ------------------------------------------------------------------ index */
const MODE_HELP = {
  seq: "One process, one thread. The baseline every speedup is measured against.",
  omp: "One process on this node; OpenMP threads parse shards and build buckets in parallel.",
  mpi: "Shards are split across MPI ranks; document frequencies are exchanged with MPI_Alltoallv.",
};

function renderIndexForm() {
  const s = state.status;
  if (!s) return;
  const lim = s.limits;
  state.threads = Math.min(state.threads, lim.threads);
  state.ranks = Math.min(state.ranks, lim.ranks);
  $$("#mode [role=radio]").forEach((b) => {
    const on = b.dataset.value === state.mode;
    b.setAttribute("aria-checked", on);
    b.tabIndex = on ? 0 : -1;
  });
  $("#mode-help").textContent = MODE_HELP[state.mode];
  const t = state.mode === "seq" ? 1 : state.threads;
  const r = state.mode === "mpi" ? state.ranks : 1;
  setStepper("threads", t, state.mode !== "seq", lim.threads);
  setStepper("ranks", r, state.mode === "mpi", lim.ranks);

  $("#sizes").innerHTML = s.sizes
    .map((z) => {
      const on = z.name === state.size;
      const meta = z.shards === 0 ? "No shards on disk" : `${fmtInt(z.shards)} shard${z.shards === 1 ? "" : "s"}${z.shards < z.requested ? ` of ${z.requested}` : ""}`;
      return `<button type="button" class="size" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-value="${esc(z.name)}" ${z.shards === 0 ? "disabled" : ""}>
        <span class="size-name">${esc(z.name)}</span><span class="size-meta">${meta}</span></button>`;
    })
    .join("");

  const size = s.sizes.find((z) => z.name === state.size);
  const shards = size ? size.shards : 0;
  const shardArgs = shards > 4 ? `0 … ${shards - 1}` : Array.from({ length: shards }, (_, i) => i).join(" ");
  const launch = state.mode === "mpi" ? `mpirun -np ${r} ${s.hostfile ? "--hostfile " + s.hostfile : "--oversubscribe"} ` : "";
  $("#cmd-preview").innerHTML = `<span class="k">$</span> OMP_NUM_THREADS=${t} ${esc(launch)}/opt/engine index ${esc(shardArgs)}`;

  const running = s.job && s.job.status === "running";
  $("#run-btn").disabled = running || !s.engine || !size;
  $("#run-note").textContent = !s.engine
    ? "Engine binary not found. Set PAPERMILL_ENGINE."
    : running
    ? "An index run is in progress."
    : s.index
    ? `Replaces the current index (${layoutLabel(s.index)}, built ${ago(s.index.built)}).`
    : "No index on disk yet.";
}

function setStepper(name, v, enabled, max) {
  const el = $(`[data-stepper=${name}]`);
  el.setAttribute("aria-disabled", !enabled);
  $("output", el).textContent = v;
  $('[data-step="-1"]', el).disabled = !enabled || v <= 1;
  $('[data-step="1"]', el).disabled = !enabled || v >= max;
}

function radioGroup(el, onPick) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[role=radio]");
    if (b && !b.disabled) onPick(b.dataset.value);
  });
  el.addEventListener("keydown", (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const items = $$("[role=radio]:not(:disabled)", el);
    const i = items.indexOf(document.activeElement);
    const next = items[(i + dir + items.length) % items.length];
    onPick(next.dataset.value);
    $(`[role=radio][data-value="${CSS.escape(next.dataset.value)}"]`, el).focus();
  });
}
radioGroup($("#mode"), (v) => ((state.mode = v), renderIndexForm()));
radioGroup($("#sizes"), (v) => ((state.size = v), renderIndexForm()));
$$("[data-stepper]").forEach((el) =>
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-step]");
    if (!b || b.disabled) return;
    const k = el.dataset.stepper;
    const max = state.status.limits[k];
    state[k] = Math.min(max, Math.max(1, state[k] + Number(b.dataset.step)));
    renderIndexForm();
  })
);

$("#run-btn").addEventListener("click", async () => {
  $("#run-btn").disabled = true;
  try {
    const d = await api("/api/index", { mode: state.mode, threads: state.threads, ranks: state.ranks, size: state.size });
    state.status.job = d.run;
    follow(d.run);
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    $("#run-panel").scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "nearest" });
  } catch (e) {
    toast(e.message);
    if (e.data && e.data.run) follow(e.data.run);
  }
  renderIndexForm();
});

function follow(job) {
  showRun(job);
  if (state.stream) return;
  clearInterval(state.tick);
  state.tick = setInterval(() => paintElapsed(state.status.job), 100);
  const done = (j) => {
    if (state.stream) state.stream.close();
    state.stream = null;
    clearInterval(state.tick);
    showRun(j);
    loadStatus();
    loadRuns.stale = true;
    if (j && j.status === "ok") toast(`Index ready: ${fmtInt(j.docs)} documents in ${fmtSec(j.engine_seconds ?? j.seconds)}.`);
  };
  if (window.EventSource) {
    const es = new EventSource("/api/index/events");
    state.stream = es;
    es.addEventListener("progress", (e) => {
      const j = JSON.parse(e.data);
      state.status.job = j;
      showRun(j);
      paintPill();
    });
    es.addEventListener("done", (e) => done(JSON.parse(e.data)));
    es.onerror = () => {
      es.close();
      state.stream = null;
      poll(done);
    };
  } else poll(done);
}

function poll(done) {
  const h = setInterval(async () => {
    try {
      const s = await api("/api/status");
      state.status = s;
      if (s.job && s.job.status === "running") return showRun(s.job), paintPill();
      clearInterval(h);
      done(s.job);
    } catch (_) {}
  }, 500);
}

function paintElapsed(j) {
  if (!j) return;
  const end = j.status === "running" ? Date.now() / 1000 + state.clockSkew : j.finished;
  $("#run-elapsed").textContent = fmtSec(Math.max(0, end - j.started));
}

function showRun(j) {
  if (!j) return;
  const p = $("#run-panel");
  p.hidden = false;
  const running = j.status === "running";
  const failed = j.status === "failed";
  $("#run-title").innerHTML = running
    ? '<span class="dot" data-state="running"></span>Indexing'
    : failed
    ? '<span class="dot" data-state="offline"></span>Index run failed'
    : '<span class="dot" data-state="ready"></span>Index ready';
  $("#run-sub").textContent = `${layoutLabel(j)} · size ${j.size} · ${fmtInt(j.shards)} shard${j.shards === 1 ? "" : "s"} · run ${j.id}`;
  const pct = failed ? j.progress : running ? j.progress : 100;
  $("#run-pct").textContent = pct + "%";
  const bar = $("#run-bar");
  bar.setAttribute("aria-valuenow", pct);
  bar.classList.toggle("is-running", running);
  bar.classList.toggle("is-failed", failed);
  $("span", bar).style.transform = `scaleX(${pct / 100})`;
  paintElapsed(j);
  const stats = $("#run-stats");
  if (running) {
    stats.innerHTML = ["Documents", "Engine time", "Wall time", "Peak memory"]
      .map((k) => `<div><dt>${k}</dt><dd><span class="skeleton dd"></span></dd></div>`)
      .join("");
  } else if (failed) {
    stats.innerHTML = `<div style="grid-column:1/-1"><dt>Error</dt><dd class="err-text">${esc(j.error || "engine exited with an error")}</dd></div>`;
  } else {
    stats.innerHTML = [
      ["Documents", fmtInt(j.docs)],
      ["Engine time", fmtSec(j.engine_seconds)],
      ["Wall time", fmtSec(j.seconds)],
      ["Peak memory", j.peak_mib == null ? "—" : `${fmtInt(Math.round(j.peak_mib))} MiB`],
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
      .join("");
  }
}

/* ------------------------------------------------------------------ benchmarks */
async function loadRuns() {
  try {
    state.runs = (await api("/api/runs")).runs;
  } catch (e) {
    $("#runs").innerHTML = `<p class="table-empty">${esc(e.message)}</p>`;
    return;
  }
  const done = new Set(state.runs.filter((r) => r.status === "ok").map((r) => r.size));
  const known = state.status ? state.status.sizes.map((z) => z.name) : [];
  const sizes = [...known.filter((z) => done.has(z)), ...[...done].filter((z) => !known.includes(z))];
  const latest = state.runs.find((r) => r.status === "ok");
  if (loadRuns.stale || !sizes.includes(state.benchSize)) state.benchSize = latest ? latest.size : null;
  loadRuns.stale = false;
  $("#bench-size").innerHTML = sizes
    .map((z) => `<button type="button" role="radio" aria-checked="${z === state.benchSize}" tabindex="${z === state.benchSize ? 0 : -1}" data-value="${esc(z)}">Size ${esc(z)}</button>`)
    .join("");
  $("#bench-size").hidden = sizes.length === 0;
  renderChart();
  renderTable();
}
radioGroup($("#bench-size"), (v) => {
  state.benchSize = v;
  $$("#bench-size [role=radio]").forEach((b) => {
    b.setAttribute("aria-checked", b.dataset.value === v);
    b.tabIndex = b.dataset.value === v ? 0 : -1;
  });
  renderChart();
});

const runTime = (r) => r.engine_seconds ?? r.seconds;

function baselines() {
  const base = {};
  for (const r of state.runs) if (r.status === "ok" && r.mode === "seq" && !(r.size in base)) base[r.size] = runTime(r);
  return base; // runs are newest first, so this keeps the latest sequential run per size
}

function renderChart() {
  const el = $("#chart");
  const ok = state.runs.filter((r) => r.status === "ok" && r.size === state.benchSize);
  const base = baselines()[state.benchSize];
  if (!ok.length) {
    el.innerHTML = `<div class="empty"><h2>No runs yet</h2><p>Finished index runs show up here. Run the same size sequentially, on one node and on the cluster to compare them.</p><a class="btn" href="#index">Start a run</a></div>`;
    return;
  }
  if (!base) {
    el.innerHTML = `<div class="notice">${ICON_INFO}<span>No sequential run of size ${esc(state.benchSize)} yet. Run one to get a baseline for speedup.</span></div>`;
    return;
  }
  // latest run per layout, in a fixed order: sequential, single node by threads, cluster by ranks then threads
  const seen = new Map();
  for (const r of ok) if (!seen.has(layoutShort(r) + r.mode)) seen.set(layoutShort(r) + r.mode, r);
  const order = { seq: 0, omp: 1, mpi: 2 };
  const rows = [...seen.values()].sort((a, b) => order[a.mode] - order[b.mode] || a.ranks - b.ranks || a.threads - b.threads);
  const W = Math.max(280, Math.round(el.clientWidth || 720));
  const narrow = W < 520;
  const short = (r) => (r.mode === "seq" ? "Sequential" : r.mode === "omp" ? `OpenMP × ${r.threads}` : `MPI ${r.ranks} × ${r.threads}`);
  const data = rows.map((r) => ({ r, label: narrow ? short(r) : layoutLabel(r), x: base / runTime(r) }));

  const rowH = 32, gap = 8, left = narrow ? 92 : 176, right = 56, top = 8, axisH = 28;
  const H = top + data.length * (rowH + gap) - gap + axisH;
  const maxX = Math.max(2, Math.ceil(Math.max(...data.map((d) => d.x)) * 2) / 2);
  const sx = (v) => left + (v / maxX) * (W - left - right);
  const ticks = [];
  const step = maxX <= 3 ? 0.5 : maxX <= 6 ? 1 : 2;
  for (let v = 0; v <= maxX + 1e-9; v += step) ticks.push(v);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Speedup versus sequential for size ${esc(state.benchSize)}">`;
  for (const v of ticks) {
    const x = sx(v).toFixed(1);
    svg += `<line class="grid" x1="${x}" x2="${x}" y1="${top - 4}" y2="${H - axisH + 4}"/>`;
    svg += `<text class="axis" x="${x}" y="${H - 8}" text-anchor="middle">${v % 1 ? v.toFixed(1) : v}×</text>`;
  }
  data.forEach((d, i) => {
    const y = top + i * (rowH + gap);
    const w = Math.max(2, sx(d.x) - left);
    svg += `<text class="lbl" x="${left - 16}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(d.label)}</text>`;
    svg += `<rect class="${d.r.mode === "seq" ? "bar bar-seq" : "bar"}" x="${left}" y="${y + 8}" width="${w.toFixed(1)}" height="${rowH - 16}" rx="2"><title>${esc(d.label)}: ${d.x.toFixed(2)}× (${fmtSec(runTime(d.r))})</title></rect>`;
    svg += `<text class="val" x="${(left + w + 8).toFixed(1)}" y="${y + rowH / 2 + 4}">${d.x.toFixed(2)}×</text>`;
  });
  const bx = sx(1).toFixed(1);
  svg += `<line class="base" x1="${bx}" x2="${bx}" y1="${top - 4}" y2="${H - axisH + 4}"/></svg>`;
  el.innerHTML = svg;
}

function renderTable() {
  const el = $("#runs");
  if (!state.runs.length) {
    el.innerHTML = `<p class="table-empty">No index runs recorded yet.</p>`;
    return;
  }
  const base = baselines();
  const MODE = { seq: "Sequential", omp: "Single node", mpi: "Cluster" };
  el.innerHTML = `<table>
    <thead><tr><th scope="col" class="hide-sm">Run</th><th scope="col">Mode</th><th scope="col">Size</th><th scope="col" class="r hide-sm">Documents</th>
      <th scope="col" class="r">Engine</th><th scope="col" class="r hide-sm">Wall</th><th scope="col" class="r">Speedup</th><th scope="col" class="hide-sm">Status</th><th scope="col" class="r hide-sm">When</th></tr></thead>
    <tbody>${state.runs
      .map((r) => {
        const sp = r.status === "ok" && base[r.size] ? (base[r.size] / runTime(r)).toFixed(2) + "×" : "—";
        const st = r.status === "ok" ? '<span class="dot" data-state="ready"></span>Done' : '<span class="dot" data-state="offline"></span>Failed';
        return `<tr><td class="hide-sm"><span class="mono">${esc(r.id)}</span></td>
          <td>${MODE[r.mode]}<span class="layout-tag">${layoutShort(r)}</span></td>
          <td>${esc(r.size)}</td><td class="r hide-sm">${fmtInt(r.docs)}</td>
          <td class="r">${fmtSec(r.engine_seconds)}</td><td class="r hide-sm">${fmtSec(r.seconds)}</td><td class="r">${sp}</td>
          <td class="hide-sm"><span class="status" ${r.error ? `title="${esc(r.error)}"` : ""}>${st}</span></td>
          <td class="r muted hide-sm">${ago(r.finished)}</td></tr>`;
      })
      .join("")}</tbody></table>`;
}

/* ------------------------------------------------------------------ cluster */
function fmtMem(b) {
  if (!b) return "—";
  const g = b / 2 ** 30;
  return g >= 10 ? Math.round(g) + " GiB" : g.toFixed(1) + " GiB";
}

async function loadCluster() {
  loadCluster.done = true;
  const el = $("#nodes");
  const btn = $("#cluster-refresh");
  btn.disabled = true;
  el.setAttribute("aria-busy", "true");
  el.innerHTML = ["master", "w1", "w2"]
    .map(
      (n) => `<div class="panel node is-skeleton"><div class="node-head"><div><div class="node-name">${n}</div><div class="node-role">Probing</div></div></div>
      <dl>${["Status", "vCPUs", "Memory", "Shards", "Index parts"].map((k) => `<div><dt>${k}</dt><dd><span class="skeleton"></span></dd></div>`).join("")}</dl></div>`
    )
    .join("");
  try {
    const c = await api("/api/cluster");
    $("#cluster-lede").textContent =
      c.mode === "local"
        ? "No hostfile found, so every node name maps to this machine and MPI ranks run locally."
        : "Nodes from the MPI hostfile, each probed with one process through mpirun.";
    el.innerHTML = c.nodes
      .map((n, i) => {
        const on = n.status === "online";
        const rows = [
          ["Status", `<span class="status"><span class="dot" data-state="${on ? "ready" : "offline"}"></span>${on ? "Online" : "Unreachable"}</span>`],
          ["Host", `<span class="mono">${esc(n.host || n.address)}</span>`],
          ["vCPUs", on ? fmtInt(n.vcpus) : "—"],
          ["Memory", on ? fmtMem(n.mem_bytes) : "—"],
          ["Shards present", on ? fmtInt(n.shards) : "—"],
          ["Index parts", on ? fmtInt(n.index_parts) : "—"],
        ];
        return `<article class="panel node" aria-label="Node ${esc(n.name)}">
          <div class="node-head"><div><div class="node-name">${esc(n.name)}</div>
            <div class="node-role">${i === 0 ? "Master · rank 0" : "Worker"}${n.simulated ? " · local" : ""}</div></div></div>
          <dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl></article>`;
      })
      .join("");
  } catch (e) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><h2>Cluster probe failed</h2><p>${esc(e.message)}</p></div>`;
  } finally {
    btn.disabled = false;
    el.removeAttribute("aria-busy");
  }
}
$("#cluster-refresh").addEventListener("click", loadCluster);
let resizeH;
window.addEventListener("resize", () => {
  clearTimeout(resizeH);
  resizeH = setTimeout(() => !$("#view-benchmarks").hidden && state.runs.length && renderChart(), 120);
});

/* ------------------------------------------------------------------ start */
paintTheme();
route();
loadStatus().then(() => {
  if (location.hash === "#search" || !location.hash) if (!$("#q").value) renderSearchIdle();
});
setInterval(() => {
  if (!state.stream) loadStatus();
}, 15000);
