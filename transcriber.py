from __future__ import annotations

import argparse
import json
from pathlib import Path

from backend.stt import transcribe_file

SUPPORTED_INPUTS = {
    ".mp3",
    ".mp4",
    ".m4a",
    ".mov",
    ".wav",
    ".webm",
    ".ogg",
    ".flac",
}


def iter_inputs(target: Path) -> list[Path]:
    if target.is_file():
        return [target]

    if not target.is_dir():
        raise FileNotFoundError(f"Input path not found: {target}")

    return sorted(
        path for path in target.iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED_INPUTS
    )


def write_outputs(source: Path, output_dir: Path, result: dict) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = source.stem

    transcript_path = output_dir / f"{stem}.txt"
    transcript_path.write_text(result["transcript"], encoding="utf-8")

    segments_path = output_dir / f"{stem}.json"
    segments_path.write_text(
        json.dumps(
            {
                "source_file": str(source),
                "language": result["language"],
                "duration": result["duration"],
                "segments": result["segments"],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"[ok] {source.name} -> {transcript_path}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Transcribe local audio/video files with faster-whisper."
    )
    parser.add_argument(
        "input_path",
        type=Path,
        help="Path to a media file or a directory with media files.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("transcripts"),
        help="Directory for transcript outputs.",
    )
    parser.add_argument(
        "--language",
        default="ru",
        help="Language hint for Whisper, for example ru, en, or auto.",
    )
    parser.add_argument(
        "--model",
        default="large-v3",
        help="Whisper model name or local model path.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        help="Whisper device: auto, cpu, or cuda.",
    )
    parser.add_argument(
        "--compute-type",
        default=None,
        help="Override faster-whisper compute type.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    targets = iter_inputs(args.input_path)

    if not targets:
        print("No supported media files found.")
        return 1

    language = None if args.language == "auto" else args.language

    for target in targets:
        print(f"[transcribe] {target.name}")
        result = transcribe_file(
            source_path=target,
            language=language,
            model_name=args.model,
            device=args.device,
            compute_type=args.compute_type,
        )
        write_outputs(target, args.output_dir, result)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
