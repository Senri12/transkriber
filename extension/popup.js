const statusLine = document.getElementById("statusLine");
const timer = document.getElementById("timer");
const result = document.getElementById("result");
const pipeline = document.getElementById("pipeline");
const pipelineStage = document.getElementById("pipelineStage");
const pipelineDetail = document.getElementById("pipelineDetail");
const pipelineQueue = document.getElementById("pipelineQueue");
const pipelineJob = document.getElementById("pipelineJob");

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

let currentState = null;
let timerInterval = null;

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

function render(state) {
  currentState = state;
  syncForm(state);
  const isRecording = state.status === "recording";
  const isBusy = isRecording || state.status === "processing" || state.status === "starting";

  statusLine.textContent = state.phase ? `${state.status}: ${state.phase}` : state.status;
  statusLine.className = `status ${state.status}`;
  if (state.status === "error" && state.error) {
    statusLine.textContent = `error: ${state.error}`;
  }

  startBtn.disabled = isBusy;
  stopBtn.disabled = !isRecording;

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

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE_CHANGED") {
    render(message.payload);
  }
});

(async function init() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  render(state);
})();
