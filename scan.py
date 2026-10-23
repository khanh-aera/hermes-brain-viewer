"""Scan a Hermes installation and describe it — the graph is built from what is really there.

Nobody's Hermes looks the same. One install is a Discord assistant with a Bambu printer attached;
another is a coding agent driven from a terminal; another has five MCP servers and no memory
provider at all. Hard-coding a node list would show most people a diagram of somebody else's agent.

So: read the install, count what actually happened, and emit a profile the viewer renders.
Everything here is read-only and stdlib-only; nothing is written outside the cache file.

    python scan.py            # print the profile for $HERMES_HOME
    python scan.py --json     # same, machine-readable
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from pathlib import Path

HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
STATE = HERMES_HOME / "state.db"
_MNE_CANDIDATES = (HERMES_HOME / "mnemosyne" / "data" / "mnemosyne.db",
                   HERMES_HOME / "mnemosyne.db")          # demo install keeps it flat
MNE = next((p for p in _MNE_CANDIDATES if p.exists()), _MNE_CANDIDATES[0])
SKILLS = HERMES_HOME / "skills"

# How a tool name becomes a node. Order matters: the first match wins, so the specific
# namespaces (playwright, composio, …) must be tested before the generic words.
RULES: list[tuple[str, str, str, str]] = [
    # (regex, node id, label, what it does)
    (r"^(mcp__)?playwright|browser_(?!search)", "tool:browse", "browse", "drives a real browser"),
    (r"^(mcp__)?composio", "tool:composio", "composio", "app integrations"),
    (r"^mcp__", None, "", ""),                      # any other MCP server: one node per server
    (r"delegate|cronjob|spawn", "tool:delegate", "delegate", "helper agents + schedules"),
    (r"execute_code|code_interpreter|python", "tool:code", "code", "runs code"),
    (r"read_file|search_files|grep|glob|read", "tool:read", "read", "opens files"),
    (r"write_file|patch|edit|apply", "tool:write", "write", "changes files"),
    (r"web_search|web_extract|fetch|http", "tool:web", "web", "search + pages"),
    (r"memory|mnemosyne|remember|recall", "tool:memory", "memory", "reads/writes notes"),
    (r"skill", "tool:skill", "skill", "loads playbooks"),
    (r"terminal|shell|bash|process|exec", "tool:terminal", "terminal", "shell on this machine"),
]

PALETTE = ["#ff4d5e", "#ffa62b", "#ffd93d", "#4ade80", "#2ee6a8", "#4d7cff",
           "#a06bff", "#ff5ce1", "#7dd3fc", "#f472b6"]


def _ro(path: Path) -> sqlite3.Connection | None:
    try:
        return sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=3)
    except sqlite3.Error:
        return None


def tool_counts() -> dict[str, int]:
    con = _ro(STATE)
    if not con:
        return {}
    try:
        rows = con.execute(
            "SELECT tool_name, COUNT(*) FROM messages WHERE role='tool' "
            "AND tool_name IS NOT NULL AND tool_name<>'' GROUP BY tool_name").fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        con.close()
    return {name: n for name, n in rows if name}


def session_stats() -> dict:
    out = {"sessions": 0, "messages": 0, "tool_results": 0, "platforms": [], "models": []}
    con = _ro(STATE)
    if not con:
        return out
    try:
        out["sessions"] = con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        out["messages"] = con.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        out["tool_results"] = con.execute(
            "SELECT COUNT(*) FROM messages WHERE role='tool'").fetchone()[0]
        out["platforms"] = [
            {"name": s or "local", "count": n} for s, n in con.execute(
                "SELECT source, COUNT(*) FROM sessions GROUP BY source ORDER BY 2 DESC LIMIT 6")]
        out["models"] = [
            {"name": m, "calls": c, "tokens": tin + tout} for m, c, tin, tout in con.execute(
                "SELECT model, SUM(api_call_count), SUM(input_tokens), SUM(output_tokens) "
                "FROM session_model_usage GROUP BY model ORDER BY 2 DESC LIMIT 5")]
    except sqlite3.Error:
        pass
    finally:
        con.close()
    return out


def memory_sources() -> list[dict]:
    """Only the memory layers this install actually has."""
    out = []
    for fn, nid, label, desc in (("MEMORY.md", "mem:notes", "notes", "durable agent notes"),
                                 ("USER.md", "mem:user", "user", "who you are")):
        fp = HERMES_HOME / fn
        if fp.exists():
            try:
                n = len(re.findall(r"^§?\s*\S", fp.read_text(encoding="utf-8", errors="replace"), re.M))
            except OSError:
                n = 0
            out.append({"id": nid, "label": label, "desc": desc, "count": n})
    con = _ro(MNE)
    if con:
        tiers = (("working_memory", "work", "working", "short-term, recent"),
                 ("episodic_memory", "epi", "episodic", "compressed past sessions"),
                 ("facts", "facts", "facts", "single stated facts"),
                 ("canonical_facts", "canon", "canonical", "settled, stable facts"),
                 ("triples", "triples", "triples", "linked subject → object"))
        for table, nid, label, desc in tiers:
            try:
                n = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            except sqlite3.Error:
                continue
            if n:
                out.append({"id": "mem:" + nid, "label": label, "desc": desc, "count": n})
        con.close()
    return out


def skill_stats() -> dict:
    if not SKILLS.is_dir():
        return {"count": 0, "recent": []}
    names = sorted(p.parent.name for p in SKILLS.rglob("SKILL.md"))
    return {"count": len(names), "recent": names[:6]}


def build_actions(counts: dict[str, int]) -> list[dict]:
    """Group raw tool names into nodes, keeping the biggest and folding the tail into 'other'."""
    groups: dict[str, dict] = {}
    for name, n in counts.items():
        nid, label, desc = None, "", ""
        m_mcp = re.match(r"^mcp__([a-z0-9_]+)__", name)
        for rx, rid, rlabel, rdesc in RULES:
            if not re.search(rx, name, re.I):
                continue
            if rid is None:                      # generic MCP: one node per server
                srv = m_mcp.group(1) if m_mcp else "mcp"
                nid, label, desc = "tool:mcp_" + srv, srv, srv + " tools"
            else:
                nid, label, desc = rid, rlabel, rdesc
            break
        if not nid:
            nid, label, desc = "tool:other", "other", "everything else"
        g = groups.setdefault(nid, {"id": nid, "label": label, "desc": desc, "count": 0})
        g["count"] += n
    acts = sorted(groups.values(), key=lambda a: -a["count"])
    acts = acts[:9]
    total = sum(a["count"] for a in acts) or 1
    for i, a in enumerate(acts):
        a["share"] = round(a["count"] / total, 3)
        a["accent"] = PALETTE[i % len(PALETTE)]
        a["big"] = i < 2                         # the two busiest read as hubs
    return acts


def scan(home: Path | str | None = None) -> dict:
    global HERMES_HOME, STATE, MNE, SKILLS
    if home:                                  # served per request: the caller knows the home
        HERMES_HOME = Path(home)
        STATE = HERMES_HOME / "state.db"
        MNE = next((p for p in (HERMES_HOME / "mnemosyne" / "data" / "mnemosyne.db",
                                HERMES_HOME / "mnemosyne.db") if p.exists()),
                   HERMES_HOME / "mnemosyne" / "data" / "mnemosyne.db")
        SKILLS = HERMES_HOME / "skills"
    counts = tool_counts()
    stats = session_stats()
    mem = memory_sources()
    acts = build_actions(counts)
    return {
        "generated": time.time(),
        "hermes_home": str(HERMES_HOME),
        "found": {"state_db": STATE.exists(), "mnemosyne": MNE.exists(),
                  "skills": SKILLS.is_dir()},
        "memory": mem,
        "actions": acts,
        "skills": skill_stats(),
        "stats": stats,
        "tool_map": {k: v for k, v in _assign(counts, acts).items()},
    }


def _assign(counts: dict[str, int], acts: list[dict]) -> dict[str, str]:
    """raw tool name → node id, so the live feed can colour an event without guessing."""
    by_node = {a["id"]: a for a in acts}
    out = {}
    for name in counts:
        m_mcp = re.match(r"^mcp__([a-z0-9_]+)__", name)
        for a in acts:
            if a["label"] == name:
                out[name] = a["id"]
                break
        if name in out:
            continue
        for rx, rid, _l, _d in RULES:
            if not re.search(rx, name, re.I):
                continue
            if rid is None:
                srv = "tool:mcp_" + (m_mcp.group(1) if m_mcp else "mcp")
            else:
                srv = rid
            out[name] = srv if srv in by_node else "tool:other"
            break
        out.setdefault(name, "tool:other")
    return out


if __name__ == "__main__":
    import sys

    prof = scan()
    if "--json" in sys.argv:
        print(json.dumps(prof, indent=2))
    else:
        print(f"hermes home : {prof['hermes_home']}")
        print(f"found       : {prof['found']}")
        print(f"sessions    : {prof['stats']['sessions']}  messages {prof['stats']['messages']}")
        print(f"platforms   : {', '.join(p['name'] for p in prof['stats']['platforms']) or '—'}")
        print(f"skills      : {prof['skills']['count']}")
        print("memory      : " + (", ".join(f"{m['label']} {m['count']}" for m in prof["memory"]) or "—"))
        print("action nodes:")
        for a in prof["actions"]:
            print(f"  {a['label']:<10} {a['count']:>7}  {a['share']*100:5.1f}%  {a['accent']}")
