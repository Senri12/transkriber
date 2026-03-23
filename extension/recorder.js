const POLL_INTERVAL_MS = 1500;
const DEFAULT_BACKEND_URL = "http://127.0.0.1:8010";

const stateText = document.getElementById("stateText");
const detailText = document.getElementById("detailText");
const queueText = document.getElementById("queueText");
const timer = document.getElementById("timer");
const stopBtn = document.getElementById("stopBtn");
const logNode = document.getElementById("log");

let recorder = null;
let chunks = [];
let sourceStreams = [];
let audioContext = null;
let options = null;
let startedAt = null;
let timerInterval = null;
let latestJob = null;

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBackendUrl(rawUrl) {
  return (rawUrl || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, "");
}

function buildProcessingState(overrides = {}) {
  return {
    stage: "idle",
    detail: "No active processing",
    jobId: null,
    queuePosition: 0,
    queueSize: 0,
    jobsAhead: 0,
    activeJobId: null,
    ...overrides
  };
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

function renderRecorderStatus(status, phase, processing) {
  stateText.textContent = `${status}: ${phase}`;
  detailText.textContent = processing.detail || "No active processing";
  queueText.textContent = `Queue: ${formatQueue(processing)}`;
}

async function pushState(payload) {
  await chrome.runtime.sendMessage({
    type: "RECORDER_STATE",
    payload
  });
}

function setPhase(status, phase, error = "", processingPatch = {}) {
  const processing = buildProcessingState(processingPatch);
  renderRecorderStatus(status, phase, processing);

  if (status === "recording" && !timerInterval) {
    timerInterval = setInterval(() => {
      timer.textContent = formatDuration();
    }, 1000);
  }

  if (status !== "recording" && timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  void pushState({
    status,
    phase,
    error,
    startedAt,
    processing
  });
}

function getRecorderMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
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

async function buildMixedStream(settings, tabStreamId) {
  audioContext = new AudioContext();
  await audioContext.resume().catch(() => undefined);
  const destination = audioContext.createMediaStreamDestination();

  if (settings.useTab && tabStreamId) {
    const tabStream = await getTabStream(tabStreamId);
    sourceStreams.push(tabStream);
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    tabSource.connect(destination);

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
    micSource.connect(destination);
    log("Microphone connected.");
  }

  if (!sourceStreams.length) {
    throw new Error("No audio sources were initialized.");
  }

  return destination.stream;
}

async function saveRecording(blob, settings) {
  const filename = new Date().toISOString().replaceAll(":", "-");
  const objectUrl = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url: objectUrl,
    filename: `${settings.saveDirectory}/${filename}.webm`,
    saveAs: false
  });
  setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
  log("Recording saved to downloads.");
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

async function createJob(blob, settings, baseUrl) {
  const formData = new FormData();
  formData.append("file", blob, "meeting.webm");
  formData.append("language", settings.language);
  formData.append("whisper_model", settings.whisperModel);
  formData.append("ollama_model", settings.ollamaModel);

  const response = await fetch(`${baseUrl}/jobs`, {
    method: "POST",
    body: formData
  });

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Endpoint ${baseUrl}/jobs was not found. Restart the backend from the current project version.`);
    }
    throw new Error(formatHttpError(payload, response.status));
  }

  return payload;
}

async function fetchJobStatus(jobId, baseUrl) {
  const response = await fetch(`${baseUrl}/jobs/${jobId}`);
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Endpoint ${baseUrl}/jobs/${jobId} was not found. Restart the backend from the current project version.`);
    }
    throw new Error(formatHttpError(payload, response.status));
  }
  return payload;
}

function jobToProcessingState(job) {
  return buildProcessingState({
    stage: job.stage || job.status,
    detail: job.detail || "",
    jobId: job.job_id || null,
    queuePosition: job.queue_position || 0,
    queueSize: job.queue_size || 0,
    jobsAhead: job.jobs_ahead || 0,
    activeJobId: job.active_job_id || null
  });
}

function phaseFromJob(job) {
  if (job.status === "queued") {
    return "Queued";
  }
  if (job.stage === "transcribing") {
    return "Transcribing";
  }
  if (job.stage === "analyzing") {
    return "Analyzing";
  }
  if (job.stage === "completed") {
    return "Completed";
  }
  if (job.stage === "failed") {
    return "Failed";
  }
  return job.stage || job.status || "Processing";
}

async function pollJob(jobId, baseUrl) {
  let previousLogKey = "";

  while (true) {
    const job = await fetchJobStatus(jobId, baseUrl);
    latestJob = job;
    const processing = jobToProcessingState(job);
    const phase = phaseFromJob(job);
    setPhase("processing", phase, "", processing);

    const logKey = `${job.stage}:${job.queue_position}:${job.queue_size}:${job.jobs_ahead}`;
    if (logKey !== previousLogKey) {
      log(`Job ${job.job_id.slice(0, 8)} stage=${job.stage} queue=${formatQueue(processing)}`);
      previousLogKey = logKey;
    }

    if (job.status === "completed") {
      return job;
    }

    if (job.status === "failed") {
      throw new Error(job.error || "Processing failed.");
    }

    await wait(POLL_INTERVAL_MS);
  }
}

function cleanupMedia() {
  for (const stream of sourceStreams) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
  sourceStreams = [];

  if (audioContext) {
    void audioContext.close();
    audioContext = null;
  }

  recorder = null;
  options = null;
  startedAt = null;
}

async function finalizeRecording() {
  const settings = options.settings;
  const mimeType = recorder && recorder.mimeType ? recorder.mimeType : "audio/webm";
  const blob = new Blob(chunks, { type: mimeType });
  chunks = [];

  try {
    setPhase("processing", "Saving recording", "", {
      stage: "saving",
      detail: "Saving local recording"
    });
    await saveRecording(blob, settings);

    if (!settings.autoProcess) {
      await chrome.runtime.sendMessage({
        type: "RECORDING_FINISHED",
        payload: {
          status: "done",
          phase: "Saved locally",
          error: "",
          startedAt: null,
          processing: buildProcessingState({
            stage: "saved",
            detail: "Recording saved locally"
          }),
          lastResult: {
            transcript: "",
            segments: [],
            analysis: null
          }
        }
      });

      stateText.textContent = "done: saved locally";
      detailText.textContent = "Recording saved locally";
      queueText.textContent = "Queue: -";
      timer.textContent = "00:00";
      return;
    }

    setPhase("processing", "Connecting backend", "", {
      stage: "backend-check",
      detail: "Validating Backend URL"
    });
    const baseUrl = await ensureBackendAvailable(settings);
    log(`Backend verified at ${baseUrl}.`);

    setPhase("processing", "Uploading", "", {
      stage: "uploading",
      detail: `Uploading audio to ${baseUrl}`
    });
    const createdJob = await createJob(blob, settings, baseUrl);
    latestJob = createdJob;
    const createdProcessing = jobToProcessingState(createdJob);
    setPhase("processing", phaseFromJob(createdJob), "", createdProcessing);
    log(`Job ${createdJob.job_id.slice(0, 8)} created, queue=${formatQueue(createdProcessing)}`);

    const finalJob = await pollJob(createdJob.job_id, baseUrl);
    const finalProcessing = jobToProcessingState(finalJob);

    await chrome.runtime.sendMessage({
      type: "RECORDING_FINISHED",
      payload: {
        status: "done",
        phase: "Completed",
        error: "",
        startedAt: null,
        processing: finalProcessing,
        lastResult: finalJob.result
      }
    });

    stateText.textContent = "done: completed";
    detailText.textContent = finalProcessing.detail || "Transcript and analysis are ready";
    queueText.textContent = "Queue: -";
    timer.textContent = "00:00";
  } catch (error) {
    log(`Error: ${error.message}`);
    const processing = latestJob
      ? buildProcessingState({
          ...jobToProcessingState(latestJob),
          stage: "failed",
          detail: error.message
        })
      : buildProcessingState({
          stage: "failed",
          detail: error.message
        });

    await chrome.runtime.sendMessage({
      type: "RECORDING_FINISHED",
      payload: {
        status: "error",
        phase: "Failed",
        error: error.message,
        startedAt: null,
        processing
      }
    });
    stateText.textContent = `error: ${error.message}`;
    detailText.textContent = error.message;
    queueText.textContent = `Queue: ${formatQueue(processing)}`;
  } finally {
    cleanupMedia();
  }
}

async function stopRecording() {
  if (!recorder || recorder.state !== "recording") {
    return;
  }
  setPhase("processing", "Finalizing capture", "", {
    stage: "finalizing",
    detail: "Stopping the recorder and assembling the file"
  });
  recorder.stop();
}

async function failRecording(error) {
  cleanupMedia();
  const processing = buildProcessingState({
    stage: "failed",
    detail: error.message
  });
  await chrome.runtime.sendMessage({
    type: "RECORDING_FINISHED",
    payload: {
      status: "error",
      phase: "Failed",
      error: error.message,
      startedAt: null,
      processing
    }
  });
  stateText.textContent = `error: ${error.message}`;
  detailText.textContent = error.message;
  queueText.textContent = "Queue: -";
  timer.textContent = "00:00";
  log(`Error: ${error.message}`);
}

async function startRecording(payload) {
  if (recorder && recorder.state === "recording") {
    return;
  }

  try {
    options = payload;
    latestJob = null;
    chunks = [];
    log("Initializing audio capture.");

    const stream = await buildMixedStream(payload.settings, payload.tabStreamId);
    const mimeType = getRecorderMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", () => {
      void finalizeRecording();
    });

    startedAt = Date.now();
    timer.textContent = "00:00";
    recorder.start(1000);
    setPhase("recording", "Recording", "", {
      stage: "capturing",
      detail: "Capturing microphone and tab audio"
    });
    log("Recording started.");
  } catch (error) {
    await failRecording(error);
  }
}

stopBtn.addEventListener("click", () => {
  void stopRecording();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STOP_RECORDING_SIGNAL") {
    void stopRecording();
  }
});

(async function init() {
  const response = await chrome.runtime.sendMessage({ type: "RECORDER_READY" });
  if (response && response.payload) {
    await startRecording(response.payload);
  }
})();
