// papermill web console: hash-routed views over the JSON API in web/server.py. No dependencies.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const fmtSec = (s) => (s == null ? "—" : s < 10 ? s.toFixed(2) + " s" : s < 100 ? s.toFixed(1) + " s" : Math.round(s) + " s");
const fmtMs = (ms) => (ms < 1000 ? ms.toFixed(ms < 100 ? 1 : 0) + " ms" : (ms / 1000).toFixed(2) + " s");
const ARXIV = /^(\d{4}\.\d{4,5}(v\d+)?|[a-z\-]+(\.[A-Z]{2})?\/\d{7})$/;
const icon = (d, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON_ARROW = icon("M7 17 17 7M9 7h8v8");
const ICON_EXT = icon("M7 17 17 7M9 7h8v8", "i ext");
// fine line circles behind the hero text
const DECOR = `<svg class="hero-decor" viewBox="0 0 500 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <circle cx="150" cy="30" r="150"/><circle cx="350" cy="400" r="270"/><circle cx="318" cy="64" r="20"/>
  <circle class="pt" cx="250" cy="34" r="3"/><circle class="pt" cx="38" cy="150" r="3"/></svg>`;

const state = { status: null, clockSkew: 0, mode: "omp", threads: 2, ranks: 3, size: null, benchSize: null, runs: [], stream: null, tick: null, last: null };

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

const MODE = { seq: "Sequential", omp: "Single node", mpi: "Cluster" };
function layoutLabel(r) {
  if (!r) return "";
  if (r.mode === "seq") return "Sequential";
  if (r.mode === "omp") return `Single node · ${r.threads} thread${r.threads > 1 ? "s" : ""}`;
  return `Cluster · ${r.ranks} × ${r.threads}`;
}
const layoutShort = (r) => (r.mode === "seq" ? "1 × 1" : r.mode === "omp" ? `1 × ${r.threads}` : `${r.ranks} × ${r.threads}`);
const onLayout = (r) =>
  r.mode === "seq" ? "with one thread" : r.mode === "omp" ? `on one node with ${r.threads} threads` : `on the cluster, ${r.ranks} ranks × ${r.threads} threads`;
const plural = (n, w) => `${fmtInt(n)} ${w}${n === 1 ? "" : "s"}`;

function ago(t) {
  const s = Math.max(0, Date.now() / 1000 + state.clockSkew - t);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}
const when = (t) => {
  const d = new Date(t * 1000);
  return `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
};

function hero(el, { tag, text, href, label }) {
  el.innerHTML = `${DECOR}<div class="hero-top"><span class="hero-tag">${esc(tag)}</span>
    ${href ? `<a class="hero-link" href="${href}" aria-label="${esc(label)}">${ICON_ARROW}</a>` : ""}</div>
    <p class="hero-text">${text}</p>`;
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
    renderSearchHero();
    renderIndexHero();
    if (s.job && s.job.status === "running") follow(s.job);
    else if (!$("#results").innerHTML) renderSearchIdle();
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
    txt.innerHTML = `<b>Index ready</b><span>${esc(layoutLabel(s.index))} · ${fmtInt(s.index.docs)} docs</span>`;
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
  localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...recent().filter((x) => x !== q)].slice(0, 6)));
  renderRecent();
}
function renderRecent() {
  const r = recent();
  $("#recent").innerHTML = r.length
    ? `<span class="recent-label">Recent searches</span><div class="recent-list">${r.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`
    : `<span class="recent-label">Press Enter to search. <span class="kbd-hint"></span></span>`;
  const h = $(".kbd-hint", $("#recent"));
  if (h) h.textContent = `${isMac ? "⌘" : "Ctrl"} K brings you back here from any page.`;
}
$("#recent").addEventListener("click", (e) => {
  const c = e.target.closest("[data-q]");
  if (!c) return;
  $("#q").value = c.dataset.q;
  runSearch();
});

function renderSearchHero() {
  const s = state.status;
  const el = $("#search-hero");
  if (state.last) {
    const d = state.last;
    const n = d.results.length;
    hero(el, { tag: "Last search", href: "#benchmarks", label: "Open benchmarks",
      text: n ? `<b>${n}</b> paper${n === 1 ? "" : "s"} matched “${esc(d.q)}” in <b>${fmtMs(d.latency_ms)}</b>` : `Nothing matched “${esc(d.q)}”. Try fewer or different words.` });
  } else if (s && s.index) {
    hero(el, { tag: "Index ready", href: "#index", label: "Open index runs",
      text: `<b>${fmtInt(s.index.docs)}</b> papers ready to search, indexed ${onLayout(s.index)}` });
  } else {
    hero(el, { tag: "No index", href: "#index", label: "Build an index", text: "Build an index first, then search titles and abstracts here." });
  }
}

function renderSearchIdle() {
  const s = state.status;
  $("#result-meta").textContent = "Run a search to see ranked papers.";
  $("#results").innerHTML =
    s && !s.index
      ? `<div class="empty"><h3>No index yet</h3><p>Search needs an index. Build one from the shards on disk; on a small corpus it takes a few seconds.</p><a class="btn" href="#index">Build an index</a></div>`
      : `<div class="empty"><h3>Nothing searched yet</h3><p>Results show the paper id, its score relative to the best match, and the exact score the engine returned.</p></div>`;
}

let searchSeq = 0;
async function runSearch() {
  const q = $("#q").value.trim();
  if (!q) return;
  const my = ++searchSeq;
  $("#result-meta").textContent = `Searching for “${q}”…`;
  $("#results").setAttribute("aria-busy", "true");
  try {
    const d = await api("/api/search", { q });
    if (my !== searchSeq) return;
    state.last = d;
    remember(q);
    renderResults(d);
    renderSearchHero();
  } catch (e) {
    if (my !== searchSeq) return;
    const noIndex = e.status === 409 && /no index/.test(e.message);
    $("#result-meta").textContent = "The search did not run.";
    $("#results").innerHTML = `<div class="empty"><h3>${noIndex ? "No index yet" : "Search did not run"}</h3>
      <p>${esc(noIndex ? "Search needs an index. Build one from the shards on disk first." : e.message)}</p>
      ${noIndex ? '<a class="btn" href="#index">Build an index</a>' : ""}</div>`;
  } finally {
    $("#results").removeAttribute("aria-busy");
  }
}

function renderResults(d) {
  const n = d.results.length;
  $("#result-meta").textContent = `“${d.q}” · ${plural(n, "result")} · ${fmtMs(d.latency_ms)} end to end · ${layoutLabel(d.layout)}`;
  if (!n) {
    $("#results").innerHTML = `<div class="empty"><h3>No documents match “${esc(d.q)}”</h3>
      <p>Every term is a stopword, shorter than the minimum length, or absent from the index. Try fewer or different words.</p></div>`;
    return;
  }
  const top = d.results[0].score || 1;
  $("#results").innerHTML = `<ol class="rows" aria-label="Results for ${esc(d.q)}">${d.results
    .map((r, i) => {
      const id = ARXIV.test(r.id)
        ? `<a class="row-name" href="https://arxiv.org/abs/${encodeURIComponent(r.id)}" target="_blank" rel="noopener">${esc(r.id)}${ICON_EXT}</a>`
        : `<span class="row-name">${esc(r.id)}</span>`;
      const w = Math.max(2, (r.score / top) * 100).toFixed(1);
      return `<li class="row result" style="animation-delay:${i * 20}ms">
        <span class="avatar ${i === 0 ? "avatar-blue" : ""}" aria-label="Rank ${r.rank}">${String(r.rank).padStart(2, "0")}</span>
        ${id}
        <span class="bar" aria-hidden="true"><span style="width:${w}%;animation-delay:${i * 20}ms"></span></span>
        <span class="pill score" title="Exact score">${esc(r.score_text)}</span></li>`;
    })
    .join("")}</ol>`;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
if (isMac) $(".kbd-mod").textContent = "⌘";
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});
$("#q").addEventListener("keydown", (e) => e.key === "Escape" && e.target.blur());
$("#focus-search").addEventListener("click", () => $("#q").select());
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
  omp: "One process; OpenMP threads parse shards and build buckets in parallel.",
  mpi: "Shards are split across MPI ranks; document frequencies are exchanged with MPI_Alltoallv.",
};

function renderIndexHero() {
  const s = state.status;
  if (!s) return;
  const run = s.index && state.runs.find((r) => r.id === s.index.run);
  hero($("#index-hero"), s.index
    ? { tag: "Current index", href: "#search", label: "Search this index",
        text: `<b>${fmtInt(s.index.docs)}</b> papers indexed ${onLayout(s.index)}${run ? ` in <b>${fmtSec(run.engine_seconds ?? run.seconds)}</b>` : ""}` }
    : { tag: "No index yet", text: "Pick a layout and a corpus size below, then start the first run." });
}

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
      const meta = z.shards === 0 ? "No shards on disk" : `${plural(z.shards, "shard")}${z.shards < z.requested ? ` of ${z.requested}` : ""}`;
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
    const next = items[(items.indexOf(document.activeElement) + dir + items.length) % items.length];
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
    state[k] = Math.min(state.status.limits[k], Math.max(1, state[k] + Number(b.dataset.step)));
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
    loadRuns().then(loadStatus);
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
  const t = fmtSec(Math.max(0, end - j.started));
  $("#run-elapsed").textContent = j.status === "running" ? `Elapsed ${t}` : `Finished in ${t}`;
}

function showRun(j) {
  if (!j) return;
  const running = j.status === "running";
  const failed = j.status === "failed";
  $("#run-title").textContent = running ? "Indexing" : failed ? "Index run failed" : "Index ready";
  $("#run-status").innerHTML = running
    ? '<span class="dot" data-state="running"></span>In process'
    : failed
    ? '<span class="dot" data-state="offline"></span>Failed'
    : '<span class="dot" data-state="ready"></span>Completed';
  $("#run-sub").textContent = `${layoutLabel(j)} · size ${j.size} · ${plural(j.shards, "shard")} · run ${j.id}`;
  const pct = running || failed ? j.progress : 100;
  const big = $("#run-pct");
  big.textContent = pct + "%";
  big.classList.remove("is-idle");
  const bar = $("#run-bar");
  bar.setAttribute("aria-valuenow", pct);
  bar.classList.toggle("is-running", running);
  bar.classList.toggle("is-failed", failed);
  $("span", bar).style.transform = `scaleX(${pct / 100})`;
  paintElapsed(j);
  const stats = $("#run-stats");
  if (running) {
    stats.innerHTML = ["Documents", "Engine time", "Wall time", "Peak memory"].map((k) => `<div><dt>${k}</dt><dd><span class="skeleton"></span></dd></div>`).join("");
  } else if (failed) {
    stats.innerHTML = `<div style="grid-column:1/-1"><dt>Error</dt><dd class="err-text">${esc(j.error || "engine exited with an error")}</dd></div>`;
  } else {
    stats.innerHTML = [
      ["Documents", fmtInt(j.docs)],
      ["Engine time", fmtSec(j.engine_seconds)],
      ["Wall time", fmtSec(j.seconds)],
      ["Peak memory", j.peak_mib == null ? "—" : `${fmtInt(Math.round(j.peak_mib))} MiB`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  }
}

function showIdleRun() {
  $("#run-stats").innerHTML = ["Documents", "Engine time", "Wall time", "Peak memory"].map((k) => `<div><dt>${k}</dt><dd>—</dd></div>`).join("");
  $("#run-sub").textContent = "Start a run below to watch it here.";
}

/* ------------------------------------------------------------------ benchmarks */
async function loadRuns() {
  try {
    state.runs = (await api("/api/runs")).runs;
  } catch (e) {
    $("#runs").innerHTML = `<div class="empty"><h3>Run history unavailable</h3><p>${esc(e.message)}</p></div>`;
    return;
  }
  const done = new Set(state.runs.filter((r) => r.status === "ok").map((r) => r.size));
  const known = state.status ? state.status.sizes.map((z) => z.name) : [];
  const sizes = [...known.filter((z) => done.has(z)), ...[...done].filter((z) => !known.includes(z))];
  const latest = state.runs.find((r) => r.status === "ok");
  if (!sizes.includes(state.benchSize) || (latest && latest.id !== loadRuns.seen)) state.benchSize = latest ? latest.size : null;
  loadRuns.seen = latest && latest.id;
  $("#bench-size").innerHTML = sizes.map((z) => `<option value="${esc(z)}" ${z === state.benchSize ? "selected" : ""}>Size ${esc(z)}</option>`).join("");
  $("#bench-size-wrap").hidden = sizes.length === 0;
  if (!(state.status && state.status.job && state.status.job.status === "running")) {
    if (state.runs[0]) showRun(state.runs[0]);
    else showIdleRun();
  }
  renderIndexHero();
  renderChart();
  renderTable();
}
$("#bench-size").addEventListener("change", (e) => {
  state.benchSize = e.target.value;
  renderChart();
});

const runTime = (r) => r.engine_seconds ?? r.seconds;
function baselines() {
  const base = {};
  for (const r of state.runs) if (r.status === "ok" && r.mode === "seq" && !(r.size in base)) base[r.size] = runTime(r);
  return base; // runs are newest first: the latest sequential run per size
}

function chartData() {
  const ok = state.runs.filter((r) => r.status === "ok" && r.size === state.benchSize);
  const base = baselines()[state.benchSize];
  const seen = new Map();
  for (const r of ok) if (!seen.has(r.mode + layoutShort(r))) seen.set(r.mode + layoutShort(r), r);
  // fastest first, like a ranking; the sequential baseline ends up last
  return { base, ok, rows: base ? [...seen.values()].map((r) => ({ r, x: base / runTime(r) })).sort((a, b) => b.x - a.x) : [] };
}

function renderChart() {
  const el = $("#chart");
  const { base, ok, rows } = chartData();
  const bh = $("#bench-hero");
  if (!ok.length) {
    el.innerHTML = `<div class="empty"><h3>No runs yet</h3><p>Finished index runs show up here. Run one size sequentially, on one node and on the cluster to compare them.</p><a class="btn" href="#index">Start a run</a></div>`;
    hero(bh, { tag: "Findings", href: "#index", label: "Open index runs", text: "Run the same size in every mode to see how far it scales." });
    return;
  }
  if (!base) {
    el.innerHTML = `<div class="empty"><h3>No baseline for size ${esc(state.benchSize)}</h3><p>Speedup is measured against a sequential run of the same size. Start one to fill this chart.</p><a class="btn" href="#index">Start a sequential run</a></div>`;
    hero(bh, { tag: "Findings", href: "#index", label: "Open index runs", text: `Size ${esc(state.benchSize)} has no sequential baseline yet.` });
    return;
  }
  const best = rows[0];
  hero(bh, { tag: "Findings", href: "#index", label: "Open index runs",
    text: best.r.mode === "seq"
      ? `Only the sequential baseline has run for size ${esc(state.benchSize)} so far`
      : `${esc(layoutLabel(best.r))} indexes size ${esc(state.benchSize)} <b>${best.x.toFixed(2)}×</b> faster than one thread` });

  const W = Math.max(280, Math.round(el.clientWidth || 600));
  const narrow = W < 480;
  const n = rows.length, gap = narrow ? 6 : 10, capH = narrow ? 24 : 44, H = narrow ? 260 : 320, top = 8;
  const bw = (W - gap * (n - 1)) / n;
  const plotH = H - capH - top;
  const maxX = Math.max(...rows.map((d) => d.x)) * 1.04;
  const yOf = (x) => top + plotH - (x / maxX) * plotH;
  const rad = Math.min(narrow ? 14 : 20, bw / 3);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Speedup versus sequential for size ${esc(state.benchSize)}">
    <defs><pattern id="hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatch-line" x1="0" y1="0" x2="0" y2="9"/></pattern></defs>`;
  rows.forEach((d, i) => {
    const x = i * (bw + gap), y = yOf(d.x), h = top + plotH - y, on = i === 0 && d.r.mode !== "seq";
    svg += `<g><title>${esc(layoutLabel(d.r))}: ${d.x.toFixed(2)}× (${fmtSec(runTime(d.r))})</title>
      <rect class="${on ? "b-on" : "b-in"}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${rad}"/>`;
    if (on && h > 90 && bw > 40) {
      const inset = narrow ? 5 : 8;
      svg += `<rect class="hatch-box" x="${(x + inset).toFixed(1)}" y="${(y + (narrow ? 34 : 52)).toFixed(1)}" width="${(bw - 2 * inset).toFixed(1)}" height="${(h - (narrow ? 34 : 52) - inset).toFixed(1)}" rx="${Math.max(4, rad - inset)}"/>`;
    }
    if (d.r.mode !== "seq") svg += `<text class="${on ? "v-on" : "v-in"}" x="${(x + (narrow ? 8 : 18)).toFixed(1)}" y="${(y + (narrow ? 24 : 34)).toFixed(1)}" ${narrow ? 'style="font-size:15px"' : ""}>${d.x.toFixed(2)}×</text>`;
    const cx = (x + bw / 2).toFixed(1);
    if (narrow) svg += `<text class="cap-2" x="${cx}" y="${H - 6}" text-anchor="middle">${layoutShort(d.r)}</text>`;
    else svg += `<text class="cap" x="${cx}" y="${H - 24}" text-anchor="middle">${MODE[d.r.mode]}</text><text class="cap-2" x="${cx}" y="${H - 6}" text-anchor="middle">${layoutShort(d.r)}</text>`;
    svg += `</g>`;
  });
  // dashed baseline at 1x with a label, like a callout
  const by = yOf(1);
  const si = rows.findIndex((d) => d.r.mode === "seq");
  const label = bw < 96 ? "1×" : "1× baseline";
  const tw = Math.min(bw - 8, label.length * 7.4 + 24);
  const tx = si * (bw + gap) + bw / 2;
  svg += `<line class="base" x1="0" x2="${W}" y1="${by.toFixed(1)}" y2="${by.toFixed(1)}"/>
    <rect class="tip" x="${(tx - tw / 2).toFixed(1)}" y="${(by - 15).toFixed(1)}" width="${tw.toFixed(1)}" height="30" rx="8"/>
    <text class="tip-t" x="${tx.toFixed(1)}" y="${(by + 5).toFixed(1)}" text-anchor="middle">${label}</text></svg>`;
  el.innerHTML = svg;
}

function renderTable() {
  const el = $("#runs");
  if (!state.runs.length) {
    $("#runs-range").textContent = "";
    el.innerHTML = `<div class="empty"><h3>No index runs recorded yet</h3><p>Every run you start from the Index page is listed here with its timings.</p></div>`;
    return;
  }
  const first = state.runs[state.runs.length - 1].started, last = state.runs[0].started;
  const day = (t) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  $("#runs-range").textContent = `${plural(state.runs.length, "run")} · ${day(first) === day(last) ? day(last) : `${day(first)} – ${day(last)}`}`;
  const base = baselines();
  el.innerHTML = `<ul class="rows" aria-label="Index runs, newest first">${state.runs
    .map((r, i) => {
      const sp = r.status === "ok" && base[r.size] ? (base[r.size] / runTime(r)).toFixed(2) + "×" : "—";
      const av = r.mode === "mpi" ? "avatar-blue" : r.mode === "omp" ? "avatar-ink" : "";
      const st = r.status === "ok" ? '<span class="dot" data-state="ready"></span>Completed' : '<span class="dot" data-state="offline"></span>Failed';
      return `<li class="row run-row" style="animation-delay:${Math.min(i, 12) * 15}ms">
        <span class="avatar ${av}" aria-hidden="true">${r.mode === "seq" ? "1" : layoutShort(r).replace(/ /g, "")}</span>
        <span class="row-name">${MODE[r.mode]} ${layoutShort(r)}<span class="row-sub">${fmtInt(r.docs)} docs · run <span class="mono">${esc(r.id)}</span></span></span>
        <span class="row-muted col-when">${when(r.started)}</span>
        <span class="pill status-pill col-status" ${r.error ? `title="${esc(r.error)}"` : ""}>${st}</span>
        <span class="pill col-size">Size ${esc(r.size)}</span>
        <span class="row-amount">${fmtSec(r.engine_seconds)}</span>
        <span class="row-amount" style="color:var(--ink-3)">${sp}</span></li>`;
    })
    .join("")}</ul>`;
}

/* ------------------------------------------------------------------ cluster */
function fmtMem(b) {
  if (!b) return ["—", ""];
  const g = b / 2 ** 30;
  return [g >= 10 ? String(Math.round(g)) : g.toFixed(1), "GiB"];
}

async function loadCluster() {
  loadCluster.done = true;
  const el = $("#nodes");
  const btn = $("#cluster-refresh");
  btn.disabled = true;
  el.setAttribute("aria-busy", "true");
  el.innerHTML = ["master", "w1", "w2"].map((n) => `<article class="card node is-skeleton"><div class="node-head"><span class="avatar">${n === "master" ? "M" : n.toUpperCase()}</span><div><div class="node-name">${n}</div><div class="node-role">Probing</div></div></div>
      <dl class="kv">${["Status", "vCPUs", "Memory", "Shards"].map((k) => `<div><dt>${k}</dt><dd><span class="skeleton" style="width:48px"></span></dd></div>`).join("")}</dl></article>`).join("");
  try {
    const c = await api("/api/cluster");
    const on = c.nodes.filter((n) => n.status === "online");
    const vcpus = on.reduce((a, n) => a + (n.vcpus || 0), 0);
    const local = c.mode === "local";
    $("#cluster-lede").textContent = local
      ? "No hostfile found, so every node name maps to this machine and MPI ranks run locally."
      : "Nodes from the MPI hostfile, each probed with one process through mpirun.";
    hero($("#cluster-hero"), { tag: local ? "Local cluster" : "Cluster", href: "#index", label: "Start a cluster run",
      text: local
        ? `<b>${c.nodes.length}</b> node names share this machine’s <b>${vcpus / Math.max(1, on.length)}</b> vCPUs`
        : `<b>${on.length}</b> of ${c.nodes.length} nodes online with <b>${vcpus}</b> vCPUs in total` });
    const counts = c.nodes.map((n) => n.shards || 0);
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    const same = counts.every((x) => x === counts[0]);
    $("#cluster-summary").innerHTML = `<div class="card-head"><div><h2 class="card-title">Shards on disk</h2><p class="card-sub">Per node, from /data/shards</p></div></div>
      <div class="big-row"><span class="big">${fmtInt(Math.max(...counts))}</span><span class="chip-soft">${same ? "Same on every node" : "Nodes differ"}</span></div>
      <div><div class="segbar" aria-hidden="true">${counts.map((x) => `<span style="flex:${Math.max(x, total * 0.04)}"></span>`).join("")}</div>
      <div class="seglabels" style="margin-top:12px">${c.nodes.map((n, i) => `<span style="flex:${Math.max(counts[i], total * 0.04)}">${esc(n.name)}</span>`).join("")}</div></div>
      <p class="card-sub">Index parts: ${c.nodes.map((n) => `${esc(n.name)} ${n.index_parts ?? "—"}`).join(" · ")}</p>`;
    el.innerHTML = c.nodes
      .map((n, i) => {
        const up = n.status === "online";
        const [mem, unit] = fmtMem(n.mem_bytes);
        return `<article class="card node" aria-label="Node ${esc(n.name)}">
          <div class="node-head"><span class="avatar ${i === 0 ? "avatar-blue" : "avatar-ink"}" aria-hidden="true">${i === 0 ? "M" : esc(n.name.toUpperCase().slice(0, 2))}</span>
            <div><div class="node-name">${esc(n.name)}</div><div class="node-role">${i === 0 ? "Master · rank 0" : "Worker"}${n.simulated ? " · local" : ""}</div></div>
            <span class="pill pill-sm"><span class="dot" data-state="${up ? "ready" : "offline"}"></span>${up ? "Online" : "Unreachable"}</span></div>
          <dl class="node-big"><div><dt>vCPUs</dt><dd>${up ? fmtInt(n.vcpus) : "—"}</dd></div><div><dt>Memory</dt><dd>${up ? mem : "—"}<small>${up ? unit : ""}</small></dd></div></dl>
          <dl class="kv"><div><dt>Host</dt><dd class="mono">${esc(n.host || n.address)}</dd></div>
            <div><dt>Shards present</dt><dd>${up ? fmtInt(n.shards) : "—"}</dd></div>
            <div><dt>Index parts</dt><dd>${up ? fmtInt(n.index_parts) : "—"}</dd></div></dl></article>`;
      })
      .join("");
  } catch (e) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>Cluster probe failed</h3><p>${esc(e.message)}</p></div>`;
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
renderRecent();
showIdleRun();
route();
loadStatus().then(loadRuns);
setInterval(() => {
  if (!state.stream) loadStatus();
}, 15000);
