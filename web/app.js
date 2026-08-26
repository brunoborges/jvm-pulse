"use strict";

// ---------------------------------------------------------------------------
// App wiring: state fetch, run trigger, SSE progress
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
let waiting = false;
let runsList = [];
let currentRunId = null;
let compareMode = false;
let repositoryAttached = false;

const SOURCE_EXTENSIONS = new Set([
  "java", "kt", "kts", "scala", "groovy", "clj", "xml", "gradle", "properties",
  "yaml", "yml", "toml", "json", "md", "txt", "sh", "bat", "cmd", "jsp",
]);
const SOURCE_FILENAMES = new Set(["pom.xml", "makefile", "dockerfile", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]);

async function fetchReport(runId) {
  const url = runId ? `state?runId=${encodeURIComponent(runId)}` : "state";
  const res = await fetch(url);
  return res.json();
}

// Refresh the run history and populate the pickers. Shows the run bar once there
// is at least one saved run.
async function refreshRuns() {
  try {
    const res = await fetch("runs");
    const data = await res.json();
    runsList = (data && data.runs) || [];
  } catch {
    runsList = [];
  }
  el("runbar").classList.toggle("hidden", runsList.length === 0);
  if (runsList.length < 2) {
    // Comparison needs two runs; disable the toggle until there are.
    el("compare-btn").disabled = true;
    el("compare-btn").title = "Need at least two runs to compare";
  } else {
    el("compare-btn").disabled = false;
    el("compare-btn").title = "Compare this run with another";
  }
  populateRunSelects();
}

function runOptionLabel(r, latest) {
  const when = fmtRunTime(r.generatedAt) || r.runId;
  const extra = r.label ? ` · ${r.label}` : r.collector ? ` · ${r.collector}` : "";
  return `${when}${extra}${latest ? "  (latest)" : ""}`;
}

function populateRunSelects() {
  const sel = el("run-select");
  const base = el("baseline-select");
  if (sel) {
    sel.innerHTML = runsList.map((r, i) => `<option value="${esc(r.runId)}">${esc(runOptionLabel(r, i === 0))}</option>`).join("");
    if (currentRunId && runsList.some((r) => r.runId === currentRunId)) sel.value = currentRunId;
    else if (runsList[0]) currentRunId = runsList[0].runId;
  }
  if (base) {
    base.innerHTML = runsList.map((r) => `<option value="${esc(r.runId)}">${esc(runOptionLabel(r, false))}</option>`).join("");
    // Default the baseline to the most recent run that isn't the selected one.
    const other = runsList.find((r) => r.runId !== currentRunId);
    if (other) base.value = other.runId;
  }
}

async function selectRun(runId) {
  currentRunId = runId || (runsList[0] && runsList[0].runId) || null;
  const sel = el("run-select");
  if (sel && currentRunId) sel.value = currentRunId;
  if (compareMode) return renderComparison();
  try {
    const data = await fetchReport(currentRunId);
    if (data && !data.empty && data.gc) showReport(data);
    else showEmpty();
  } catch {
    showEmpty();
  }
}

function toggleCompare() {
  if (runsList.length < 2) return;
  compareMode = !compareMode;
  el("compare-btn").classList.toggle("active", compareMode);
  el("baseline-wrap").classList.toggle("hidden", !compareMode);
  if (compareMode) renderComparison();
  else selectRun(currentRunId);
}

async function renderComparison() {
  const baseId = el("baseline-select").value;
  const selId = currentRunId || (runsList[0] && runsList[0].runId);
  el("empty").classList.add("hidden");
  el("analyze-btn").classList.add("hidden");
  const rep = el("report");
  rep.classList.remove("hidden");
  if (!baseId || !selId || baseId === selId) {
    rep.innerHTML = `<div class="compare-hint">Pick two different runs to compare — choose the run to inspect in <strong>Run</strong> and a baseline in <strong>vs</strong>.</div>`;
    return;
  }
  rep.innerHTML = `<div class="compare-hint">Loading comparison…</div>`;
  try {
    const [a, b] = await Promise.all([fetchReport(baseId), fetchReport(selId)]);
    if (!a || a.empty || !b || b.empty) {
      rep.innerHTML = `<div class="compare-hint">Couldn't load one of the runs.</div>`;
      return;
    }
    rep.innerHTML = renderCompare(a, b);
    animateBars(rep);
  } catch {
    rep.innerHTML = `<div class="compare-hint">Failed to load comparison.</div>`;
  }
}

function showEmpty() {
  el("empty").classList.remove("hidden");
  el("report").classList.add("hidden");
  el("analyze-btn").classList.add("hidden");
}

function showReport(r) {
  if (r && r.runId) {
    currentRunId = r.runId;
    const sel = el("run-select");
    if (sel && runsList.some((x) => x.runId === r.runId)) sel.value = r.runId;
  }
  el("empty").classList.add("hidden");
  const rep = el("report");
  rep.innerHTML = renderReport(r);
  rep.classList.remove("hidden");
  animateBars(rep);
  el("analyze-btn").classList.remove("hidden");
  if (r.artifacts && r.artifacts.views) {
    fetch(`views?runId=${encodeURIComponent(r.runId || "")}`).then((res) => (res.ok ? res.text() : "")).then((txt) => {
      const pre = el("views-pre");
      if (pre) pre.textContent = txt || "(unavailable)";
    }).catch(() => {});
  }
}

function setProgress(pct, msg) {
  el("progress").classList.remove("hidden");
  if (pct != null) el("progress-fill").style.transform = `scaleX(${Math.max(0, Math.min(100, pct)) / 100})`;
  if (msg) el("progress-msg").textContent = msg;
}

function selectMode(mode) {
  const project = mode === "project" && repositoryAttached;
  el("mode-files").classList.toggle("active", !project);
  el("mode-files").setAttribute("aria-selected", String(!project));
  el("mode-project").classList.toggle("active", project);
  el("mode-project").setAttribute("aria-selected", String(project));
  el("files-panel").classList.toggle("hidden", project);
  el("project-panel").classList.toggle("hidden", !project);
}

function openConfig(mode = "files") {
  el("config").classList.remove("hidden");
  selectMode(mode);
}
function closeConfig() { el("config").classList.add("hidden"); }

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function selectedSourceFiles() {
  return [...el("cfg-source-folder").files].filter((file) => {
    const name = file.name.toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop() : "";
    return SOURCE_EXTENSIONS.has(ext) || SOURCE_FILENAMES.has(name);
  });
}

function updateFileSummaries() {
  const gc = el("cfg-gc-file").files[0];
  const jfr = el("cfg-jfr-file").files[0];
  const source = selectedSourceFiles();
  el("gc-file-summary").textContent = gc ? `${gc.name} · ${formatBytes(gc.size)}` : "Choose a unified or JDK 8 GC log";
  el("jfr-file-summary").textContent = jfr ? `${jfr.name} · ${formatBytes(jfr.size)}` : "Add a .jfr file for allocation and hotspot data";
  el("source-folder-summary").textContent = source.length
    ? `${source[0].webkitRelativePath.split("/")[0]} · ${source.length} supported files · ${formatBytes(source.reduce((sum, file) => sum + file.size, 0))}`
    : "Add the project folder for source-grounded AI advice";
  el("cfg-gc-file").closest(".file-picker").classList.toggle("has-file", Boolean(gc));
  el("cfg-jfr-file").closest(".file-picker").classList.toggle("has-file", Boolean(jfr));
  el("cfg-source-folder").closest(".file-picker").classList.toggle("has-file", source.length > 0);
}

function uploadArtifacts(form) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "ingest");
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const pct = Math.round((event.loaded / event.total) * 22);
      setProgress(pct, `Uploading selected artifacts… ${Math.round((event.loaded / event.total) * 100)}%`);
    });
    xhr.addEventListener("load", () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (HTTP ${xhr.status})`));
    });
    xhr.addEventListener("error", () => reject(new Error("The local upload connection failed.")));
    xhr.send(form);
  });
}

async function startFileAnalysis() {
  const gc = el("cfg-gc-file").files[0];
  if (!gc) {
    el("gc-file-summary").textContent = "Select a GC log before starting.";
    el("cfg-gc-file").closest(".file-picker").classList.add("invalid");
    el("cfg-gc-file").focus();
    return;
  }

  const source = selectedSourceFiles();
  const sourceBytes = source.reduce((sum, file) => sum + file.size, 0);
  if (source.length > 2000 || sourceBytes > 64 * 1024 * 1024) {
    el("run-status").textContent = "Source folder is over the 2,000 file / 64 MB limit.";
    return;
  }

  const form = new FormData();
  form.append("gcLog", gc, gc.name);
  const jfr = el("cfg-jfr-file").files[0];
  if (jfr) form.append("jfr", jfr, jfr.name);
  const label = el("cfg-label").value.trim();
  if (label) form.append("label", label);
  for (const file of source) {
    form.append(`source:${encodeURIComponent(file.webkitRelativePath || file.name)}`, file, file.name);
  }

  closeConfig();
  el("config-files-start").disabled = true;
  setWaiting("Uploading selected artifacts…");
  try {
    const result = await uploadArtifacts(form);
    finishWaiting();
    await refreshRuns();
    await selectRun(result.runId);
  } catch (err) {
    finishWaiting();
    el("run-status").textContent = err.message || String(err);
    setProgress(100, `Analysis failed: ${err.message || err}`);
  } finally {
    el("config-files-start").disabled = false;
  }
}

// A single persistent event stream: ingestion is triggered by Copilot (via the
// jvm_pulse_ingest tool), so progress/done events can arrive at any time, not just
// during a button click.
function connectEvents() {
  const evtSrc = new EventSource("events");
  evtSrc.addEventListener("awaiting", (e) => {
    try { const d = JSON.parse(e.data); setWaiting(d.msg || "Waiting for Copilot…"); } catch { setWaiting("Waiting for Copilot…"); }
  });
  evtSrc.addEventListener("progress", (e) => {
    try { const d = JSON.parse(e.data); setProgress(d.pct ?? null, d.msg || ""); } catch {}
  });
  evtSrc.addEventListener("done", (e) => {
    finishWaiting();
    setProgress(100, "Analysis complete.");
    // A fresh ingest is always shown as the latest run; leave compare mode.
    compareMode = false;
    el("compare-btn").classList.remove("active");
    el("baseline-wrap").classList.add("hidden");
    let report = null;
    try { const d = JSON.parse(e.data); report = d.report; } catch {}
    if (report && report.runId) currentRunId = report.runId;
    refreshRuns().then(() => {
      if (report && report.gc) showReport(report);
      else selectRun(currentRunId);
    });
    setTimeout(() => el("progress").classList.add("hidden"), 1500);
  });
  evtSrc.addEventListener("failed", (e) => {
    finishWaiting();
    let msg = "Analysis failed.";
    try { msg = "Analysis failed: " + (JSON.parse(e.data).error || ""); } catch {}
    el("run-status").textContent = msg;
    setProgress(100, msg);
  });
}

function setWaiting(msg) {
  waiting = true;
  el("run-status").textContent = msg;
  setProgress(4, msg);
}

function finishWaiting() {
  waiting = false;
  el("run-btn").disabled = false;
  el("run-status").textContent = "";
}

async function startRun() {
  closeConfig();
  el("run-btn").disabled = true;
  setWaiting("Asking Copilot to run the workload…");

  const body = {
    hint: el("cfg-hint").value.trim(),
    jfrMaxSizeMb: Number(el("cfg-jfr").value) || 100,
  };

  try {
    const res = await fetch("run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    setWaiting("Copilot is running the workload — results appear here when it calls jvm_pulse_ingest.");
    // Re-enable so the user can trigger again if needed; ingestion is async.
    el("run-btn").disabled = false;
  } catch (err) {
    finishWaiting();
    el("run-status").textContent = "Failed to ask Copilot: " + (err.message || err);
    el("progress").classList.add("hidden");
  }
}

async function analyzeWithAI() {
  const btn = el("analyze-btn");
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Sending…";
  el("run-status").textContent = "";
  try {
    const res = await fetch("analyze", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    el("run-status").textContent = "Sent to Copilot — see the chat for recommendations.";
    btn.textContent = "✓ Sent to Copilot";
    setTimeout(() => { btn.textContent = prev; el("run-status").textContent = ""; }, 6000);
  } catch (err) {
    el("run-status").textContent = "Analyze failed: " + (err.message || err);
    btn.textContent = prev;
  } finally {
    btn.disabled = false;
  }
}

el("run-btn").addEventListener("click", () => openConfig("files"));
el("config-cancel").addEventListener("click", closeConfig);
el("config-start").addEventListener("click", startRun);
el("config-files-start").addEventListener("click", startFileAnalysis);
el("mode-files").addEventListener("click", () => selectMode("files"));
el("mode-project").addEventListener("click", () => selectMode("project"));
el("empty-files-btn").addEventListener("click", () => openConfig("files"));
el("empty-project-btn").addEventListener("click", () => openConfig("project"));
el("cfg-gc-file").addEventListener("change", () => {
  el("cfg-gc-file").closest(".file-picker").classList.remove("invalid");
  updateFileSummaries();
});
el("cfg-jfr-file").addEventListener("change", updateFileSummaries);
el("cfg-source-folder").addEventListener("change", updateFileSummaries);
el("analyze-btn").addEventListener("click", analyzeWithAI);
el("run-select").addEventListener("change", (e) => selectRun(e.target.value));
el("baseline-select").addEventListener("change", () => { if (compareMode) renderComparison(); });
el("compare-btn").addEventListener("click", toggleCompare);

// Copy-to-clipboard for command blocks (delegated; blocks are re-rendered).
document.addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".copy-cmd");
  if (!btn) return;
  const cmd = btn.getAttribute("data-cmd") || "";
  const done = () => { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cmd).then(done).catch(() => {});
  else done();
});

async function init() {
  connectEvents();
  try {
    const context = await fetch("context").then((res) => res.json());
    repositoryAttached = Boolean(context.repositoryAttached);
  } catch {
    repositoryAttached = false;
  }
  el("mode-project").disabled = !repositoryAttached;
  el("mode-project").title = repositoryAttached ? "" : "Open JVM Pulse from a repository session to profile a project.";
  el("empty-project-btn").classList.toggle("hidden", !repositoryAttached);
  await refreshRuns();
  if (runsList.length) selectRun(runsList[0].runId);
  else showEmpty();
}

init();
