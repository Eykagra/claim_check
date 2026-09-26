const root = document.createElement("aside");
root.id = "claimcheck-root";
root.innerHTML = `
  <header><div><span class="cc-eyebrow">CLAIMCHECK</span><strong>Evidence, not vibes.</strong></div><button id="cc-close" aria-label="Hide panel">×</button></header>
  <section><div class="cc-label">Live transcript</div><div id="cc-transcript" class="cc-transcript">Start listening from the extension popup.</div><div id="cc-interim" class="cc-interim"></div></section>
  <section><div class="cc-label">Checkable claims</div><div id="cc-claims" class="cc-empty">Claims will appear after complete utterances.</div></section>
  <section id="cc-result-section" hidden><div class="cc-label">Result</div><div id="cc-result"></div></section>
  <footer><span id="cc-status">Idle</span><button id="cc-export" disabled>Export report</button></footer>`;
document.documentElement.appendChild(root);

const transcript = root.querySelector("#cc-transcript");
const interim = root.querySelector("#cc-interim");
const claims = root.querySelector("#cc-claims");
const resultSection = root.querySelector("#cc-result-section");
const result = root.querySelector("#cc-result");
const status = root.querySelector("#cc-status");
const exportButton = root.querySelector("#cc-export");
let reportTranscript = [];
let reportClaims = new Map();
let reportRuns = new Map();
let reportPending = new Set();
let reportErrors = [];
let reportStartedAt = null;
let reportPage = pageContext();
root.querySelector("#cc-close").onclick = () => { root.hidden = true; };
exportButton.onclick = () => exportReport();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_PAGE_CONTEXT") {
    sendResponse(pageContext());
    return;
  }
  if (message.type === "SESSION_STARTED") {
    root.hidden = false;
    transcript.textContent = "";
    interim.textContent = "Listening…";
    status.textContent = "Listening to active tab";
    reportTranscript = [];
    reportClaims = new Map();
    reportRuns = new Map();
    reportPending = new Set();
    reportErrors = [];
    reportStartedAt = new Date().toISOString();
    reportPage = pageContext();
    updateExportState();
  }
  if (message.type === "SESSION_STOPPED") { interim.textContent = ""; status.textContent = "Stopped"; }
  if (message.type === "TRANSCRIPT_RESULT") {
    if (message.isFinal) {
      transcript.textContent = `${transcript.textContent} ${message.text}`.trim().slice(-1800);
      interim.textContent = "";
      const key = `${message.startMs ?? 0}:${message.endMs ?? 0}:${message.text}`;
      if (!reportTranscript.some((item) => item.key === key)) {
        reportTranscript.push({ key, text: message.text, startMs: Number(message.startMs || 0), endMs: Number(message.endMs || 0), speaker: message.speaker ?? null });
      }
      updateExportState();
    }
    else interim.textContent = message.text;
  }
  if (message.type === "CLAIMS_UPDATED") {
    for (const claim of message.claims || []) reportClaims.set(claim.claimId, claim);
    renderClaims(message.claims || []);
    updateExportState();
  }
  if (message.type === "RUN_STARTED") {
    reportPending.add(message.claimId);
    status.textContent = "Agents are planning and researching…";
    updateExportState();
  }
  if (message.type === "RUN_COMPLETED") {
    reportPending.delete(message.run.claim.claimId);
    reportRuns.set(message.run.claim.claimId, message.run);
    renderResult(message.run);
    updateExportState();
  }
  if (message.type === "PIPELINE_ERROR") {
    status.textContent = message.message;
    reportErrors.push(message.message);
    updateExportState();
  }
});

function renderClaims(items) {
  claims.className = "";
  claims.innerHTML = "";
  if (!items.length) { claims.className = "cc-empty"; claims.textContent = "No check-worthy claims yet."; return; }
  for (const claim of items) {
    const card = document.createElement("article");
    card.className = "cc-claim";
    card.innerHTML = `<p class="cc-normalized"></p><blockquote class="cc-quote"></blockquote><div><span></span><button>Check claim</button></div>`;
    card.querySelector(".cc-normalized").textContent = claim.normalizedClaim;
    card.querySelector(".cc-quote").textContent = `“${claim.exactQuote}”`;
    card.querySelector("span").textContent = `${claim.category} · ${checkabilityLabel(claim.checkability)}`;
    card.querySelector("button").onclick = async () => {
      card.querySelector("button").disabled = true;
      const response = await chrome.runtime.sendMessage({ type: "CHECK_CLAIM", claim });
      if (!response?.ok) { status.textContent = response?.error || "Run failed"; card.querySelector("button").disabled = false; }
    };
    claims.appendChild(card);
  }
}

function renderResult(run) {
  resultSection.hidden = false;
  const accepted = new Set(run.criticReviews?.at(-1)?.acceptedEvidenceIds || []);
  const acceptedItems = (run.evidence || []).filter((item) => accepted.has(item.evidenceId));
  const citations = [...new Map(acceptedItems.map((item) => [item.canonicalUrl || item.url, item])).values()];
  result.innerHTML = `<div class="cc-verdict ${String(run.verdict).toLowerCase()}"></div><p class="cc-summary"></p><div class="cc-failures"></div><div class="cc-citations"></div><button id="cc-approve">Review before sharing</button>`;
  result.querySelector(".cc-verdict").textContent = `${run.verdict} · ${Math.round((run.confidence || 0) * 100)}%`;
  result.querySelector(".cc-summary").textContent = run.summary;
  const failures = result.querySelector(".cc-failures");
  for (const failure of (run.failures || []).slice(-3)) {
    const item = document.createElement("div");
    item.textContent = `${failure.step}: ${failure.message}`;
    failures.appendChild(item);
  }
  const list = result.querySelector(".cc-citations");
  for (const citation of citations.slice(0, 4)) {
    const link = document.createElement("a"); link.href = citation.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = citation.title; list.appendChild(link);
  }
  result.querySelector("#cc-approve").onclick = async () => {
    const confirmed = window.confirm("Approve this exact verdict and citation payload for sharing? ClaimCheck will only record approval; it will not post automatically.");
    if (!confirmed) return;
    const response = await chrome.runtime.sendMessage({ type: "APPROVE_SHARE", runId: run.runId });
    status.textContent = response?.ok ? "Share payload approved for 10 minutes" : response?.error || "Approval failed";
  };
  status.textContent = `Stopped: ${run.stopReason} · ${run.budget.usedToolCalls}/${run.budget.maxToolCalls} calls`;
}

function pageContext() {
  return {
    publishedAt:
      document.querySelector('meta[itemprop="datePublished"]')?.content ||
      document.querySelector('meta[itemprop="uploadDate"]')?.content ||
      document.querySelector('meta[property="article:published_time"]')?.content ||
      null,
    title:
      document.querySelector('meta[name="title"]')?.content ||
      document.querySelector('meta[property="og:title"]')?.content ||
      document.title ||
      null,
    url: location.href
  };
}

function updateExportState() {
  exportButton.disabled = reportTranscript.length === 0 && reportClaims.size === 0 && reportRuns.size === 0;
}

function exportReport() {
  const allClaims = new Map(reportClaims);
  for (const run of reportRuns.values()) allClaims.set(run.claim.claimId, run.claim);
  const claimsForReport = [...allClaims.values()].sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  const checked = [...reportRuns.values()];
  const resolved = checked.filter((run) => run.verdict && run.verdict !== "UNCLEAR").length;
  const researching = claimsForReport.filter((claim) => reportPending.has(claim.claimId)).length;
  const notChecked = claimsForReport.filter((claim) => !reportRuns.has(claim.claimId) && !reportPending.has(claim.claimId)).length;
  const transcriptGroups = groupTranscript(reportTranscript);
  const generatedAt = new Date();

  const claimSections = claimsForReport.map((claim) => {
    const run = reportRuns.get(claim.claimId);
    const isPending = reportPending.has(claim.claimId);
    const verdict = run?.verdict ?? (isPending ? "RESEARCHING" : "NOT CHECKED");
    const review = run?.criticReviews?.at(-1);
    const accepted = new Set(review?.acceptedEvidenceIds ?? []);
    const sources = [...new Map((run?.evidence ?? [])
      .filter((item) => accepted.has(item.evidenceId))
      .map((item) => [item.canonicalUrl || item.url, item])).values()];
    const caveats = [
      ...(claim.needsUserConfirmation ? ["The transcript or context requires user confirmation."] : []),
      ...(review?.gaps ?? []),
      ...(run?.failures ?? []).map((failure) => `${failure.step}: ${failure.message}`),
      ...(run?.stopReason === "replan_limit" ? ["The bounded research loop reached its replan limit."] : [])
    ];
    return `
      <article class="claim">
        <div class="claim-head">
          <span class="verdict ${escapeAttribute(String(verdict).toLowerCase().replaceAll(" ", "-"))}">${escapeHtml(verdict)}</span>
          <span class="time">${escapeHtml(formatTime(claim.startMs))}</span>
        </div>
        <h3>${escapeHtml(claim.normalizedClaim)}</h3>
        <blockquote>${escapeHtml(claim.exactQuote)}</blockquote>
        <p class="meta">${escapeHtml(claim.category)} · ${escapeHtml(checkabilityLabel(claim.checkability))}${run?.confidence != null ? ` · ${Math.round(run.confidence * 100)}% verdict confidence` : ""}</p>
        <h4>Explanation</h4>
        <p>${escapeHtml(run?.summary ?? (isPending ? "Research was still running when this report was exported." : "This suggestion was not submitted for checking."))}</p>
        ${caveats.length ? `<h4>Caveats</h4><ul>${caveats.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
        <h4>Sources</h4>
        ${sources.length
          ? `<ul>${sources.map((source) => `<li><a href="${escapeAttribute(safeUrl(source.url))}">${escapeHtml(source.title || source.publisher || source.url)}</a><p class="excerpt">${escapeHtml(source.excerpt)}</p></li>`).join("")}</ul>`
          : `<p class="muted">No critic-accepted sources were available at export time.</p>`}
      </article>`;
  }).join("");

  const transcriptHtml = transcriptGroups.length
    ? transcriptGroups.map((group) => `
        <div class="transcript-row">
          <div class="speaker">${escapeHtml(group.speaker == null ? "Speaker" : `Speaker ${group.speaker}`)} · ${escapeHtml(formatTime(group.startMs))}</div>
          <div>${escapeHtml(group.text)}</div>
        </div>`).join("")
    : `<p class="muted">No finalized transcript was captured.</p>`;

  const report = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ClaimCheck report · ${escapeHtml(reportPage.title || generatedAt.toISOString().slice(0, 10))}</title>
  <style>
    :root{font-family:Arial,sans-serif;color:#2c2c2b;background:#f7f7f5}*{box-sizing:border-box}body{margin:0}.wrap{max-width:980px;margin:auto;padding:42px 24px 70px}header{padding:28px;border:1px solid #e4e3e0;border-radius:14px;background:#fff}.eyebrow{color:#2783de;font-size:12px;font-weight:800;letter-spacing:1.2px}h1{margin:7px 0 9px;font-size:34px}h2{margin-top:38px}.source{color:#68645f}.source a{color:#1767ae}.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:20px}.stat{padding:14px;border-radius:9px;background:#f0efed}.stat strong{display:block;font-size:24px}.stat span{font-size:12px;color:#6d6964}.claim{margin:14px 0;padding:22px;border:1px solid #e4e3e0;border-radius:12px;background:#fff}.claim-head{display:flex;justify-content:space-between;align-items:center}.verdict{padding:5px 8px;border-radius:6px;background:#e5f2fc;color:#1767ae;font-size:12px;font-weight:800}.verdict.supported{background:#e8f1ec;color:#337552}.verdict.contradicted{background:#fce9e7;color:#a33b32}.verdict.mixed{background:#fbebde;color:#9a571e}.verdict.not-checked{background:#f0efed;color:#696661}.verdict.researching{background:#fff3cd;color:#765c00}.time,.meta,.muted{color:#7d7a75;font-size:12px}h3{margin:13px 0 9px;font-size:20px}h4{margin:18px 0 6px}blockquote{margin:0;padding-left:12px;border-left:3px solid #d8eaf8;color:#5e5a55}.excerpt{max-height:120px;overflow:auto;color:#5e5a55;font-size:12px;white-space:pre-wrap}a{color:#1767ae}.transcript-row{display:grid;grid-template-columns:140px 1fr;gap:14px;padding:12px 0;border-bottom:1px solid #e4e3e0}.speaker{color:#1767ae;font-size:12px;font-weight:700}.errors{padding:14px;border-radius:9px;background:#fce9e7;color:#8b3028}@media(max-width:700px){.stats{grid-template-columns:repeat(2,1fr)}.transcript-row{grid-template-columns:1fr}.wrap{padding:20px 14px}}@media print{body{background:#fff}.wrap{max-width:none}.claim,header{break-inside:avoid}}
  </style>
</head>
<body><main class="wrap">
  <header>
    <div class="eyebrow">CLAIMCHECK SESSION REPORT</div>
    <h1>${escapeHtml(reportPage.title || "Spoken-claim verification")}</h1>
    <div class="source">${safeUrl(reportPage.url) ? `<a href="${escapeAttribute(safeUrl(reportPage.url))}">${escapeHtml(reportPage.url)}</a>` : ""}${reportPage.publishedAt ? ` · Published ${escapeHtml(reportPage.publishedAt)}` : ""}</div>
    <div class="source">Session ${escapeHtml(reportStartedAt ? new Date(reportStartedAt).toLocaleString() : "start unavailable")} · Exported ${escapeHtml(generatedAt.toLocaleString())}</div>
    <div class="stats">
      <div class="stat"><strong>${claimsForReport.length}</strong><span>Suggested</span></div>
      <div class="stat"><strong>${checked.length}</strong><span>Checked</span></div>
      <div class="stat"><strong>${resolved}</strong><span>Resolved</span></div>
      <div class="stat"><strong>${notChecked}</strong><span>Not checked</span></div>
      <div class="stat"><strong>${researching}</strong><span>Researching</span></div>
    </div>
  </header>
  ${reportErrors.length ? `<h2>Session warnings</h2><div class="errors">${reportErrors.map((error) => `<div>${escapeHtml(error)}</div>`).join("")}</div>` : ""}
  <h2>Claims</h2>
  ${claimSections || `<p class="muted">No claims were suggested during this session.</p>`}
  <h2>Grouped transcript</h2>
  ${transcriptHtml}
</main></body></html>`;

  const blob = new Blob([report], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `claimcheck-report-${generatedAt.toISOString().slice(0, 10)}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status.textContent = "Report exported";
}

function groupTranscript(items) {
  const groups = [];
  for (const item of [...items].sort((a, b) => a.startMs - b.startMs)) {
    const previous = groups.at(-1);
    const sameSpeaker = previous && String(previous.speaker ?? "") === String(item.speaker ?? "");
    if (sameSpeaker && item.startMs - previous.endMs <= 3500) {
      previous.text = `${previous.text} ${item.text}`.replace(/\s+/g, " ").trim();
      previous.endMs = Math.max(previous.endMs, item.endMs);
    } else {
      groups.push({ text: item.text, startMs: item.startMs, endMs: item.endMs, speaker: item.speaker ?? null });
    }
  }
  return groups;
}

function formatTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function checkabilityLabel(score) {
  const value = Number(score || 0);
  if (value >= 0.85) return "high checkability";
  if (value >= 0.65) return "medium checkability";
  return "low checkability";
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

chrome.runtime.sendMessage({ type: "GET_SESSION_STATE" }, (state) => {
  if (state?.active) {
    root.hidden = false;
    reportStartedAt = reportStartedAt || new Date().toISOString();
    reportTranscript = (state.segments || []).map((item) => ({ ...item, key: `${item.startMs ?? 0}:${item.endMs ?? 0}:${item.text}` }));
    for (const claim of state.claims || []) reportClaims.set(claim.claimId, claim);
    renderClaims(state.claims || []);
    updateExportState();
  }
});
