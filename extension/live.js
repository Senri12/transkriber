const DEFAULT_BACKEND_URL = "http://127.0.0.1:8010";
const LIVE_STATE_KEY = "liveSessionState";
const LIVE_PENDING_KEY = "livePendingStart";
const PROCESSOR_MODULE = "audio-stream-processor.js";

const stateText = document.getElementById("stateText");
const detailText = document.getElementById("detailText");
const statsText = document.getElementById("statsText");
const timer = document.getElementById("timer");
const stopBtn = document.getElementById("stopBtn");
const transcriptNode = document.getElementById("transcript");
const sessionText = document.getElementById("sessionText");
const logNode = document.getElementById("log");

let sourceStreams = [];
let audioContext = null;
let captureNode = null;
let captureSink = null;
let captureInput = null;
let websocket = null;
let options = null;
let currentBaseUrl = null;
let startedAt = null;
let timerInterval = null;
let sessionId = null;
let transcriptText = "";
let processedChunks = 0;
let pendingChunks = 0;
let streamedPackets = 0;
let lastChunkText = "";
let currentStatus = "idle";
let currentPhase = "Idle";
let currentDetail = "No live session";
let currentError = "";
let stopRequested = false;
let finished = false;
let streamEnabled = false;

function log(message) {
  const stamp = new Date().toLocaleTimeString();
  logNode.textContent = `[${stamp}] ${message}\n${logNode.textContent}`;
}

function formatDuration() {
  if (!startedAt) {
    return "00:00";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutesPart = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secondsPart = String(seconds % 60).padStart(2, "0");
  return `${minutesPart}:${secondsPart}`;
}

function normalizeBackendUrl(rawUrl) {
  return (rawUrl || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, "");
}

function toWebSocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/live/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function renderTranscript() {
  if (!transcriptText.trim()) {
    transcriptNode.textContent = "Transcript will appear here";
    transcriptNode.classList.add("empty");
    return;
  }

  transcriptNode.textContent = transcriptText;
  transcriptNode.classList.remove("empty");
  transcriptNode.scrollTop = transcriptNode.scrollHeight;
}

function render() {
  stateText.textContent = currentPhase ? `${currentStatus}: ${currentPhase}` : currentStatus;
  if (currentStatus === "error" && currentError) {
    stateText.textContent = `error: ${currentError}`;
  }

  detailText.textContent = currentDetail || "No live session";
  statsText.textContent = `Updates: ${processedChunks}, sent packets: ${streamedPackets}, socket queue: ${pendingChunks}`;
  sessionText.textContent = `session: ${sessionId ? sessionId.slice(0, 8) : "-"}`;
  timer.textContent = formatDuration();
  renderTranscript();
}

function syncTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  timer.textContent = formatDuration();
  if (startedAt && ["starting", "recording", "processing", "stopping"].includes(currentStatus)) {
    timerInterval = setInterval(() => {
      timer.textContent = formatDuration();
    }, 1000);
  }
}

async function persistState() {
  const payload = {
    status: currentStatus,
    phase: currentPhase,
    startedAt,
    error: currentError,
    sessionId,
    detail: currentDetail,
    transcript: transcriptText,
    processedChunks,
    pendingChunks,
    lastChunkText,
    settings: options ? { ...options.settings } : undefined
  };
  await chrome.storage.local.set({ [LIVE_STATE_KEY]: payload });
}

async function setPhase(status, phase, detail, error = "") {
  currentStatus = status;
  currentPhase = phase;
  currentDetail = detail;
  currentError = error;
  syncTimer();
  render();
  await persistState();
}

async function clearPendingStart() {
  await chrome.storage.local.remove(LIVE_PENDING_KEY);
}

async function getTabStream(tabStreamId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: tabStreamId
      }
    },
    video: false
  });
}

function float32ToPcm16Buffer(floatChunk) {
  const pcmChunk = new Int16Array(floatChunk.length);
  for (let index = 0; index < floatChunk.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, floatChunk[index]));
    pcmChunk[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcmChunk.buffer;
}

function updateSocketQueueEstimate(lastPacketBytes = 0) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    pendingChunks = 0;
    return;
  }

  const approxPacketSize = Math.max(lastPacketBytes, 4096);
  pendingChunks = websocket.bufferedAmount > 0 ? Math.ceil(websocket.bufferedAmount / approxPacketSize) : 0;
}

function streamAudioPacket(arrayBuffer) {
  if (!streamEnabled || !websocket || websocket.readyState !== WebSocket.OPEN || !sessionId) {
    return;
  }

  const floatChunk = new Float32Array(arrayBuffer);
  const pcmBuffer = float32ToPcm16Buffer(floatChunk);
  websocket.send(pcmBuffer);
  streamedPackets += 1;
  updateSocketQueueEstimate(pcmBuffer.byteLength);
  render();
  void persistState();
}

async function buildAudioPipeline(settings, tabStreamId) {
  audioContext = new AudioContext();
  await audioContext.resume().catch(() => undefined);
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL(PROCESSOR_MODULE));

  captureInput = audioContext.createGain();
  captureNode = new AudioWorkletNode(audioContext, "pcm-capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });
  captureSink = audioContext.createGain();
  captureSink.gain.value = 0;

  captureInput.connect(captureNode);
  captureNode.connect(captureSink);
  captureSink.connect(audioContext.destination);
  captureNode.port.onmessage = (event) => {
    streamAudioPacket(event.data);
  };

  if (settings.useTab && tabStreamId) {
    const tabStream = await getTabStream(tabStreamId);
    sourceStreams.push(tabStream);
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    tabSource.connect(captureInput);

    const monitorGain = audioContext.createGain();
    monitorGain.gain.value = 1;
    tabSource.connect(monitorGain);
    monitorGain.connect(audioContext.destination);
    log("Tab audio connected and monitored locally.");
  }

  if (settings.useMic) {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    sourceStreams.push(micStream);
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(captureInput);
    log("Microphone connected.");
  }

  if (!sourceStreams.length) {
    throw new Error("No audio sources were initialized.");
  }

  log(`Audio pipeline ready at ${audioContext.sampleRate} Hz.`);
}

function cleanupAudio() {
  for (const stream of sourceStreams) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
  sourceStreams = [];

  if (captureNode) {
    captureNode.port.onmessage = null;
    try {
      captureNode.disconnect();
    } catch (error) {
      void error;
    }
    captureNode = null;
  }

  if (captureInput) {
    try {
      captureInput.disconnect();
    } catch (error) {
      void error;
    }
    captureInput = null;
  }

  if (captureSink) {
    try {
      captureSink.disconnect();
    } catch (error) {
      void error;
    }
    captureSink = null;
  }

  if (audioContext) {
    void audioContext.close();
    audioContext = null;
  }
}

function cleanupSocket() {
  if (!websocket) {
    return;
  }

  const socket = websocket;
  websocket = null;
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "done");
    }
  } catch (error) {
    void error;
  }
}

function cleanupResources() {
  streamEnabled = false;
  cleanupAudio();
  cleanupSocket();

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  options = null;
  currentBaseUrl = null;
  pendingChunks = 0;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch (error) {
    return text;
  }
}

function formatHttpError(payload, status) {
  if (!payload) {
    return `HTTP ${status}`;
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (typeof payload === "object" && payload.detail) {
    return typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail);
  }
  return JSON.stringify(payload);
}

async function ensureBackendAvailable(settings) {
  const baseUrl = normalizeBackendUrl(settings.backendUrl);
  let response;

  try {
    response = await fetch(`${baseUrl}/health`);
  } catch (error) {
    throw new Error(`Cannot reach backend at ${baseUrl}. Start this project's FastAPI server and verify Backend URL.`);
  }

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Backend healthcheck failed at ${baseUrl}: ${formatHttpError(payload, response.status)}`);
  }

  if (!payload || typeof payload !== "object" || !("whisper_model" in payload)) {
    throw new Error(`Backend at ${baseUrl} is not Local AI Meeting Recorder API.`);
  }

  return baseUrl;
}

function applySessionUpdate(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  sessionId = payload.session_id || sessionId;
  processedChunks = payload.chunks_processed || processedChunks;
  lastChunkText = payload.last_chunk_text || payload.delta_text || lastChunkText;
  if (typeof payload.transcript === "string") {
    transcriptText = payload.transcript;
  }
  if (payload.detail) {
    currentDetail = payload.detail;
  }
  updateSocketQueueEstimate();
  render();
}

async function handleServerMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  if (payload.type === "session_started") {
    applySessionUpdate(payload);
    startedAt = Date.now();
    streamEnabled = true;
    stopBtn.disabled = false;
    await clearPendingStart();
    await setPhase("recording", "Listening", payload.detail || "Streaming PCM audio to Whisper");
    log(`Live session ${sessionId.slice(0, 8)} created.`);
    return;
  }

  if (payload.type === "transcript_update") {
    applySessionUpdate(payload);
    if (payload.delta_text) {
      log(`Update ${payload.chunks_processed}: ${payload.delta_text}`);
    }
    await setPhase(
      stopRequested ? "processing" : "recording",
      stopRequested ? "Finishing" : "Listening",
      payload.detail || "Listening for more audio"
    );
    return;
  }

  if (payload.type === "session_finished") {
    applySessionUpdate(payload);
    await finalizeLive(payload.detail || "Live transcript is ready");
    return;
  }

  if (payload.type === "error") {
    await failLive(new Error(payload.detail || "Streaming transcription failed."));
  }
}

async function connectStreamingSocket(settings) {
  const socketUrl = toWebSocketUrl(currentBaseUrl);

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    websocket = socket;
    socket.binaryType = "arraybuffer";
    let settled = false;

    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const resolveOnce = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "start",
          language: settings.language,
          whisper_model: settings.whisperModel,
          device: "auto",
          sample_rate: audioContext ? audioContext.sampleRate : 16000
        })
      );
    });

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        void error;
        return;
      }

      void handleServerMessage(payload);
      if (payload.type === "session_started") {
        resolveOnce();
      }
    });

    socket.addEventListener("error", () => {
      rejectOnce(new Error(`Cannot open streaming websocket at ${socketUrl}.`));
    });

    socket.addEventListener("close", () => {
      if (!settled) {
        rejectOnce(new Error(`Streaming websocket at ${socketUrl} was closed during startup.`));
        return;
      }

      if (!finished && !stopRequested) {
        void failLive(new Error("Streaming websocket was closed unexpectedly."));
      }
    });
  });
}

async function finalizeLive(detail) {
  if (finished) {
    return;
  }

  finished = true;
  streamEnabled = false;
  cleanupAudio();
  await clearPendingStart();
  await setPhase("done", "Completed", detail);
  stopBtn.disabled = true;
  cleanupSocket();
  log("Live transcription finished.");
}

async function stopLiveTranscription() {
  if (finished || stopRequested) {
    return;
  }

  stopRequested = true;
  streamEnabled = false;
  stopBtn.disabled = true;
  cleanupAudio();
  await setPhase("stopping", "Stopping capture", "Finalizing streaming transcript");

  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify({ type: "finish" }));
    return;
  }

  await finalizeLive("Live transcript is ready");
}

async function failLive(error) {
  const message = error instanceof Error ? error.message : String(error);
  currentError = message;
  currentDetail = message;
  currentStatus = "error";
  currentPhase = "Failed";
  finished = true;
  streamEnabled = false;
  cleanupResources();
  await clearPendingStart();
  render();
  await persistState();
  stopBtn.disabled = true;
  log(`Error: ${message}`);
}

async function startLiveTranscription(payload) {
  options = payload;
  transcriptText = "";
  processedChunks = 0;
  pendingChunks = 0;
  streamedPackets = 0;
  sessionId = null;
  lastChunkText = "";
  currentError = "";
  stopRequested = false;
  finished = false;
  streamEnabled = false;
  startedAt = null;

  try {
    await setPhase("starting", "Connecting backend", "Validating Backend URL");
    currentBaseUrl = await ensureBackendAvailable(payload.settings);
    log(`Backend verified at ${currentBaseUrl}.`);

    await setPhase("starting", "Preparing audio", "Opening streaming audio pipeline");
    await buildAudioPipeline(payload.settings, payload.tabStreamId);

    await setPhase("starting", "Connecting stream", "Opening websocket to backend");
    await connectStreamingSocket(payload.settings);
    log("Live transcription started.");
  } catch (error) {
    await failLive(error);
  }
}

stopBtn.addEventListener("click", () => {
  void stopLiveTranscription();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STOP_LIVE_SIGNAL") {
    void stopLiveTranscription();
  }
});

window.addEventListener("beforeunload", () => {
  if (finished) {
    return;
  }

  const payload = {
    status: "error",
    phase: "Closed",
    startedAt: null,
    error: currentError || "Live transcription window was closed before completion.",
    sessionId,
    detail: "Live transcription window was closed before completion.",
    transcript: transcriptText,
    processedChunks,
    pendingChunks,
    lastChunkText,
    settings: options ? { ...options.settings } : undefined
  };
  void chrome.storage.local.set({ [LIVE_STATE_KEY]: payload });
  cleanupResources();
});

(async function init() {
  const stored = await chrome.storage.local.get([LIVE_PENDING_KEY, LIVE_STATE_KEY]);
  const pendingStart = stored[LIVE_PENDING_KEY] || null;

  if (!pendingStart) {
    const existingState = stored[LIVE_STATE_KEY] || null;
    if (existingState) {
      currentStatus = existingState.status || "idle";
      currentPhase = existingState.phase || "Idle";
      currentDetail = existingState.detail || "No live session";
      currentError = existingState.error || "";
      sessionId = existingState.sessionId || null;
      transcriptText = existingState.transcript || "";
      processedChunks = existingState.processedChunks || 0;
      pendingChunks = existingState.pendingChunks || 0;
      lastChunkText = existingState.lastChunkText || "";
      render();
      stopBtn.disabled = true;
      return;
    }

    await failLive(new Error("No live transcription request found. Start it from the popup."));
    return;
  }

  await startLiveTranscription(pendingStart);
})();