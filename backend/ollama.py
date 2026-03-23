from __future__ import annotations

import json
from typing import Any

import requests

DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
DEFAULT_MODEL = "gemma3:12b"

SYSTEM_PROMPT = """You analyze meeting transcripts.
Return only valid JSON with no markdown and no extra commentary.
Use this exact schema:
{
  \"summary\": \"brief summary\",
  \"decisions\": [\"decision 1\"],
  \"action_items\": [
    {
      \"task\": \"what should be done\",
      \"owner\": \"who owns it\",
      \"deadline\": \"deadline or empty string\"
    }
  ],
  \"open_questions\": [\"open question\"]
}
If information is missing, use an empty string or an empty array."""


def _extract_json_payload(raw_text: str) -> dict[str, Any]:
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        start = raw_text.find("{")
        end = raw_text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise ValueError("Ollama response does not contain JSON.")
        return json.loads(raw_text[start : end + 1])


def _normalize_analysis(payload: dict[str, Any]) -> dict[str, Any]:
    action_items = payload.get("action_items") or []
    normalized_actions = []
    for item in action_items:
        if not isinstance(item, dict):
            continue
        normalized_actions.append(
            {
                "task": str(item.get("task") or "").strip(),
                "owner": str(item.get("owner") or "").strip(),
                "deadline": str(item.get("deadline") or "").strip(),
            }
        )

    return {
        "summary": str(payload.get("summary") or "").strip(),
        "decisions": [str(item).strip() for item in payload.get("decisions") or [] if str(item).strip()],
        "action_items": normalized_actions,
        "open_questions": [
            str(item).strip() for item in payload.get("open_questions") or [] if str(item).strip()
        ],
    }


def analyze_transcript(
    transcript: str,
    model: str = DEFAULT_MODEL,
    base_url: str = DEFAULT_OLLAMA_URL,
    timeout: int = 240,
) -> dict[str, Any]:
    if not transcript.strip():
        return _normalize_analysis({})

    response = requests.post(
        base_url,
        json={
            "model": model,
            "system": SYSTEM_PROMPT,
            "prompt": transcript,
            "stream": False,
            "format": "json",
        },
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    raw_response = payload.get("response", "")
    parsed = _extract_json_payload(raw_response)
    return _normalize_analysis(parsed)
