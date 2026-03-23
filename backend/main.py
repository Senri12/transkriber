from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.ollama import DEFAULT_MODEL as DEFAULT_OLLAMA_MODEL
from backend.ollama import analyze_transcript
from backend.stt import DEFAULT_MODEL as DEFAULT_WHISPER_MODEL
from backend.stt import transcribe_array, transcribe_file

APP_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = APP_ROOT / "data"
UPLOAD_DIR = DATA_ROOT / "uploads"
TRANSCRIPT_DIR = DATA_ROOT / "transcripts"
ANALYSIS_DIR = DATA_ROOT / "analysis"
LIVE_TARGET_SAMPLE_RATE = 16000
LIVE_MIN_PROCESS_SECONDS = 1.0
LIVE_STEP_SECONDS = 2.0
LIVE_MAX_WINDOW_SECONDS = 12.0

for directory in (UPLOAD_DIR, TRANSCRIPT_DIR, ANALYSIS_DIR):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Local AI Meeting Recorder API", version="0.4.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

JOB_LOCK = asyncio.Lock()
JOB_QUEUE: asyncio.Queue[str] = asyncio.Queue()
JOB_ORDER: list[str] = []
JOBS: dict[str, dict] = {}
ACTIVE_JOB_ID: str | None = None
WORKER_TASK: asyncio.Task | None = None
LIVE_LOCK = asyncio.Lock()
LIVE_SESSIONS: dict[str, dict[str, Any]] = {}


class AnalyzeRequest(BaseModel):
    transcript: str = Field(..., min_length=1)
    model: str = Field(default=DEFAULT_OLLAMA_MODEL)


class AnalyzeResponse(BaseModel):
    summary: str
    decisions: list[str]
    action_items: list[dict[str, str]]
    open_questions: list[str]


class ProcessResponse(BaseModel):
    transcript: str
    language: str | None
    duration: float | None
    segments: list[dict]
    analysis: AnalyzeResponse


def _timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _persist_json(target: Path, payload: dict) -> None:
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


async def _save_upload(file: UploadFile) -> Path:
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    safe_name = f"{_timestamp()}-{uuid4().hex[:8]}{suffix}"
    target = UPLOAD_DIR / safe_name
    content = await file.read()
    target.write_bytes(content)
    return target


def _normalize_language(language: str | None) -> str | None:
    if language in (None, "", "auto"):
        return None
    return language


def _prompt_tail(transcript: str, max_chars: int = 240) -> str | None:
    normalized = transcript.strip()
    if not normalized:
        return None
    return normalized[-max_chars:]


def _normalize_text(text: str) -> str:
    return " ".join(text.split()).strip()


def _merge_transcript(existing: str, candidate: str) -> tuple[str, str]:
    existing_clean = _normalize_text(existing)
    candidate_clean = _normalize_text(candidate)

    if not candidate_clean:
        return existing_clean, ""
    if not existing_clean:
        return candidate_clean, candidate_clean

    lower_existing = existing_clean.lower()
    lower_candidate = candidate_clean.lower()
    max_overlap = min(len(lower_existing), len(lower_candidate), 280)
    best_overlap = 0

    for size in range(max_overlap, 0, -1):
        if lower_existing.endswith(lower_candidate[:size]):
            best_overlap = size
            break

    delta = candidate_clean[best_overlap:].lstrip(" ,.;:!?-")
    if not delta:
        return existing_clean, ""

    return f"{existing_clean} {delta}".strip(), delta


def _pcm16le_to_float32(payload: bytes) -> np.ndarray:
    if not payload:
        return np.empty(0, dtype=np.float32)
    pcm = np.frombuffer(payload, dtype="<i2")
    return pcm.astype(np.float32) / 32768.0


def _resample_audio(audio: np.ndarray, source_rate: int, target_rate: int = LIVE_TARGET_SAMPLE_RATE) -> np.ndarray:
    if audio.size == 0:
        return np.empty(0, dtype=np.float32)
    if source_rate == target_rate:
        return np.asarray(audio, dtype=np.float32)

    target_length = max(1, int(round(audio.size * target_rate / source_rate)))
    source_positions = np.arange(audio.size, dtype=np.float32)
    target_positions = np.linspace(0, audio.size - 1, num=target_length, dtype=np.float32)
    return np.interp(target_positions, source_positions, audio).astype(np.float32)


def _queue_metrics(job_id: str) -> dict:
    queued_ids = [candidate for candidate in JOB_ORDER if JOBS.get(candidate, {}).get("status") == "queued"]
    active_exists = ACTIVE_JOB_ID is not None and JOBS.get(ACTIVE_JOB_ID, {}).get("status") == "processing"
    queue_size = len(queued_ids) + (1 if active_exists else 0)

    if JOBS[job_id]["status"] == "queued":
        queue_index = queued_ids.index(job_id)
        jobs_ahead = queue_index + (1 if active_exists else 0)
        queue_position = jobs_ahead + 1
    else:
        queue_position = 0
        jobs_ahead = 0

    return {
        "queue_position": queue_position,
        "queue_size": queue_size,
        "jobs_ahead": jobs_ahead,
        "active_job_id": ACTIVE_JOB_ID,
    }


def _job_snapshot(job_id: str) -> dict:
    job = JOBS[job_id]
    return {
        "job_id": job_id,
        "status": job["status"],
        "stage": job["stage"],
        "detail": job["detail"],
        "created_at": job["created_at"],
        "started_at": job.get("started_at"),
        "updated_at": job["updated_at"],
        "completed_at": job.get("completed_at"),
        "source_file": job["source_file"],
        "result": job.get("result"),
        "error": job.get("error"),
        **_queue_metrics(job_id),
    }


async def _update_job(job_id: str, **patch) -> dict:
    async with JOB_LOCK:
        job = JOBS[job_id]
        job.update(patch)
        job["updated_at"] = _iso_now()
        return _job_snapshot(job_id)


def _store_transcription(upload_path: Path, result: dict) -> None:
    transcript_stub = TRANSCRIPT_DIR / f"{upload_path.stem}.json"
    _persist_json(transcript_stub, {"source_file": str(upload_path), **result})

    transcript_text = TRANSCRIPT_DIR / f"{upload_path.stem}.txt"
    transcript_text.write_text(result["transcript"], encoding="utf-8")


def _live_snapshot(session_id: str) -> dict:
    session = LIVE_SESSIONS[session_id]
    received_samples = len(session["pcm_buffer"]) // 2
    received_seconds = received_samples / session["stream_sample_rate"] if session["stream_sample_rate"] else 0.0
    return {
        "session_id": session_id,
        "status": session["status"],
        "detail": session["detail"],
        "created_at": session["created_at"],
        "updated_at": session["updated_at"],
        "completed_at": session.get("completed_at"),
        "language": session.get("detected_language") or session["language_hint"],
        "requested_language": session["language_hint"],
        "whisper_model": session["whisper_model"],
        "device": session["device"],
        "chunks_processed": session["chunks_processed"],
        "transcript": session["transcript"],
        "last_chunk_text": session["last_chunk_text"],
        "last_duration": session["last_duration"],
        "stream_sample_rate": session["stream_sample_rate"],
        "target_sample_rate": LIVE_TARGET_SAMPLE_RATE,
        "received_seconds": round(received_seconds, 2),
        "error": session.get("error"),
    }


def _store_live_transcription(session_id: str) -> None:
    session = LIVE_SESSIONS[session_id]
    stem = session["file_stem"]
    payload = {
        "session_id": session_id,
        "created_at": session["created_at"],
        "updated_at": session["updated_at"],
        "completed_at": session.get("completed_at"),
        "language": session.get("detected_language") or session["language_hint"],
        "requested_language": session["language_hint"],
        "whisper_model": session["whisper_model"],
        "device": session["device"],
        "stream_sample_rate": session["stream_sample_rate"],
        "target_sample_rate": LIVE_TARGET_SAMPLE_RATE,
        "chunks_processed": session["chunks_processed"],
        "chunks": session["chunks"],
        "transcript": session["transcript"],
        "error": session.get("error"),
    }
    _persist_json(TRANSCRIPT_DIR / f"{stem}.json", payload)
    (TRANSCRIPT_DIR / f"{stem}.txt").write_text(session["transcript"], encoding="utf-8")


def _store_analysis(result: dict) -> None:
    analysis_path = ANALYSIS_DIR / f"{_timestamp()}-{uuid4().hex[:8]}.json"
    _persist_json(analysis_path, result)


def _process_job_sync(job_id: str) -> dict:
    job = JOBS[job_id]
    upload_path = Path(job["source_file"])

    job["stage"] = "transcribing"
    job["detail"] = "Preparing audio and running Whisper"
    job["updated_at"] = _iso_now()
    transcription = transcribe_file(
        source_path=upload_path,
        language=job["language"],
        model_name=job["whisper_model"],
        device=job["device"],
    )
    _store_transcription(upload_path, transcription)

    job["stage"] = "analyzing"
    job["detail"] = "Running Ollama summary"
    job["updated_at"] = _iso_now()
    analysis = analyze_transcript(
        transcription["transcript"],
        model=job["ollama_model"],
    )
    _store_analysis(analysis)

    return {
        "transcript": transcription["transcript"],
        "language": transcription["language"],
        "duration": transcription["duration"],
        "segments": transcription["segments"],
        "analysis": analysis,
    }


async def _run_job(job_id: str) -> None:
    global ACTIVE_JOB_ID

    async with JOB_LOCK:
        ACTIVE_JOB_ID = job_id
        job = JOBS[job_id]
        job["status"] = "processing"
        job["stage"] = "transcribing"
        job["detail"] = "Preparing audio and running Whisper"
        job["started_at"] = _iso_now()
        job["updated_at"] = _iso_now()

    try:
        result = await asyncio.to_thread(_process_job_sync, job_id)
        await _update_job(
            job_id,
            status="completed",
            stage="completed",
            detail="Transcript and analysis are ready",
            completed_at=_iso_now(),
            result=result,
            error=None,
        )
    except Exception as exc:
        await _update_job(
            job_id,
            status="failed",
            stage="failed",
            detail="Processing failed",
            completed_at=_iso_now(),
            error=str(exc),
        )
    finally:
        async with JOB_LOCK:
            ACTIVE_JOB_ID = None


async def _worker_loop() -> None:
    while True:
        job_id = await JOB_QUEUE.get()
        try:
            await _run_job(job_id)
        finally:
            JOB_QUEUE.task_done()


async def _create_live_session(
    language: str | None,
    whisper_model: str,
    device: str,
    stream_sample_rate: int,
) -> str:
    session_id = uuid4().hex
    language_hint = language if language not in (None, "") else "auto"

    async with LIVE_LOCK:
        LIVE_SESSIONS[session_id] = {
            "status": "listening",
            "detail": "Listening for streaming audio",
            "created_at": _iso_now(),
            "updated_at": _iso_now(),
            "completed_at": None,
            "language": _normalize_language(language),
            "language_hint": language_hint,
            "detected_language": None,
            "whisper_model": whisper_model,
            "device": device,
            "stream_sample_rate": stream_sample_rate,
            "transcript": "",
            "last_chunk_text": "",
            "last_duration": None,
            "chunks_processed": 0,
            "chunks": [],
            "error": None,
            "file_stem": f"{_timestamp()}-{session_id[:8]}-live",
            "pcm_buffer": bytearray(),
            "last_processed_target_samples": 0,
            "lock": asyncio.Lock(),
        }

    return session_id


async def _maybe_transcribe_live_session(session_id: str, force: bool = False) -> dict | None:
    session = LIVE_SESSIONS[session_id]
    min_target_samples = int(LIVE_TARGET_SAMPLE_RATE * LIVE_MIN_PROCESS_SECONDS)
    step_target_samples = int(LIVE_TARGET_SAMPLE_RATE * LIVE_STEP_SECONDS)
    max_window_target_samples = int(LIVE_TARGET_SAMPLE_RATE * LIVE_MAX_WINDOW_SECONDS)

    async with session["lock"]:
        total_source_samples = len(session["pcm_buffer"]) // 2
        total_target_samples = int(round(total_source_samples * LIVE_TARGET_SAMPLE_RATE / session["stream_sample_rate"]))
        new_target_samples = total_target_samples - session["last_processed_target_samples"]

        if total_target_samples == 0:
            return None
        if not force and total_target_samples < min_target_samples:
            return None
        if not force and new_target_samples < step_target_samples:
            return None
        if total_target_samples == session["last_processed_target_samples"]:
            return None

        start_target_samples = max(0, total_target_samples - max_window_target_samples)
        start_source_samples = int(start_target_samples * session["stream_sample_rate"] / LIVE_TARGET_SAMPLE_RATE)
        audio_slice = bytes(session["pcm_buffer"][start_source_samples * 2 : total_source_samples * 2])
        initial_prompt = _prompt_tail(session["transcript"])
        session["status"] = "processing"
        session["detail"] = "Running streaming Whisper"
        session["updated_at"] = _iso_now()
        whisper_model = session["whisper_model"]
        language = session["language"]
        device = session["device"]
        stream_sample_rate = session["stream_sample_rate"]

    resampled_audio = _resample_audio(_pcm16le_to_float32(audio_slice), stream_sample_rate)
    transcription = await asyncio.to_thread(
        transcribe_array,
        audio=resampled_audio,
        language=language,
        model_name=whisper_model,
        device=device,
        initial_prompt=initial_prompt,
        vad_filter=False,
    )

    chunk_text = transcription["transcript"].strip()

    async with session["lock"]:
        merged_transcript, delta_text = _merge_transcript(session["transcript"], chunk_text)
        session["transcript"] = merged_transcript
        session["last_chunk_text"] = delta_text
        session["last_duration"] = transcription["duration"]
        session["chunks_processed"] += 1
        session["chunks"].append(
            {
                "sequence": session["chunks_processed"],
                "text": chunk_text,
                "delta_text": delta_text,
                "duration": transcription["duration"],
                "language": transcription["language"],
            }
        )
        session["last_processed_target_samples"] = total_target_samples
        if transcription.get("language"):
            session["detected_language"] = transcription["language"]
        session["status"] = "listening"
        session["detail"] = "Listening for more audio"
        session["updated_at"] = _iso_now()
        session["error"] = None

        snapshot = _live_snapshot(session_id)
        snapshot["type"] = "transcript_update"
        snapshot["delta_text"] = delta_text
        return snapshot


async def _complete_live_session(
    session_id: str,
    *,
    status: str,
    detail: str,
    error: str | None = None,
) -> dict:
    session = LIVE_SESSIONS[session_id]
    async with session["lock"]:
        session["status"] = status
        session["detail"] = detail
        session["updated_at"] = _iso_now()
        session["completed_at"] = session.get("completed_at") or _iso_now()
        session["error"] = error
        _store_live_transcription(session_id)
        return _live_snapshot(session_id)


@app.on_event("startup")
async def startup_event() -> None:
    global WORKER_TASK
    if WORKER_TASK is None or WORKER_TASK.done():
        WORKER_TASK = asyncio.create_task(_worker_loop())


@app.on_event("shutdown")
async def shutdown_event() -> None:
    global WORKER_TASK
    if WORKER_TASK is not None:
        WORKER_TASK.cancel()
        try:
            await WORKER_TASK
        except asyncio.CancelledError:
            pass
        WORKER_TASK = None


@app.get("/health")
def healthcheck() -> dict:
    return {
        "status": "ok",
        "whisper_model": DEFAULT_WHISPER_MODEL,
        "ollama_model": DEFAULT_OLLAMA_MODEL,
        "active_job_id": ACTIVE_JOB_ID,
        "queued_jobs": JOB_QUEUE.qsize(),
        "live_sessions": len(LIVE_SESSIONS),
        "live_stream_target_sample_rate": LIVE_TARGET_SAMPLE_RATE,
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str | None = Form(default="ru"),
    whisper_model: str = Form(default=DEFAULT_WHISPER_MODEL),
    device: str = Form(default="auto"),
) -> dict:
    upload_path = await _save_upload(file)
    try:
        result = transcribe_file(
            source_path=upload_path,
            language=_normalize_language(language),
            model_name=whisper_model,
            device=device,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    _store_transcription(upload_path, result)
    return {
        "file_name": upload_path.name,
        **result,
    }


@app.websocket("/live/ws")
async def live_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    session_id: str | None = None

    try:
        start_message = await websocket.receive_text()
        try:
            payload = json.loads(start_message)
        except json.JSONDecodeError as exc:
            raise ValueError("Invalid streaming start payload.") from exc

        if payload.get("type") != "start":
            raise ValueError("Streaming websocket expects a start message first.")

        stream_sample_rate = int(payload.get("sample_rate") or LIVE_TARGET_SAMPLE_RATE)
        if stream_sample_rate <= 0:
            raise ValueError("Streaming sample rate must be a positive integer.")

        session_id = await _create_live_session(
            language=payload.get("language"),
            whisper_model=payload.get("whisper_model") or DEFAULT_WHISPER_MODEL,
            device=payload.get("device") or "auto",
            stream_sample_rate=stream_sample_rate,
        )

        started_payload = _live_snapshot(session_id)
        started_payload["type"] = "session_started"
        await websocket.send_json(started_payload)

        while True:
            message = await websocket.receive()

            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect()

            if message.get("bytes") is not None:
                packet = message["bytes"] or b""
                if packet:
                    session = LIVE_SESSIONS[session_id]
                    async with session["lock"]:
                        session["pcm_buffer"].extend(packet)
                        session["updated_at"] = _iso_now()
                    update = await _maybe_transcribe_live_session(session_id, force=False)
                    if update is not None:
                        await websocket.send_json(update)
                continue

            if message.get("text") is None:
                continue

            try:
                payload = json.loads(message["text"])
            except json.JSONDecodeError:
                continue

            message_type = payload.get("type")
            if message_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if message_type == "finish":
                update = await _maybe_transcribe_live_session(session_id, force=True)
                if update is not None:
                    await websocket.send_json(update)
                final_payload = await _complete_live_session(
                    session_id,
                    status="completed",
                    detail="Live transcript is ready",
                )
                final_payload["type"] = "session_finished"
                await websocket.send_json(final_payload)
                return

    except WebSocketDisconnect:
        if session_id and session_id in LIVE_SESSIONS:
            try:
                await _maybe_transcribe_live_session(session_id, force=True)
            except Exception:
                pass
            await _complete_live_session(
                session_id,
                status="completed",
                detail="Live stream disconnected",
            )
    except Exception as exc:
        if session_id and session_id in LIVE_SESSIONS:
            await _complete_live_session(
                session_id,
                status="failed",
                detail="Streaming transcription failed",
                error=str(exc),
            )
        try:
            await websocket.send_json({"type": "error", "detail": str(exc)})
        except Exception:
            pass
        try:
            await websocket.close(code=1011)
        except Exception:
            pass


@app.get("/live/sessions/{session_id}")
def get_live_session(session_id: str) -> dict:
    if session_id not in LIVE_SESSIONS:
        raise HTTPException(status_code=404, detail="Live session not found.")
    return _live_snapshot(session_id)


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(request: AnalyzeRequest) -> dict:
    try:
        result = analyze_transcript(request.transcript, model=request.model)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    _store_analysis(result)
    return result


@app.post("/process", response_model=ProcessResponse)
async def process_recording(
    file: UploadFile = File(...),
    language: str | None = Form(default="ru"),
    whisper_model: str = Form(default=DEFAULT_WHISPER_MODEL),
    ollama_model: str = Form(default=DEFAULT_OLLAMA_MODEL),
    device: str = Form(default="auto"),
) -> dict:
    upload_path = await _save_upload(file)
    try:
        transcription = transcribe_file(
            source_path=upload_path,
            language=_normalize_language(language),
            model_name=whisper_model,
            device=device,
        )
        _store_transcription(upload_path, transcription)

        analysis = analyze_transcript(
            transcription["transcript"],
            model=ollama_model,
        )
        _store_analysis(analysis)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "transcript": transcription["transcript"],
        "language": transcription["language"],
        "duration": transcription["duration"],
        "segments": transcription["segments"],
        "analysis": analysis,
    }


@app.post("/jobs")
async def create_job(
    file: UploadFile = File(...),
    language: str | None = Form(default="ru"),
    whisper_model: str = Form(default=DEFAULT_WHISPER_MODEL),
    ollama_model: str = Form(default=DEFAULT_OLLAMA_MODEL),
    device: str = Form(default="auto"),
) -> dict:
    upload_path = await _save_upload(file)
    job_id = uuid4().hex

    async with JOB_LOCK:
        JOBS[job_id] = {
            "status": "queued",
            "stage": "queued",
            "detail": "Waiting for the local worker",
            "created_at": _iso_now(),
            "updated_at": _iso_now(),
            "started_at": None,
            "completed_at": None,
            "source_file": str(upload_path),
            "language": _normalize_language(language),
            "whisper_model": whisper_model,
            "ollama_model": ollama_model,
            "device": device,
            "result": None,
            "error": None,
        }
        JOB_ORDER.append(job_id)

    await JOB_QUEUE.put(job_id)
    return _job_snapshot(job_id)


@app.get("/jobs")
def list_jobs() -> dict:
    job_ids = sorted(JOBS.keys(), key=lambda job_id: JOBS[job_id]["created_at"], reverse=True)
    return {
        "active_job_id": ACTIVE_JOB_ID,
        "queued_jobs": JOB_QUEUE.qsize(),
        "jobs": [_job_snapshot(job_id) for job_id in job_ids],
    }


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found.")
    return _job_snapshot(job_id)