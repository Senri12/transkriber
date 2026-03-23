# Local AI Meeting Recorder

Local MVP for recording meetings in the browser, transcribing them with `faster-whisper`, and analyzing them with `Ollama`.

## Included

- Chrome Extension MV3:
  - microphone recording
  - current tab audio recording
  - source mixing through Web Audio API
  - `.webm` save to `Downloads/recordings`
  - upload to the local backend
- FastAPI backend:
  - `POST /transcribe`
  - `POST /analyze`
  - `POST /process`
- CLI:
  - batch transcription for local files through `transcriber.py`

## Structure

```text
/extension
  manifest.json
  background.js
  popup.html
  popup.css
  popup.js
  recorder.html
  recorder.css
  recorder.js

/backend
  __init__.py
  main.py
  ollama.py
  stt.py

transcriber.py
requirements.txt
```

## Requirements

- Python 3.10+
- `ffmpeg` in `PATH`
- local `ollama serve`
- installed Ollama model, for example `mistral:7b`

## Run backend

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8010
```

Backend runs on `http://127.0.0.1:8000`.

## Load extension

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the `extension` folder.

## Flow

1. Choose audio sources in the popup.
2. Click `Start`.
3. The extension opens a dedicated recorder window.
4. After `Stop`, the file is saved locally.
5. If auto-processing is enabled, the backend performs:
   - Whisper transcription
   - summary, decisions, and action items through Ollama

## CLI transcription

Single file:

```bash
python transcriber.py meeting.webm --language ru
```

Folder:

```bash
python transcriber.py recordings --output-dir transcripts
```

## MVP limits

- Recording is handled in a dedicated `recorder.html` window instead of the popup because Chrome closes popups too aggressively for long sessions.
- The save folder is a subfolder inside the system `Downloads` directory.
- Long recordings require enough local CPU/GPU resources and disk space.
