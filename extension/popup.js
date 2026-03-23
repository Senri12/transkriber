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

let currentState = null;
let currentLiveState = { ...defaultLiveState, settings: { ...defaultLiveState.settings } };
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

function formatDuration(startedAt) {
  if (!startedAt) {
    return "00:00";
  }

  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutesPart = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secondsPart = String(seconds % 60).padStart(2, "0");
  return `${minutesPart}:${secondsPart}`;
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
  const isRecording = currentState && currentState.status === "recording";

  startBtn.disabled = recorderBusy || liveBusy;
  stopBtn.disabled = !isRecording;
  liveStartBtn.disabled = recorderBusy || liveBusy;
  liveStopBtn.disabled = !liveBusy;
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
})();