let active = false;
let mediaStream = null;
let audioContext = null;
let processor = null;
let socket = null;
let utteranceBuffer = [];
let lastConfig = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return;
  if (message.type === "START_CAPTURE") {
    start(message).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "STOP_CAPTURE") {
    stop();
    sendResponse({ ok: true });
  }
});

async function start(config) {
  stop();
  active = true;
  lastConfig = config;
  const tokenResponse = await fetch(`${String(config.apiBase).replace(/\/$/, "")}/v1/transcription/token`, { method: "POST" });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.accessToken) throw new Error(token.error?.message || token.error || "Could not obtain temporary Deepgram token");

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: config.streamId } },
    video: false
  });

  const query = new URLSearchParams({
    encoding: "linear16", sample_rate: "16000", channels: "1", model: "nova-3",
    language: config.language || "en-US", punctuate: "true", smart_format: "true",
    interim_results: "true", vad_events: "true", utterance_end_ms: "1500", diarize: "true"
  });
  socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, ["bearer", token.accessToken]);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => startAudio();
  socket.onmessage = (event) => onDeepgram(JSON.parse(event.data));
  socket.onerror = () => reportError("Deepgram transcription connection failed.");
  socket.onclose = () => {
    if (active) {
      reportError("Transcription disconnected; attempting one recovery.");
      chrome.runtime.sendMessage({ type: "REQUEST_RECONNECT" });
    }
  };
}

function onDeepgram(data) {
  if (data.type === "UtteranceEnd") {
    flushBuffered();
    return;
  }
  const alternative = data.channel?.alternatives?.[0];
  const text = alternative?.transcript?.trim();
  if (!text) return;
  const words = alternative.words || [];
  const startMs = Math.round(Number(words[0]?.start ?? data.start ?? 0) * 1000);
  const lastWord = words.at(-1);
  const endMs = Math.round(Number(lastWord?.end ?? ((data.start ?? 0) + (data.duration ?? 0))) * 1000);
  const metadata = {
    confidence: typeof alternative.confidence === "number" ? alternative.confidence : null,
    speaker: words[0]?.speaker ?? null,
    startMs,
    endMs
  };
  if (data.is_final && data.speech_final) {
    const combined = [...utteranceBuffer.map((item) => item.text), text].join(" ").trim();
    const first = utteranceBuffer[0];
    utteranceBuffer = [];
    sendTranscript(combined, true, { ...metadata, startMs: first?.startMs ?? startMs });
  } else if (data.is_final) {
    utteranceBuffer.push({ text, ...metadata });
    sendTranscript(utteranceBuffer.map((item) => item.text).join(" "), false, metadata);
  } else {
    sendTranscript(text, false, metadata);
  }
}

function flushBuffered() {
  if (!utteranceBuffer.length) return;
  const text = utteranceBuffer.map((item) => item.text).join(" ").trim();
  const first = utteranceBuffer[0];
  const last = utteranceBuffer.at(-1);
  utteranceBuffer = [];
  sendTranscript(text, true, { startMs: first.startMs, endMs: last.endMs, confidence: last.confidence, speaker: first.speaker });
}

function sendTranscript(text, isFinal, meta) {
  chrome.runtime.sendMessage({ type: "TRANSCRIPT_RESULT", text, isFinal, interim: !isFinal, ...meta });
}

function startAudio() {
  audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);
  source.connect(audioContext.destination);
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) pcm[index] = Math.max(-32768, Math.min(32767, input[index] * 32768));
    socket.send(pcm.buffer);
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
}

function reportError(message) { chrome.runtime.sendMessage({ type: "PIPELINE_ERROR", message }); }
function stop() {
  active = false;
  utteranceBuffer = [];
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  if (processor) { processor.disconnect(); processor = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((track) => track.stop()); mediaStream = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
}
