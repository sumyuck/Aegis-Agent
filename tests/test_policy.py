"""The planner service is the untrusted half of the system. It must refuse anything
that did not come through a verified client enclave, and it must never retain an
image."""

import base64
import hashlib
import os
import sys

import pytest
from fastapi.testclient import TestClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from server.main import AUDIT, app  # noqa: E402

client = TestClient(app)
IMAGE = open(os.path.join(ROOT, "extension/icons/icon128.png"), "rb").read()
DIGEST = hashlib.sha256(IMAGE).hexdigest()


def envelope(**attest_over):
    attestation = {
        "sanitized": True,
        "allRegionsUniform": True,
        "sanitizedSha256": DIGEST,
        "rawSha256": "0" * 64,
        "rawBytes": 240000,
        "sanitizedBytes": len(IMAGE),
        "maskCount": 1,
    }
    attestation.update(attest_over)
    return {
        "protocol": "aegis/1",
        "goal": "click Payments",
        "step": 1,
        "maxSteps": 4,
        "image": "data:image/webp;base64," + base64.b64encode(IMAGE).decode(),
        "viewport": {"w": 1440, "h": 900, "dpr": 2},
        "semanticTokens": [{"token": "[MASK_PASSWORD]", "severity": 3, "box": {"x": 1, "y": 1, "w": 2, "h": 2}}],
        "actionMap": [{"ref": "f0:2", "role": "a", "label": "Payments", "box": {"x": 90, "y": 10}}],
        "history": [],
        "attestation": attestation,
    }


def test_health_declares_its_policy():
    p = client.get("/v1/health").json()["policy"]
    assert p["requires_client_attestation"] is True
    assert p["requires_verified_redaction"] is True
    assert p["persists_images"] is False


def test_attested_request_is_planned():
    r = client.post("/v1/plan", json=envelope())
    assert r.status_code == 200
    body = r.json()
    assert body["action"]["ref"] == "f0:2"
    assert body["receivedSha256"] == DIGEST


@pytest.mark.parametrize(
    "override,expected",
    [
        ({"sanitized": False}, "no client sanitisation attestation"),
        ({"allRegionsUniform": False}, "client did not verify redaction uniformity"),
        ({"sanitizedSha256": "f" * 64}, "attestation hash does not match the received bytes"),
    ],
)
def test_policy_refusals(override, expected):
    r = client.post("/v1/plan", json=envelope(**override))
    assert r.status_code == 403
    assert expected in r.json()["detail"]["reasons"]


def test_audit_records_hashes_but_no_image():
    client.post("/v1/plan", json=envelope())
    entry = client.get("/v1/audit?limit=1").json()["entries"][0]
    assert entry["accepted"] is True
    assert entry["mask_tokens"] == ["[MASK_PASSWORD]"]
    blob = repr(list(AUDIT))
    assert "base64" not in blob
    assert base64.b64encode(IMAGE).decode()[:40] not in blob
