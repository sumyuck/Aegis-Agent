"""
Aegis-Agent :: open-weight VLM back ends.

Both adapters receive the *sanitised* WebP frame and the semantic layout, and must
answer with a single JSON action. Nothing here ever sees an unredacted pixel — the
client made that structurally impossible before the request was built.

  AEGIS_PLANNER=ollama  AEGIS_MODEL=qwen2.5vl:7b   AEGIS_BASE=http://127.0.0.1:11434
  AEGIS_PLANNER=openai  AEGIS_MODEL=Qwen/Qwen2-VL-7B-Instruct  AEGIS_BASE=http://127.0.0.1:8000/v1
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

import httpx

SYSTEM = """You are the reasoning half of a privacy-preserving browser agent.

The screenshot you receive has been sanitised on the user's own machine before it
reached you. Every region that contained a secret or a personal identifier has been
overwritten with a solid box carrying a semantic token such as [MASK_PASSWORD],
[MASK_AADHAAR], [MASK_CARD] or [MASK_PII]. Those pixels are gone; do not guess,
speculate about, or ask for their contents. The token plus its coordinates is all
the information that exists.

You also receive `actionMap`: every interactive element with a stable `ref`, a role
and a PII-scrubbed label. Prefer addressing elements by `ref` — it is exact. Fall
back to `point` (viewport coordinates) only when no ref fits.

Reply with EXACTLY ONE JSON object and no other text:
{"action":{"op":"click|type|press|scroll|noop","ref":"<ref or null>",
           "point":{"x":0,"y":0},"text":"","key":"Enter","dy":400},
 "rationale":"one sentence",
 "confidence":0.0,
 "done":false}

Rules:
- Set done=true when the goal is already satisfied on this frame.
- Never emit a `type` action whose text is a password, OTP, card number or any
  government identifier. The client enforces this and will refuse the action.
- Use the history to avoid repeating an action that already succeeded.
"""


def _brief(envelope: Dict[str, Any]) -> str:
    """Compact, token-cheap rendering of the layout for the model."""
    tokens = envelope.get("semanticTokens") or []
    actions = envelope.get("actionMap") or []
    hist = envelope.get("history") or []
    vp = envelope.get("viewport") or {}

    lines = [
        f"GOAL: {envelope.get('goal')}",
        f"STEP: {envelope.get('step')} of {envelope.get('maxSteps')}",
        f"PAGE: {envelope.get('pageTitle')}",
        f"VIEWPORT: {vp.get('w')}x{vp.get('h')} css px, dpr {vp.get('dpr')}",
        "",
        f"REDACTED REGIONS ({len(tokens)}) — values destroyed on-device:",
    ]
    for t in tokens[:40]:
        b = t["box"]
        lines.append(f"  {t['token']:<18} sev{t.get('severity')} {b['x']},{b['y']} {b['w']}x{b['h']}  ({t.get('source')})")
    lines += ["", f"ACTIONABLE ELEMENTS ({len(actions)}):"]
    for a in actions[:80]:
        b = a["box"]
        flag = " SENSITIVE" if a.get("sensitive") else ""
        lines.append(f"  {a['ref']:<10} <{a.get('role')}> {json.dumps(a.get('label') or '')[:64]} @{b['x']},{b['y']}{flag}")
    if hist:
        lines += ["", "HISTORY:"]
        for h in hist:
            lines.append(f"  step {h.get('step')}: {json.dumps(h.get('action'))} -> ok={h.get('ok')} {h.get('code') or ''}")
    return "\n".join(lines)


def _extract_json(text: str) -> Dict[str, Any]:
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    start = -1
    raise ValueError(f"planner returned no JSON object: {text[:240]}")


def _normalise(raw: Dict[str, Any], planner: str, model: str) -> Dict[str, Any]:
    action = raw.get("action") or {}
    op = (action.get("op") or "noop").lower()
    if op not in {"click", "type", "press", "scroll", "select", "noop"}:
        op = "noop"
    out: Dict[str, Any] = {"op": op}
    if action.get("ref"):
        out["ref"] = str(action["ref"])
    elif isinstance(action.get("point"), dict):
        out["point"] = {"x": int(action["point"].get("x", 0)), "y": int(action["point"].get("y", 0))}
    if op == "type":
        out["text"] = str(action.get("text") or "")
    if op == "press":
        out["key"] = str(action.get("key") or "Enter")
    if op == "scroll":
        out["dy"] = int(action.get("dy") or 400)
    return {
        "planner": planner,
        "model": model,
        "action": out,
        "rationale": str(raw.get("rationale") or "")[:600],
        "confidence": float(raw.get("confidence") or 0.5),
        "done": bool(raw.get("done")),
    }


def _b64(data_url: str) -> str:
    return data_url.split(",", 1)[1] if "," in data_url else data_url


async def plan_ollama(envelope: Dict[str, Any], base: str, model: str, timeout: float) -> Dict[str, Any]:
    payload = {
        "model": model,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.1, "num_predict": 320},
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": _brief(envelope), "images": [_b64(envelope["image"])]},
        ],
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(f"{base.rstrip('/')}/api/chat", json=payload)
        r.raise_for_status()
        body = r.json()
    return _normalise(_extract_json(body["message"]["content"]), "ollama", model)


async def plan_openai(envelope: Dict[str, Any], base: str, model: str, timeout: float,
                      api_key: Optional[str] = None) -> Dict[str, Any]:
    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": SYSTEM},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": _brief(envelope)},
                {"type": "image_url", "image_url": {"url": envelope["image"]}},
            ],
        },
    ]
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(
            f"{base.rstrip('/')}/chat/completions",
            headers=headers,
            json={"model": model, "messages": messages, "temperature": 0.1, "max_tokens": 320},
        )
        r.raise_for_status()
        body = r.json()
    return _normalise(_extract_json(body["choices"][0]["message"]["content"]), "openai", model)
