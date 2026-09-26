import { buildExtractionWindow } from "../shared/context-window.js";

const DEFAULT_API = "http://127.0.0.1:8787";
const MIN_EXTRACTION_INTERVAL_MS = 4_000;
let activeTabId = null;
let segments = [];
let claims = [];
let sourceContext = null;
let extractionCursor = 0;
let extractionTimer = null;
let extractionInFlight = false;
let lastExtractionAt = 0;
let reconnects = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_SESSION") {
    startSession(message.apiBase).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "STOP_SESSION") {
    stopSession().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "TRANSCRIPT_RESULT") {
    handleTranscript(message).catch(console.error);
    return;
  }
  if (message.type === "PIPELINE_ERROR") {
    notifyTab({ type: "PIPELINE_ERROR", message: message.message });
    return;
  }
  if (message.type === "REQUEST_RECONNECT") {
    reconnectCapture().catch((error) => notifyTab({ type: "PIPELINE_ERROR", message: error.message }));
    return;
  }
  if (message.type === "CHECK_CLAIM") {
    checkClaim(message.claim).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "APPROVE_SHARE") {
    approveShare(message.runId).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "GET_SESSION_STATE") {
    sendResponse({ ok: true, active: activeTabId !== null, segments, claims });
  }
});

async function startSession(apiBase) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://www.youtube.com/")) throw new Error("Open a YouTube video before starting ClaimCheck.");
  activeTabId = tab.id;
  reconnects = 0;
  segments = [];
  claims = [];
  extractionCursor = 0;
  sourceContext = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_CONTEXT" }).catch(() => null);
  lastExtractionAt = 0;
  await chrome.storage.local.set({ apiBase: apiBase || DEFAULT_API });
  await ensureOffscreen();
  await startCaptureForTab(tab.id);
  await notifyTab({ type: "SESSION_STARTED" });
  return { ok: true };
}

async function stopSession() {
  await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_CAPTURE" }).catch(() => {});
  await notifyTab({ type: "SESSION_STOPPED" });
  activeTabId = null;
  segments = [];
  claims = [];
  extractionCursor = 0;
  sourceContext = null;
}

async function reconnectCapture() {
  if (activeTabId === null || reconnects >= 1) return;
  reconnects += 1;
  await new Promise((resolve) => setTimeout(resolve, 750));
  await startCaptureForTab(activeTabId);
}

async function startCaptureForTab(tabId) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const { apiBase = DEFAULT_API, language = "en-US" } = await chrome.storage.local.get(["apiBase", "language"]);
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "START_CAPTURE", streamId, apiBase, language });
  if (!response?.ok) throw new Error(response?.error || "Audio capture did not start");
}

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: "src/offscreen/offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Capture user-initiated active-tab audio for live transcription"
    });
  }
}

async function handleTranscript(message) {
  await notifyTab(message);
  if (!message.isFinal || !message.text?.trim()) return;
  const segment = {
    id: crypto.randomUUID(),
    text: message.text.trim(),
    startMs: Number(message.startMs || 0),
    endMs: Number(message.endMs || 0),
    confidence: typeof message.confidence === "number" ? message.confidence : null,
    speaker: message.speaker == null ? null : String(message.speaker),
    isFinal: true
  };
  segments.push(segment);
  if (segments.length > 30) {
    segments.shift();
    extractionCursor = Math.max(0, extractionCursor - 1);
  }
  scheduleExtraction();
}

function scheduleExtraction() {
  clearTimeout(extractionTimer);
  const cooldownRemaining = Math.max(0, MIN_EXTRACTION_INTERVAL_MS - (Date.now() - lastExtractionAt));
  extractionTimer = setTimeout(() => extractClaims().catch(console.error), Math.max(900, cooldownRemaining));
}

async function extractClaims() {
  if (segments.length === 0) return;
  if (extractionInFlight) {
    extractionTimer = setTimeout(() => extractClaims().catch(console.error), 1500);
    return;
  }
  const contextWindow = buildExtractionWindow(segments, extractionCursor, {
    minTotalWords: 18,
    minNewWords: 8,
    maxSentences: 4,
    targetWordsPerSentence: 12
  });
  if (!contextWindow.ready) return;

  extractionInFlight = true;
  lastExtractionAt = Date.now();
  try {
    const apiBase = await getApiBase();
    const response = await fetch(`${apiBase}/v1/claims/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments: contextWindow.segments, sourceContext })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || body.error || "Claim extraction failed");
    const byClaim = new Map(claims.map((claim) => [normalize(claim.normalizedClaim), claim]));
    for (const claim of body.claims || []) byClaim.set(normalize(claim.normalizedClaim), claim);
    claims = [...byClaim.values()].slice(-8);
    extractionCursor = contextWindow.nextCursor;
    await notifyTab({ type: "CLAIMS_UPDATED", claims });
  } catch (error) {
    await notifyTab({ type: "PIPELINE_ERROR", message: `Claim extraction: ${error.message}` });
  } finally {
    extractionInFlight = false;
  }
}

async function checkClaim(claim) {
  const apiBase = await getApiBase();
  await notifyTab({ type: "RUN_STARTED", claimId: claim.claimId });
  const response = await fetch(`${apiBase}/v1/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim, transcript: segments.slice(-10) })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || body.error || "Fact-check run failed");
  await notifyTab({ type: "RUN_COMPLETED", run: body });
  return { ok: true, run: body };
}

async function approveShare(runId) {
  const apiBase = await getApiBase();
  const response = await fetch(`${apiBase}/v1/runs/${encodeURIComponent(runId)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "share", confirmed: true })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Approval failed");
  return { ok: true, ...body };
}

async function getApiBase() {
  const { apiBase = DEFAULT_API } = await chrome.storage.local.get("apiBase");
  return String(apiBase).replace(/\/$/, "");
}

function normalize(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
async function notifyTab(message) { if (activeTabId !== null) await chrome.tabs.sendMessage(activeTabId, message).catch(() => {}); }
