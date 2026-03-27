const statusLine = document.getElementById("statusLine");
const timer = document.getElementById("timer");
const result = document.getElementById("result");
const pipeline = document.getElementById("pipeline");
const pipelineStage = document.getElementById("pipelineStage");
const pipelineDetail = document.getElementById("pipelineDetail");
const pipelineQueue = document.getElementById("pipelineQueue");
const pipelineJob = document.getElementById("pipelineJob");

const liveStatusLine = document.getElementById("liveStatusLine");
const liveTimer = document.getElementById("liveTimer");
const liveDetail = document.getElementById("liveDetail");
const liveResult = document.getElementById("liveResult");
const liveStartBtn = document.getElementById("liveStartBtn");
const liveStopBtn = document.getElementById("liveStopBtn");

const uploadStatusLine = document.getElementById("uploadStatusLine");
const uploadDetail = document.getElementById("uploadDetail");
const uploadResult = document.getElementById("uploadResult");
const audioFileInput = document.getElementById("audioFile");
const transcribeFileBtn = document.getElementById("transcribeFileBtn");

const LIVE_STATE_KEY = "liveSessionState";
const LIVE_PENDING_KEY = "livePendingStart";

const fields = {
  useMic: document.getElementById("useMic"),
  useTab: document.getElementById("useTab"),
  autoProcess: document.getElementById("autoProcess"),
  backendUrl: document.getElementById("backendUrl"),
  language: document.getElementById("language"),
  whisperModel: document.getElementById("whisperModel"),
  ollamaModel: document.getElementById("ollamaModel"),
  saveDirectory: document.getElementById("saveDirectory")
};

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const defaultLiveState = {
  status: "idle",
  phase: "",
  startedAt: null,
  error: "",
  sessionId: null,
  detail: "No live transcription",
  transcript: "",
  processedChunks: 0,
  pendingChunks: 0,
  lastChunkText: "",
  settings: {
    useMic: true,
    useTab: true,
    backendUrl: "http://127.0.0.1:8010",
    language: "ru",
    whisperModel: "large-v3"
  }
};

const defaultUploadState = {
  status: "idle",
  detail: "No file selected",
  error: "",
  fileName: "",
  result: null
};

let currentState = null;
let currentLiveState = { ...defaultLiveState, settings: { ...defaultLiveState.settings } };
let currentUploadState = { ...defaultUploadState };
let timerInterval = null;
let liveTimerInterval = null;

function normalizeLiveState(rawState) {
  return {
    ...defaultLiveState,
    ...(rawState || {}),
    settings: {
      ...defaultLiveState.settings,
      ...(rawState && rawState.settings ? rawState.settings : {})
    }
  };
}

function normalizeUploadState(rawState) {
  return {
    ...defaultUploadState,
    ...(rawState || {})
  };
}

function formatDuration(startedAt) {
  if (!startedAt) {
    return "00:00";
  }

  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutesPart = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secondsPart = String(seconds % 60).padStart(2, "0");
  return `${minutesPart}:${secondsPart}`;
}

function formatAudioDuration(durationSeconds) {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return "n/a";
  }

  const totalSeconds = Math.max(0, Math.round(durationSeconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizeBackendUrl(rawUrl) {
  return (rawUrl || "http://127.0.0.1:8010").trim().replace(/\/+$/, "");
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

  if (!payload || typeof payload !== "object" || !("whisper_model" in payload) || !("ollama_model" in payload)) {
    const foreignHint = payload && typeof payload === "object" && payload.model
      ? ` Another service is responding there (model=${payload.model}).`
      : "";
    throw new Error(
      `Backend at ${baseUrl} is not Local AI Meeting Recorder API.${foreignHint} Change Backend URL or restart this project's FastAPI server.`
    );
  }

  return baseUrl;
}

function formatQueue(processing) {
  if (!processing || !processing.queueSize) {
    return "-";
  }

  if (processing.queuePosition > 0) {
    return `${processing.queuePosition}/${processing.queueSize} (${processing.jobsAhead} ahead)`;
  }

  if (processing.activeJobId) {
    return `active, total ${processing.queueSize}`;
  }

  return `total ${processing.queueSize}`;
}

function isRecorderBusy(state) {
  return Boolean(state) && ["starting", "recording", "processing"].includes(state.status);
}

function isLiveBusy(state) {
  return Boolean(state) && ["starting", "recording", "processing", "stopping"].includes(state.status);
}

function isUploadBusy(state) {
  return Boolean(state) && ["checking", "uploading", "transcribing"].includes(state.status);
}

function renderProcessing(state) {
  const processing = state.processing || {};
  const hasActiveState = processing.stage && processing.stage !== "idle";

  pipelineStage.textContent = processing.stage || "idle";
  pipelineDetail.textContent = processing.detail || "No active processing";
  pipelineQueue.textContent = formatQueue(processing);
  pipelineJob.textContent = processing.jobId ? processing.jobId.slice(0, 8) : "-";
  pipeline.classList.toggle("empty", !hasActiveState);
}

function renderResult(state) {
  const analysis = state.lastResult && state.lastResult.analysis ? state.lastResult.analysis : null;
  const transcript = state.lastResult ? state.lastResult.transcript : "";

  if (!analysis && !transcript) {
    result.textContent = "No results yet";
    result.classList.add("empty");
    return;
  }

  const lines = [];
  if (analysis && analysis.summary) {
    lines.push(`Summary:\n${analysis.summary}`);
  }
  if (analysis && analysis.decisions && analysis.decisions.length) {
    lines.push(`Decisions:\n- ${analysis.decisions.join("\n- ")}`);
  }
  if (analysis && analysis.action_items && analysis.action_items.length) {
    lines.push(
      "Action items:\n- " +
        analysis.action_items
          .map((item) => `${item.task} | owner: ${item.owner || "n/a"} | deadline: ${item.deadline || "n/a"}`)
          .join("\n- ")
    );
  }
  if (!analysis && transcript) {
    lines.push(`Transcript:\n${transcript}`);
  }

  result.textContent = lines.join("\n\n");
  result.classList.remove("empty");
}

function renderLiveResult(state) {
  const transcript = (state.transcript || "").trim();
  if (!transcript) {
    liveResult.textContent = "No transcript yet";
    liveResult.classList.add("empty");
    return;
  }

  const preview = transcript.length > 1400 ? `...${transcript.slice(-1400)}` : transcript;
  liveResult.textContent = preview;
  liveResult.classList.remove("empty");
}

function renderUploadResult(state) {
  const payload = state.result;
  if (!payload) {
    uploadResult.textContent = "No transcript yet";
    uploadResult.classList.add("empty");
    return;
  }

  const transcript = (payload.transcript || "").trim();
  const lines = [`File: ${state.fileName || payload.file_name || "n/a"}`];

  lines.push(`Language: ${payload.language || "auto"}`);
  if (typeof payload.duration === "number") {
    lines.push(`Duration: ${formatAudioDuration(payload.duration)}`);
  }
  lines.push("");
  lines.push(`Transcript:\n${transcript || "No speech detected."}`);

  uploadResult.textContent = lines.join("\n");
  uploadResult.classList.remove("empty");
}

function syncForm(state) {
  const settings = state.settings || {};
  fields.useMic.checked = Boolean(settings.useMic);
  fields.useTab.checked = Boolean(settings.useTab);
  fields.autoProcess.checked = Boolean(settings.autoProcess);
  fields.backendUrl.value = settings.backendUrl || "http://127.0.0.1:8010";
  fields.language.value = settings.language || "ru";
  fields.whisperModel.value = settings.whisperModel || "large-v3";
  fields.ollamaModel.value = settings.ollamaModel || "mistral:7b";
  fields.saveDirectory.value = settings.saveDirectory || "recordings";
}

function applyActionState() {
  const recorderBusy = isRecorderBusy(currentState);
  const liveBusy = isLiveBusy(currentLiveState);
  const uploadBusy = isUploadBusy(currentUploadState);
  const isRecording = currentState && currentState.status === "recording";
  const hasSelectedFile = Boolean(audioFileInput.files && audioFileInput.files.length);

  startBtn.disabled = recorderBusy || liveBusy || uploadBusy;
  stopBtn.disabled = !isRecording;
  liveStartBtn.disabled = recorderBusy || liveBusy || uploadBusy;
  liveStopBtn.disabled = !liveBusy;
  transcribeFileBtn.disabled = recorderBusy || liveBusy || uploadBusy || !hasSelectedFile;
  audioFileInput.disabled = recorderBusy || liveBusy || uploadBusy;
}

function render(state) {
  currentState = state;
  syncForm(state);
  const isRecording = state.status === "recording";

  statusLine.textContent = state.phase ? `${state.status}: ${state.phase}` : state.status;
  statusLine.className = `status ${state.status}`;
  if (state.status === "error" && state.error) {
    statusLine.textContent = `error: ${state.error}`;
  }

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  timer.textContent = formatDuration(state.startedAt);
  if (isRecording) {
    timerInterval = setInterval(() => {
      timer.textContent = formatDuration(state.startedAt);
    }, 1000);
  }

  renderProcessing(state);
  renderResult(state);
  applyActionState();
}

function renderLive(state) {
  currentLiveState = normalizeLiveState(state);
  const liveBusy = isLiveBusy(currentLiveState);

  liveStatusLine.textContent = currentLiveState.phase
    ? `${currentLiveState.status}: ${currentLiveState.phase}`
    : currentLiveState.status;
  liveStatusLine.className = `status ${currentLiveState.status}`;
  if (currentLiveState.status === "error" && currentLiveState.error) {
    liveStatusLine.textContent = `error: ${currentLiveState.error}`;
  }

  const stats = `Chunks processed: ${currentLiveState.processedChunks || 0}, pending: ${currentLiveState.pendingChunks || 0}`;
  liveDetail.textContent = currentLiveState.detail ? `${currentLiveState.detail}. ${stats}` : stats;

  if (liveTimerInterval) {
    clearInterval(liveTimerInterval);
    liveTimerInterval = null;
  }

  liveTimer.textContent = formatDuration(currentLiveState.startedAt);
  if (liveBusy && currentLiveState.startedAt) {
    liveTimerInterval = setInterval(() => {
      liveTimer.textContent = formatDuration(currentLiveState.startedAt);
    }, 1000);
  }

  renderLiveResult(currentLiveState);
  applyActionState();
}

function renderUpload(state) {
  currentUploadState = normalizeUploadState(state);
  let label = currentUploadState.status;

  if (currentUploadState.status === "idle") {
    label = "Idle";
  } else if (currentUploadState.status === "ready") {
    label = "ready: file selected";
  } else if (currentUploadState.status === "done") {
    label = "done: transcript ready";
  } else if (currentUploadState.fileName) {
    label = `${currentUploadState.status}: ${currentUploadState.fileName}`;
  }

  uploadStatusLine.textContent = label;
  uploadStatusLine.className = `status ${currentUploadState.status}`;
  if (currentUploadState.status === "error" && currentUploadState.error) {
    uploadStatusLine.textContent = `error: ${currentUploadState.error}`;
  }

  uploadDetail.textContent = currentUploadState.detail || "No file selected";
  renderUploadResult(currentUploadState);
  applyActionState();
}

function getSettings() {
  return {
    useMic: fields.useMic.checked,
    useTab: fields.useTab.checked,
    autoProcess: fields.autoProcess.checked,
    backendUrl: fields.backendUrl.value.trim() || "http://127.0.0.1:8010",
    language: fields.language.value,
    whisperModel: fields.whisperModel.value.trim() || "large-v3",
    ollamaModel: fields.ollamaModel.value.trim() || "mistral:7b",
    saveDirectory: fields.saveDirectory.value.trim() || "recordings"
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number") {
    throw new Error("Active tab is not available.");
  }
  return tab;
}

async function startRecording() {
  if (isLiveBusy(currentLiveState)) {
    throw new Error("Live transcription is already in progress.");
  }
  if (isUploadBusy(currentUploadState)) {
    throw new Error("Audio file transcription is already in progress.");
  }

  const settings = getSettings();
  if (!settings.useMic && !settings.useTab) {
    render({
      ...(currentState || {}),
      status: "error",
      error: "Select at least one audio source.",
      settings
    });
    return;
  }

  const activeTab = await getActiveTab();
  let tabStreamId = null;
  if (settings.useTab) {
    tabStreamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
  }

  const response = await chrome.runtime.sendMessage({
    type: "START_RECORDING",
    payload: {
      tabStreamId,
      targetTabId: activeTab.id,
      settings
    }
  });

  if (!response.ok) {
    throw new Error(response.error || "Failed to start recording.");
  }
}

async function startLiveTranscription() {
  if (isRecorderBusy(currentState)) {
    throw new Error("Recording is already in progress.");
  }
  if (isLiveBusy(currentLiveState)) {
    throw new Error("Live transcription is already in progress.");
  }
  if (isUploadBusy(currentUploadState)) {
    throw new Error("Audio file transcription is already in progress.");
  }

  const settings = getSettings();
  if (!settings.useMic && !settings.useTab) {
    renderLive({
      ...currentLiveState,
      status: "error",
      error: "Select at least one audio source.",
      settings
    });
    return;
  }

  const activeTab = await getActiveTab();
  let tabStreamId = null;
  if (settings.useTab) {
    tabStreamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
  }

  const livePayload = {
    tabStreamId,
    targetTabId: activeTab.id,
    settings: {
      useMic: settings.useMic,
      useTab: settings.useTab,
      backendUrl: settings.backendUrl,
      language: settings.language,
      whisperModel: settings.whisperModel
    }
  };

  const nextLiveState = normalizeLiveState({
    status: "starting",
    phase: "Preparing live transcription",
    startedAt: null,
    error: "",
    sessionId: null,
    detail: "Opening live transcription window",
    transcript: "",
    processedChunks: 0,
    pendingChunks: 0,
    lastChunkText: "",
    settings: livePayload.settings
  });

  await chrome.storage.local.set({
    [LIVE_PENDING_KEY]: livePayload,
    [LIVE_STATE_KEY]: nextLiveState
  });
  renderLive(nextLiveState);

  await chrome.windows.create({
    url: chrome.runtime.getURL("live.html"),
    type: "popup",
    width: 760,
    height: 840
  });
}

async function transcribeSelectedFile() {
  if (isRecorderBusy(currentState)) {
    throw new Error("Recording is already in progress.");
  }
  if (isLiveBusy(currentLiveState)) {
    throw new Error("Live transcription is already in progress.");
  }
  if (isUploadBusy(currentUploadState)) {
    return;
  }

  const [file] = audioFileInput.files || [];
  if (!file) {
    renderUpload({
      status: "error",
      error: "Choose an audio file first.",
      detail: "No file selected",
      fileName: "",
      result: null
    });
    return;
  }

  const settings = getSettings();
  renderUpload({
    status: "checking",
    detail: `Validating backend connection for ${file.name}`,
    error: "",
    fileName: file.name,
    result: null
  });

  try {
    const baseUrl = await ensureBackendAvailable(settings);
    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append("language", settings.language);
    formData.append("whisper_model", settings.whisperModel);

    renderUpload({
      status: "uploading",
      detail: `Sending ${file.name} to ${baseUrl}`,
      error: "",
      fileName: file.name,
      result: null
    });

    const responsePromise = fetch(`${baseUrl}/transcribe`, {
      method: "POST",
      body: formData
    });

    renderUpload({
      status: "transcribing",
      detail: `Waiting for Whisper to finish ${file.name}`,
      error: "",
      fileName: file.name,
      result: null
    });

    const response = await responsePromise;
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Endpoint ${baseUrl}/transcribe was not found. Restart the backend from the current project version.`);
      }
      throw new Error(formatHttpError(payload, response.status));
    }

    renderUpload({
      status: "done",
      detail: `Transcript is ready for ${file.name}`,
      error: "",
      fileName: file.name,
      result: payload
    });
  } catch (error) {
    renderUpload({
      status: "error",
      detail: error.message,
      error: error.message,
      fileName: file.name,
      result: null
    });
  }
}

startBtn.addEventListener("click", async () => {
  try {
    await startRecording();
  } catch (error) {
    render({
      ...(currentState || {}),
      status: "error",
      error: error.message
    });
  }
});

stopBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_RECORDING_REQUEST" });
});

liveStartBtn.addEventListener("click", async () => {
  try {
    await startLiveTranscription();
  } catch (error) {
    renderLive({
      ...currentLiveState,
      status: "error",
      error: error.message
    });
  }
});

liveStopBtn.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "STOP_LIVE_SIGNAL" });
  } catch (error) {
    renderLive({
      ...currentLiveState,
      status: "error",
      error: error.message
    });
  }
});

transcribeFileBtn.addEventListener("click", async () => {
  try {
    await transcribeSelectedFile();
  } catch (error) {
    renderUpload({
      ...currentUploadState,
      status: "error",
      detail: error.message,
      error: error.message
    });
  }
});

audioFileInput.addEventListener("change", () => {
  const [file] = audioFileInput.files || [];
  if (!file) {
    renderUpload(defaultUploadState);
    return;
  }

  renderUpload({
    status: "ready",
    detail: `Ready to transcribe ${file.name}`,
    error: "",
    fileName: file.name,
    result: null
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE_CHANGED") {
    render(message.payload);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes[LIVE_STATE_KEY]) {
    renderLive(changes[LIVE_STATE_KEY].newValue || defaultLiveState);
  }
});

(async function init() {
  const [state, liveStorage] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_STATE" }),
    chrome.storage.local.get([LIVE_STATE_KEY])
  ]);

  render(state);
  renderLive(liveStorage[LIVE_STATE_KEY] || defaultLiveState);
  renderUpload(defaultUploadState);
})();
