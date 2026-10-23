"""Build the demo database and log this viewer ships with.

The viewer reads a Hermes installation: `state.db` for session history, `mnemosyne.db`
for the memory column, and `logs/agent.log` for the live stream. Shipping a real one is
out of the question, so this script writes a small fake installation with the same schema
and a plausible working session in it.

    python demo/build_demo.py

Writes demo/state.db, demo/mnemosyne.db and demo/agent.log. The log is rewritten live by
demo/live.py while the server runs; the two databases are static fixtures.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = HERE / "state.db"
MNE = HERE / "mnemosyne.db"

SID = "20261023_152001_demo"
MODEL = "claude-sonnet-4-5"
PROVIDER = "anthropic"

TURNS = [
    {
        "ask": "The nightly digest did not run on Tuesday. Find out why and fix the schedule.",
        "think": "Two digests exist: the 02:00 rollup and the 06:00 mail. Tuesday is the only "
                 "day missing, so this is not a total failure — check the schedule entry first.",
        "tools": [("read_file", {"path": "config/schedule.yaml"}, "0.31s", 1204,
                   "tasks:\n  digest:\n    at: '02:00'\n    days: mon,wed,thu,fri,sat,sun\n"),
                  ("terminal", {"cmd": "journalctl -u digest --since '3 days ago'"}, "1.42s", 8190,
                   "Oct 21 02:00:04 digest[812]: skip: day 'tue' not in schedule\n"
                   "Oct 21 06:00:01 digest[1440]: sent 1 message\n"),
                  ("execute_code", {"code": "count skipped days in the journal"}, "0.94s", 2210,
                   "{'tue': 1, 'wed': 0, 'thu': 0}"),
                  ("mcp__playwright__browser_navigate",
                   {"url": "https://status.example.com"}, "3.20s", 640,
                   "opened status.example.com — all services green, no incident on Tuesday"),
                  ("web_search", {"query": "systemd timer skipped weekday silently"}, "1.10s", 1480,
                   "three results; the timer does not warn on a day it does not run")],
        "reply": "Tuesday is missing from `days:` in config/schedule.yaml — it is a typo in the "
                 "schedule, not a crash. I added `tue` and the next run will pick it up.",
    },
    {
        "ask": "While you are in there, check whether the same file has other silent skips.",
        "think": "A day list can also hide an empty entry or a duplicated one. Compare the parsed "
                 "set against the seven weekdays rather than eyeballing the string.",
        "tools": [("execute_code", {"code": "diff parsed days against mon..sun"}, "0.42s", 640,
                   "missing: none  extra: none  dups: ['wed']"),
                  ("read_file", {"path": "config/schedule.yaml"}, "0.18s", 1204,
                   "days: mon,wed,wed,thu,fri,sat,sun"),
                  ("patch", {"path": "config/schedule.yaml", "old": "wed,wed", "new": "wed"}, "0.24s", 88,
                   "ok: 1 hunk, the duplicated day is gone")],
        "reply": "No other skips. There is a duplicated `wed`, which is harmless but I removed it.",
    },
]

SESSIONS = [
    (SID, "discord", "nightly digest repair", time.time() - 900, 2),
    ("20261022_101500_demo", "discord", "clean up the release notes", time.time() - 86400, 18),
    ("20261021_184500_demo", "telegram", "compare two price sheets", time.time() - 173000, 12),
    ("20261021_090000_demo", "discord", "rename the export columns", time.time() - 260000, 9),
    ("20261020_221000_demo", "local", "draft the changelog", time.time() - 350000, 26),
    ("20261020_130000_demo", "discord", "why did the build fail", time.time() - 430000, 31),
]

FILLER = [
    ("user", "Can you tidy the release notes for 0.4.2?"),
    ("assistant", "Grouped the eleven entries into Added / Changed / Fixed and dropped the two "
                  "that only repeat the commit subject."),
    ("user", "Compare the two price sheets and tell me what changed."),
    ("assistant", "Three rows moved: two increased under 2%, one dropped 11% and looks like a "
                  "typo in the source sheet."),
    ("user", "Rename the export columns so they match the importer."),
    ("assistant", "Renamed six columns, left the two the importer ignores alone."),
    ("user", "Draft a changelog for the next release."),
    ("assistant", "Drafted it from the merged PRs; the two internal refactors are marked optional."),
    ("user", "Why did the build fail on main?"),
    ("assistant", "A test asserted on a timestamp format that changed upstream. Fixed the "
                  "assertion, not the format."),
]


def brief_ts(t: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t))


def build_state() -> None:
    if STATE.exists():
        STATE.unlink()
    con = sqlite3.connect(STATE)
    con.executescript((HERE / "schema_state.sql").read_text(encoding="utf-8"))

    for sid, source, name, started, count in SESSIONS:
        con.execute(
            "INSERT INTO sessions (id, source, display_name, title, model, started_at, "
            "last_activity_at, message_count, tool_call_count) VALUES (?,?,?,?,?,?,?,?,?)",
            (sid, source, name, name, MODEL, started, started + count * 60, count, 6))

    rid = 0
    ts = time.time() - 900

    def add(session, role, content=None, *, tool=None, calls=None, reasoning=None,
            toks=None, kind=None):
        nonlocal rid, ts
        rid += 1
        ts += 9
        con.execute(
            "INSERT INTO messages (session_id, role, content, tool_calls, tool_name, "
            "reasoning_content, timestamp, token_count, display_kind) VALUES (?,?,?,?,?,?,?,?,?)",
            (session, role, content, json.dumps(calls) if calls else None, tool, reasoning,
             ts, toks, kind))

    for turn in TURNS:
        add(SID, "user", turn["ask"], toks=28)
        for name, args, dur, chars, out in turn["tools"]:
            add(SID, "assistant", None, calls=[{"id": f"call_{rid}", "type": "function",
                 "function": {"name": name, "arguments": json.dumps(args)}}],
                reasoning=turn["think"], toks=180)
            add(SID, "tool", out, tool=name, toks=chars // 4)
        add(SID, "assistant", turn["reply"], toks=96, kind="deliver")

    # older sessions: a short transcript each, enough for the session list to look real
    for i, (sid, _src, _name, started, _n) in enumerate(SESSIONS[1:]):
        base = started
        for j in range(0, len(FILLER), 2):
            role, text = FILLER[j]
            con.execute(
                "INSERT INTO messages (session_id, role, content, timestamp, token_count) "
                "VALUES (?,?,?,?,?)", (sid, role, text, base + j * 40, 40))
            con.execute(
                "INSERT INTO messages (session_id, role, content, timestamp, token_count) "
                "VALUES (?,?,?,?,?)", (sid, "assistant", FILLER[j + 1][1], base + j * 40 + 12, 110))

    for model, calls, tin, tout, cache in ((MODEL, 62, 1_284_000, 41_200, 918_000),
                                           ("gpt-5-mini", 24, 402_000, 18_400, 210_000),
                                           ("local-qwen", 9, 88_000, 5_100, 0)):
        con.execute(
            "INSERT INTO session_model_usage (session_id, model, billing_provider, api_call_count, "
            "input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, last_seen) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (SID, model, PROVIDER, calls, tin, tout, cache, 3100, time.time()))

    con.execute(
        "INSERT INTO delivery_obligations (obligation_id, session_key, platform, chat_id, "
        "content, state, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("ob_demo_1", "demo:main", "discord", "123456789", "nightly digest fixed",
         "delivered", 1, time.time() - 600, time.time() - 590))

    con.execute(
        "INSERT INTO async_delegations (delegation_id, origin_session, state, dispatched_at, "
        "updated_at, task_json, result_json, delivery_state) VALUES (?,?,?,?,?,?,?,?)",
        ("deleg_1a2b3c", SID, "completed", time.time() - 700, time.time() - 640,
         json.dumps({"goal": "read the last 3 days of journal"}),
         json.dumps({"summary": "found one skip on Tuesday"}), "delivered"))
    con.execute(
        "INSERT INTO async_delegations (delegation_id, origin_session, state, dispatched_at, "
        "updated_at, task_json, delivery_state) VALUES (?,?,?,?,?,?,?)",
        ("deleg_4d5e6f", SID, "running", time.time() - 40, time.time() - 30,
         json.dumps({"goal": "diff two price sheets"}), "pending"))

    con.commit()
    con.close()


def build_mnemosyne() -> None:
    if MNE.exists():
        MNE.unlink()
    con = sqlite3.connect(MNE)
    con.executescript((HERE / "schema_mnemosyne.sql").read_text(encoding="utf-8"))
    now = time.time()

    working = [
        ("The nightly digest schedule lives in config/schedule.yaml, keyed by weekday.", 0.9),
        ("Tuesday was missing from the digest day list — fixed on 23/10.", 0.8),
        ("The journal keeps skips as 'skip: day ... not in schedule' at info level.", 0.6),
        ("Digest runs at 02:00 and the mail pass at 06:00, different services.", 0.7),
        ("Release notes are grouped Added / Changed / Fixed, never by commit.", 0.6),
        ("The price sheet importer ignores the last two columns on purpose.", 0.5),
        ("Build failures on main this month were both test-side assertions.", 0.5),
        ("Exports are renamed to the importer's column names, not the reverse.", 0.4),
        ("The changelog marks internal refactors as optional entries.", 0.4),
        ("Playwright sessions should be closed after each check, or tabs pile up.", 0.6),
    ]
    for i, (text, imp) in enumerate(working):
        con.execute(
            "INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, "
            "memory_type, scope) VALUES (?,?,?,?,?,?,?,?)",
            (f"wm_{i:04d}", text, "fact", brief_ts(now - 3600 * (i + 1)), SID, imp,
             "fact", "global"))

    episodic = [
        "Repaired the digest schedule: Tuesday was absent from the day list, no service failure.",
        "Compared two price sheets; three rows moved, one drop looked like a source typo.",
        "Renamed six export columns to match the importer and left the ignored two alone.",
        "Diagnosed a build failure: a test asserted on a timestamp format that had changed.",
        "Wrote the 0.4.2 release notes from the merged pull requests.",
    ]
    for i, text in enumerate(episodic):
        con.execute(
            "INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, "
            "memory_type, scope) VALUES (?,?,?,?,?,?,?,?)",
            (f"ep_{i:04d}", text, "summary", brief_ts(now - 86400 * (i + 1)), SID, 0.7,
             "summary", "global"))

    for i, (s, p, o) in enumerate([
        ("digest", "scheduled_in", "config/schedule.yaml"),
        ("digest", "runs_at", "02:00"),
        ("mail pass", "runs_at", "06:00"),
        ("price sheet", "imported_by", "importer.py"),
        ("release notes", "grouped_by", "Added/Changed/Fixed"),
    ]):
        con.execute("INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp) "
                    "VALUES (?,?,?,?,?,?)", (f"fact_{i}", SID, s, p, o, brief_ts(now - 7200)))

    for cat, name, body in [("identity", "role", "operations assistant for a small studio"),
                            ("preference", "tone", "direct, no filler, numbers over adjectives"),
                            ("convention", "dates", "day/month, never month/day")]:
        con.execute("INSERT INTO canonical_facts (owner_id, category, name, body, source, valid_from) "
                    "VALUES (?,?,?,?,?,?)", ("default", cat, name, body, "demo", brief_ts(now - 86400 * 9)))

    for i in range(6):
        con.execute("INSERT INTO triples (subject, predicate, object, valid_from, source, confidence) "
                    "VALUES (?,?,?,?,?,?)",
                    ("digest", "depends_on", "schedule.yaml", brief_ts(now - 86400), "demo", 0.9))

    for i, (a, b) in enumerate([("wm_0000", "wm_0001"), ("wm_0001", "ep_0000"),
                                ("ep_0000", "wm_0002"), ("wm_0004", "ep_0002"),
                                ("ep_0003", "wm_0006")]):
        con.execute("INSERT INTO graph_edges (source, target, edge_type, weight, timestamp) "
                    "VALUES (?,?,?,?,?)", (a, b, "references", 0.8, brief_ts(now - 3600)))

    con.commit()
    con.close()


def build_log() -> None:
    """A quiet log; demo/live.py appends the working cycle while the server runs."""
    lines = [
        f"[{SID}] conversation turn: session={SID} model={MODEL} provider={PROVIDER} "
        f"platform=discord history=42",
        "response ready: platform=discord chat=123456789 time=18.2s response=642",
        "Turn ended: reason=complete",
    ]
    out = []
    t = time.time() - 30
    for i, body in enumerate(lines):
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t + i))
        out.append(f"{stamp},000 INFO {body}")
    (HERE / "agent.log").write_text("\n".join(out) + "\n", encoding="utf-8")


def build_notes() -> None:
    """The two files Hermes keeps loaded in every prompt, plus a couple of skills."""
    (HERE / "MEMORY.md").write_text(
        "- The nightly digest schedule lives in config/schedule.yaml, keyed by weekday.\n"
        "- Tuesday was missing from the day list, not from the service.\n"
        "- Exports are renamed to the importer's columns, never the reverse.\n"
        "- Close Playwright tabs after a check or they pile up.\n"
        "- Dates in the changelog are day/month.\n", encoding="utf-8")
    (HERE / "USER.md").write_text(
        "- Runs a two-person studio; asks for numbers, not adjectives.\n"
        "- Wants the reason before the fix.\n"
        "- Prefers a diff over a description of a diff.\n", encoding="utf-8")
    skills = HERE / "skills"
    for name, body in (("release-notes", "Group entries Added / Changed / Fixed; drop commit subjects."),
                       ("sheet-diff", "Compare by row key, then report moved, added, removed."),
                       ("digest-ops", "Check the day list before the service when a run is missing.")):
        d = skills / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: {body}\n---\n\n{body}\n", encoding="utf-8")


if __name__ == "__main__":
    build_state()
    build_mnemosyne()
    build_log()
    build_notes()
    print(f"wrote {STATE.name}, {MNE.name}, agent.log")
