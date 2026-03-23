from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from faster_whisper import WhisperModel

DEFAULT_MODEL = "large-v3"
DEFAULT_DOWNLOAD_ROOT = Path("models") / "whisper"
_MODEL_CACHE: dict[tuple[str, str, str | None], WhisperModel] = {}


def _resolve_compute_type(device: str, compute_type: str | None) -> str:
    if compute_type:
        return compute_type
    return "float16" if device == "cuda" else "int8"


def get_model(
    model_name: str = DEFAULT_MODEL,
    device: str = "auto",
    compute_type: str | None = None,
    download_root: Path = DEFAULT_DOWNLOAD_ROOT,
) -> WhisperModel:
    candidates: list[tuple[str, str]]
    if device == "auto":
        candidates = [
            ("cuda", _resolve_compute_type("cuda", compute_type)),
            ("cpu", _resolve_compute_type("cpu", compute_type)),
        ]
    else:
        candidates = [(device, _resolve_compute_type(device, compute_type))]

    download_root.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None

    for resolved_device, resolved_compute_type in candidates:
        cache_key = (model_name, resolved_device, resolved_compute_type)
        if cache_key in _MODEL_CACHE:
            return _MODEL_CACHE[cache_key]

        try:
            _MODEL_CACHE[cache_key] = WhisperModel(
                model_name,
                device=resolved_device,
                compute_type=resolved_compute_type,
                download_root=str(download_root),
            )
            return _MODEL_CACHE[cache_key]
        except Exception as exc:
            last_error = exc
            if device != "auto":
                raise

    raise RuntimeError(f"Unable to initialize Whisper model: {last_error}") from last_error


def convert_to_wav(source_path: Path, wav_path: Path) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(source_path),
        "-ac",
        "1",
        "-ar",
        "16000",
        str(wav_path),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise RuntimeError("ffmpeg is not installed or not available in PATH.") from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip() or exc.stdout.strip()
        raise RuntimeError(f"ffmpeg conversion failed: {stderr}") from exc


def _build_transcription_result(segments_iter: Any, info: Any) -> dict[str, Any]:
    segments = list(segments_iter)
    transcript = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()

    return {
        "transcript": transcript,
        "language": info.language,
        "duration": info.duration,
        "segments": [
            {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip(),
            }
            for segment in segments
        ],
    }


def _transcribe_input(
    audio: str | np.ndarray,
    language: str | None = "ru",
    model_name: str = DEFAULT_MODEL,
    device: str = "auto",
    compute_type: str | None = None,
    vad_filter: bool = True,
    initial_prompt: str | None = None,
    condition_on_previous_text: bool = True,
) -> dict[str, Any]:
    model = get_model(
        model_name=model_name,
        device=device,
        compute_type=compute_type,
    )

    segments_iter, info = model.transcribe(
        audio,
        language=language,
        vad_filter=vad_filter,
        initial_prompt=initial_prompt,
        condition_on_previous_text=condition_on_previous_text,
    )
    return _build_transcription_result(segments_iter, info)


def transcribe_file(
    source_path: str | Path,
    language: str | None = "ru",
    model_name: str = DEFAULT_MODEL,
    device: str = "auto",
    compute_type: str | None = None,
    vad_filter: bool = True,
    initial_prompt: str | None = None,
) -> dict[str, Any]:
    source = Path(source_path)
    if not source.exists():
        raise FileNotFoundError(f"Audio file not found: {source}")

    with tempfile.TemporaryDirectory(prefix="meeting-stt-") as tmp_dir:
        wav_path = Path(tmp_dir) / f"{source.stem}.wav"
        convert_to_wav(source, wav_path)
        return _transcribe_input(
            str(wav_path),
            language=language,
            model_name=model_name,
            device=device,
            compute_type=compute_type,
            vad_filter=vad_filter,
            initial_prompt=initial_prompt,
        )


def transcribe_array(
    audio: np.ndarray,
    language: str | None = "ru",
    model_name: str = DEFAULT_MODEL,
    device: str = "auto",
    compute_type: str | None = None,
    vad_filter: bool = False,
    initial_prompt: str | None = None,
    condition_on_previous_text: bool = False,
) -> dict[str, Any]:
    if audio.ndim != 1:
        raise ValueError("Streaming audio must be a mono 1D numpy array.")

    normalized_audio = np.asarray(audio, dtype=np.float32)
    if normalized_audio.size == 0:
        return {
            "transcript": "",
            "language": language,
            "duration": 0.0,
            "segments": [],
        }

    return _transcribe_input(
        normalized_audio,
        language=language,
        model_name=model_name,
        device=device,
        compute_type=compute_type,
        vad_filter=vad_filter,
        initial_prompt=initial_prompt,
        condition_on_previous_text=condition_on_previous_text,
    )