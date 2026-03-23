const defaultProcessing = {
  stage: "idle",
  detail: "No active processing",
  jobId: null,
  queuePosition: 0,
  queueSize: 0,
  jobsAhead: 0,
  activeJobId: null
};

const defaultState = {
  status: "idle",
  phase: "",
  startedAt: null,
  error: "",
  recorderTabId: null,
  recorderWindowId: null,
  targetTabId: null,
  settings: {
    useMic: true,
    useTab: true,
    autoProcess: true,
    backendUrl: "http://127.0.0.1:8010",
    language: "ru",
    whisperModel: "large-v3",
    ollamaModel: "mistral:7b",
    saveDirectory: "recordings"
  },
  processing: { ...defaultProcessing },
  lastResult: null
};

let state = { ...defaultState, settings: { ...defaultState.settings }, processing: { ...defaultProcessing } };
let pendingStart = null;

function normalizeState(rawState) {
  return {
    ...defaultState,
    ...rawState,
    settings: { ...defaultState.settings, ...(rawState && rawState.settings ? rawState.settings : {}) },
    processing: { ...defaultProcessing, ...(rawState && rawState.processing ? rawState.processing : {}) }
  };
}

async function loadState() {
  const stored = await chrome.storage.local.get(["recorderState", "pendingStart"]);
  if (stored.recorderState) {
    state = normalizeState(stored.recorderState);
  }
  pendingStart = stored.pendingStart || null;
}

async function persistState() {
  await chrome.storage.local.set({ recorderState: state });
}

async function persistPendingStart() {
  await chrome.storage.local.set({ pendingStart });
}

async function broadcastState() {
  await persistState();
  try {
    await chrome.runtime.sendMessage({ type: "STATE_CHANGED", payload: state });
  } catch (error) {
    void error;
  }
}

async function updateState(patch) {
  state = normalizeState({
    ...state,
    ...patch,
    settings: patch.settings ? { ...state.settings, ...patch.settings } : state.settings,
    processing: patch.processing ? { ...state.processing, ...patch.processing } : state.processing
  });
  await broadcastState();
}

async function openRecorderWindow() {
  const url = chrome.runtime.getURL("recorder.html");
  const windowInfo = await chrome.windows.create({
    url,
    type: "popup",
    width: 460,
    height: 760
  });

  const tabId = windowInfo.tabs && windowInfo.tabs[0] ? windowInfo.tabs[0].id : null;
  await updateState({
    recorderWindowId: windowInfo.id ?? null,
    recorderTabId: tabId
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void loadState();
});

chrome.runtime.onStartup.addListener(() => {
  void loadState();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== state.recorderTabId) {
    return;
  }

  const wasActive = state.status === "recording" || state.status === "processing";
  state = normalizeState({
    ...state,
    recorderTabId: null,
    recorderWindowId: null,
    status: wasActive ? "error" : "idle",
    phase: "",
    error: wasActive ? "Recorder window was closed before completion." : "",
    processing: wasActive
      ? {
          stage: "failed",
          detail: "Recorder window was closed before completion."
        }
      : { ...defaultProcessing }
  });
  pendingStart = null;
  void persistPendingStart();
  void broadcastState();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    await loadState();

    if (message.type === "GET_STATE") {
      sendResponse(state);
      return;
    }

    if (message.type === "START_RECORDING") {
      if (["starting", "recording", "processing"].includes(state.status)) {
        sendResponse({ ok: false, error: "Recording is already in progress." });
        return;
      }

      pendingStart = message.payload;
      await persistPendingStart();
      await updateState({
        status: "starting",
        phase: "Preparing recorder",
        error: "",
        lastResult: null,
        targetTabId: message.payload.targetTabId,
        settings: { ...message.payload.settings },
        processing: {
          stage: "starting",
          detail: "Opening recorder window"
        }
      });
      await openRecorderWindow();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "RECORDER_READY") {
      const recorderTabId = sender.tab ? sender.tab.id : null;
      await updateState({ recorderTabId });
      sendResponse({ ok: true, payload: pendingStart });
      return;
    }

    if (message.type === "RECORDER_STATE") {
      await updateState(message.payload);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "STOP_RECORDING_REQUEST") {
      if (state.recorderTabId) {
        await chrome.runtime.sendMessage({ type: "STOP_RECORDING_SIGNAL" });
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "RECORDING_FINISHED") {
      pendingStart = null;
      await persistPendingStart();
      await updateState(message.payload);
      sendResponse({ ok: true });
      return;
    }
  })();

  return true;
});
