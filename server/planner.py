"""
Aegis-Agent :: heuristic planner (the zero-dependency default back end)

Why this exists: the whole point of the project is that the planner works from a
*redacted* frame plus a semantic layout. That claim is only convincing if the
planner demonstrably never needs the redacted values — so the default back end is
a deterministic grounder that consumes nothing but the action map, the semantic
tokens and the goal. It runs on a laptop with no GPU and no model download, which
also makes it the right thing to demo in front of judges on conference wifi.

Swap in a real VLM with AEGIS_PLANNER=ollama|openai; the contract is identical.
"""

from __future__ import annotations

import difflib
import re
from typing import Any, Dict, List, Optional, Tuple

STOPWORDS = {
    "the", "a", "an", "and", "then", "to", "into", "in", "on", "of", "for",
    "please", "my", "with", "at", "it", "that", "this", "new", "go",
}

CLICK_VERBS = {"click", "open", "press", "tap", "select", "choose", "hit", "activate", "submit", "start", "goto"}
TYPE_VERBS = {"type", "enter", "fill", "input", "write", "search"}
SCROLL_VERBS = {"scroll"}


def _words(text: str) -> List[str]:
    return [w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if w and w not in STOPWORDS]


def split_subgoals(goal: str) -> List[str]:
    """`A and then B, C` -> [A, B, C]. Keeps the demo narrative multi-step."""
    parts = re.split(r"\s*(?:,|;|\bthen\b|\band then\b|\band\b|->|→)\s*", goal or "", flags=re.I)
    return [p.strip() for p in parts if p and p.strip()]


def parse_intent(subgoal: str) -> Tuple[str, str, Optional[str]]:
    """Return (op, target_phrase, value)."""
    s = subgoal.strip()
    low = s.lower()

    m = re.match(r"^(?:type|enter|fill|input|write)\s+(?:in\s+)?[\"']?(.+?)[\"']?\s+(?:in|into|to)\s+(?:the\s+)?(.+)$", low)
    if m:
        return "type", m.group(2), m.group(1)

    m = re.match(r"^search\s+(?:for\s+)?[\"']?(.+?)[\"']?$", low)
    if m:
        return "type", "search", m.group(1)

    first = _words(low)[:1]
    verb = first[0] if first else ""

    if verb in SCROLL_VERBS:
        return "scroll", "", None
    if verb in TYPE_VERBS:
        return "type", low, None
    if verb in CLICK_VERBS:
        return "click", re.sub(r"^\w+\s+", "", low), None
    return "click", low, None


def score_element(el: Dict[str, Any], target_words: List[str], wanted_op: str) -> float:
    label = (el.get("label") or "")
    role = (el.get("role") or "").lower()
    el_words = _words(label) + _words(role) + _words(el.get("type") or "")
    if not target_words:
        return 0.0

    hits = sum(1 for w in target_words if w in el_words)
    coverage = hits / len(target_words)

    # Fuzzy pass catches "payments" vs "payment", "transfer" vs "transfers".
    fuzzy = 0.0
    for w in target_words:
        best = max((difflib.SequenceMatcher(None, w, e).ratio() for e in el_words), default=0.0)
        fuzzy += best
    fuzzy /= len(target_words)

    score = coverage * 2.4 + fuzzy * 1.0

    if wanted_op == "click" and role in {"button", "a", "link", "tab", "summary", "menuitem"}:
        score += 0.45
    if wanted_op == "type" and role in {"input", "textarea"} and el.get("type") not in {"submit", "button", "checkbox"}:
        score += 0.6
    if wanted_op == "type" and role not in {"input", "textarea"}:
        score -= 0.7
    # An element we can only address by its mask token is a weak textual match.
    if el.get("sensitive") and wanted_op == "click":
        score -= 0.25
    if not label.strip():
        score -= 0.5
    return score


def _token_summary(tokens: List[Dict[str, Any]]) -> str:
    if not tokens:
        return "no redacted regions on this frame"
    counts: Dict[str, int] = {}
    for t in tokens:
        counts[t.get("token", "?")] = counts.get(t.get("token", "?"), 0) + 1
    return ", ".join(f"{k}×{v}" for k, v in sorted(counts.items()))


def plan(envelope: Dict[str, Any]) -> Dict[str, Any]:
    goal = envelope.get("goal") or ""
    action_map: List[Dict[str, Any]] = envelope.get("actionMap") or []
    tokens: List[Dict[str, Any]] = envelope.get("semanticTokens") or []
    history: List[Dict[str, Any]] = envelope.get("history") or []

    subgoals = split_subgoals(goal)
    done_count = sum(1 for h in history if h.get("ok"))
    seen_ctx = f"frame carries {len(action_map)} actionable elements; redactions: {_token_summary(tokens)}"

    if not subgoals or done_count >= len(subgoals):
        return {
            "planner": "heuristic",
            "done": True,
            "action": {"op": "noop"},
            "confidence": 0.9,
            "rationale": f"All {len(subgoals)} sub-goal(s) satisfied. {seen_ctx}.",
        }

    subgoal = subgoals[done_count]
    op, target, value = parse_intent(subgoal)

    if op == "scroll":
        return {
            "planner": "heuristic",
            "done": False,
            "action": {"op": "scroll", "dy": 500},
            "confidence": 0.8,
            "rationale": f"Sub-goal {done_count + 1}/{len(subgoals)} is a scroll. {seen_ctx}.",
        }

    used = {h.get("action", {}).get("ref") for h in history if h.get("ok")}
    target_words = _words(target)

    ranked = sorted(
        ((score_element(el, target_words, op), el) for el in action_map if el.get("ref") not in used),
        key=lambda p: p[0],
        reverse=True,
    )
    if not ranked or ranked[0][0] < 0.75:
        best_label = ranked[0][1].get("label") if ranked else "—"
        return {
            "planner": "heuristic",
            "done": True,
            "action": {"op": "noop"},
            "confidence": 0.3,
            "rationale": (
                f"Could not ground “{subgoal}” on this frame (best candidate “{best_label}” "
                f"scored {ranked[0][0]:.2f} if any). {seen_ctx}."
            ),
        }

    score, el = ranked[0]
    action: Dict[str, Any] = {"op": op, "ref": el["ref"]}
    if op == "type":
        action["text"] = value if value is not None else ""

    note = ""
    if el.get("sensitive"):
        note = (
            " Target is a masked field — I can see its token and coordinates but not its contents, "
            "and the client will refuse any write to a severity-3 field."
        )

    return {
        "planner": "heuristic",
        "done": False,
        "action": action,
        "confidence": round(min(0.97, 0.45 + score / 5), 2),
        "rationale": (
            f"Sub-goal {done_count + 1}/{len(subgoals)}: “{subgoal}”. Grounded to "
            f"<{el.get('role')}> “{el.get('label')}” at {el['box']['x']},{el['box']['y']} "
            f"(score {score:.2f}).{note} {seen_ctx}."
        ),
    }
