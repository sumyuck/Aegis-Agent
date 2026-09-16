"""The planner must reach a multi-step goal using only the action map and the mask
tokens — never a redacted value. That is the project's central claim, so it gets the
central test."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import planner  # noqa: E402


def envelope(**over):
    e = {
        "goal": "open the Payments tab and then start a new transfer",
        "actionMap": [
            {"ref": "f0:1", "role": "a", "label": "Dashboard", "box": {"x": 10, "y": 10}},
            {"ref": "f0:2", "role": "a", "label": "Payments", "box": {"x": 90, "y": 10}},
            {"ref": "f0:3", "role": "button", "label": "New transfer", "box": {"x": 40, "y": 200}},
            {"ref": "f0:4", "role": "input", "type": "text", "label": "Search facility", "box": {"x": 40, "y": 260}},
            {"ref": "f0:5", "role": "input", "type": "password", "label": "[MASK_PASSWORD]",
             "sensitive": True, "box": {"x": 40, "y": 300}},
        ],
        "semanticTokens": [{"token": "[MASK_PASSWORD]", "severity": 3}],
        "history": [],
    }
    e.update(over)
    return e


def test_subgoal_split():
    assert planner.split_subgoals("click A and then click B, click C") == \
        ["click A", "click B", "click C"]


def test_intent_parsing():
    assert planner.parse_intent("click Payments")[0] == "click"
    assert planner.parse_intent("scroll down") == ("scroll", "", None)
    op, target, value = planner.parse_intent("type Bangalore into the search facility")
    assert (op, value) == ("type", "bangalore")
    assert "search" in target


def test_multi_step_run_reaches_done():
    env = envelope()
    refs = []
    for _ in range(5):
        p = planner.plan(env)
        if p["done"]:
            break
        refs.append(p["action"]["ref"])
        env["history"].append({"action": p["action"], "ok": True})
    assert refs == ["f0:2", "f0:3"], refs
    assert planner.plan(env)["done"] is True


def test_grounds_type_to_a_text_input_not_a_link():
    env = envelope(goal="type Bangalore into the search facility")
    p = planner.plan(env)
    assert p["action"]["op"] == "type"
    assert p["action"]["ref"] == "f0:4"
    assert p["action"]["text"] == "bangalore"


def test_rationale_reports_masks_without_leaking_values():
    p = planner.plan(envelope())
    assert "[MASK_PASSWORD]" in p["rationale"]
    assert "correct-horse" not in p["rationale"]


def test_ungroundable_goal_stops_instead_of_guessing():
    p = planner.plan(envelope(goal="deorbit the satellite"))
    assert p["done"] is True
    assert p["action"]["op"] == "noop"
    assert p["confidence"] < 0.5
