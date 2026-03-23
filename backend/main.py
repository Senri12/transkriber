from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.ollama import DEFAULT_MODEL as DEFAULT_OLLAMA_MODEL
from backend.ollama import analyze_transcript
from backend.stt import DEFAULT_MODEL as DEFAULT_WHISPER_MODEL
from backend.stt import transcribe_file

APP_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = APP_ROOT / "data"
UPLOAD_DIR = DATA_ROOT / "uploads"
TRANSCRIPT_DIR = DATA_ROOT / "transcripts"
ANALYSIS_DIR = DATA_ROOT / "analysis"

for directory in (UPLOAD_DIR, TRANSCRIPT_DIR, ANALYSIS_DIR):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Local AI Meeting Recorder API", version="0.2.0")
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
            language=None if language == "auto" else language,
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
            language=None if language == "auto" else language,
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
            "language": None if language == "auto" else language,
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
