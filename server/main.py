"""
Aegis-Agent :: planner service

Deliberately dumb about privacy, because it has to be: this process is the part of
the system we assume is untrusted. It therefore

  * refuses any request that does not carry a client enclave attestation,
  * refuses a frame whose redaction was not verified client-side,
  * never writes an image to disk or to a log,
  * keeps an append-only audit ring of hashes only, which the client can diff
    against its own attestation to prove what the server actually received.

Run:  uvicorn main:app --host 127.0.0.1 --port 8077
"""

from __future__ import annotations

import base64
import collections
import hashlib
import os
import sys
import time
from typing import Any, Deque, Dict, List, Optional

# Importable as `main:app` (cwd=server/), `server.main:app` (cwd=repo root) or from a
# serverless entry point, without the caller having to arrange sys.path first.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

import planner as heuristic
import vlm

PLANNER = os.environ.get("AEGIS_PLANNER", "heuristic").lower()
MODEL = os.environ.get("AEGIS_MODEL", "qwen2.5vl:7b")
BASE = os.environ.get("AEGIS_BASE", "http://127.0.0.1:11434")
API_KEY = os.environ.get("AEGIS_API_KEY")
TIMEOUT = float(os.environ.get("AEGIS_TIMEOUT", "120"))
MAX_IMAGE_BYTES = int(os.environ.get("AEGIS_MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))

app = FastAPI(title="Aegis-Agent Planner", version="0.9.0")
app.add_middleware(
    CORSMiddleware,
    # The client is a browser extension, so its Origin is chrome-extension://<id>.
    allow_origin_regex=r"^(chrome-extension|moz-extension)://.*$|^http://(127\.0\.0\.1|localhost)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

AUDIT: Deque[Dict[str, Any]] = collections.deque(maxlen=200)
STATS = {"requests": 0, "rejected": 0, "masks_seen": 0, "bytes_in": 0}


# --------------------------------------------------------------------- policy

def enforce_client_policy(env: Dict[str, Any]) -> Dict[str, Any]:
    """Server-side mirror of the client egress firewall. Defence in depth."""
    att = env.get("attestation") or {}
    problems: List[str] = []

    if att.get("sanitized") is not True:
        problems.append("no client sanitisation attestation")
    if att.get("allRegionsUniform") is not True:
        problems.append("client did not verify redaction uniformity")

    image = env.get("image") or ""
    if not image.startswith("data:image/"):
        problems.append("image is not an inline sanitised buffer")

    try:
        raw = base64.b64decode(image.split(",", 1)[1], validate=False)
    except Exception:
        raise HTTPException(422, detail={"error": "image is not decodable base64"})
    if len(raw) > MAX_IMAGE_BYTES:
        problems.append(f"frame exceeds {MAX_IMAGE_BYTES} bytes")

    digest = hashlib.sha256(raw).hexdigest()
    claimed = att.get("sanitizedSha256")
    if claimed and claimed != digest:
        problems.append("attestation hash does not match the received bytes")

    if problems:
        STATS["rejected"] += 1
        AUDIT.appendleft({
            "at": time.time(), "accepted": False, "sha256": digest[:32],
            "bytes": len(raw), "reasons": problems,
        })
        raise HTTPException(403, detail={"error": "request refused by planner policy", "reasons": problems})

    return {"sha256": digest, "bytes": len(raw)}


# --------------------------------------------------------------------- routes

@app.get("/v1/health")
async def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "service": "aegis-planner",
        "planner": PLANNER,
        "model": MODEL if PLANNER != "heuristic" else None,
        "base": BASE if PLANNER != "heuristic" else None,
        "stats": STATS,
        "policy": {
            "requires_client_attestation": True,
            "requires_verified_redaction": True,
            "persists_images": False,
            "logs_images": False,
        },
    }


@app.post("/v1/plan")
async def plan(env: Dict[str, Any] = Body(...)) -> JSONResponse:
    t0 = time.perf_counter()
    meta = enforce_client_policy(env)

    STATS["requests"] += 1
    STATS["bytes_in"] += meta["bytes"]
    STATS["masks_seen"] += len(env.get("semanticTokens") or [])

    try:
        if PLANNER == "ollama":
            decision = await vlm.plan_ollama(env, BASE, MODEL, TIMEOUT)
        elif PLANNER in {"openai", "vllm"}:
            decision = await vlm.plan_openai(env, BASE, MODEL, TIMEOUT, API_KEY)
        else:
            decision = heuristic.plan(env)
    except HTTPException:
        raise
    except Exception as exc:  # a dead model must not look like a privacy failure
        raise HTTPException(502, detail={"error": f"{PLANNER} back end failed: {exc}"})

    decision["serverMs"] = round((time.perf_counter() - t0) * 1000, 2)
    decision["receivedSha256"] = meta["sha256"]

    # Audit record: hashes and shapes only. No pixels, no labels, no goal text.
    AUDIT.appendleft({
        "at": time.time(),
        "accepted": True,
        "sha256": meta["sha256"][:32],
        "bytes": meta["bytes"],
        "step": env.get("step"),
        "masks": len(env.get("semanticTokens") or []),
        "mask_tokens": sorted({t.get("token") for t in (env.get("semanticTokens") or [])}),
        "elements": len(env.get("actionMap") or []),
        "op": decision["action"].get("op"),
        "planner": decision.get("planner"),
        "server_ms": decision["serverMs"],
    })
    return JSONResponse(decision)


@app.get("/v1/audit")
async def audit(limit: int = 50) -> Dict[str, Any]:
    return {"stats": STATS, "entries": list(AUDIT)[: max(1, min(limit, 200))]}


# The demo target page is served from the same origin so the extension has an
# ordinary http:// page to drive (content scripts cannot attach to chrome:// URLs).
_demo = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "demo")
if os.path.isdir(_demo):
    app.mount("/demo", StaticFiles(directory=_demo, html=True), name="demo")


# Dev-only static mounts so tools/selftest.html can import the real enclave modules
# straight out of the extension tree (no build step, no duplicated copy of the code).
_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _seg in ("tools", "extension"):
    _dir = os.path.join(_root, _seg)
    if os.path.isdir(_dir):
        app.mount(f"/{_seg}", StaticFiles(directory=_dir, html=True), name=_seg)


@app.get("/")
async def root() -> Dict[str, Any]:
    return {
        "service": "aegis-planner",
        "demo": "/demo/",
        "selftest": "/tools/selftest.html",
        "health": "/v1/health",
        "audit": "/v1/audit",
        "planner": PLANNER,
    }
