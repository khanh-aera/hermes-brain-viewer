"""brain viewer — a read-only window into a running Hermes Agent.

Universal by construction: `scan.py` reads the installation and decides which memory layers
and which action nodes exist, so the same code draws a Discord assistant, a coding agent or
a cron-only box. Nothing here writes to Hermes; every database is opened mode=ro.

Endpoints (all GET, all read-only):
  /api/live               parsed tail of ~/.hermes/logs/agent.log
  /api/sessions           recent sessions from state.db (mode=ro)
  /api/session?id=...     thought-structure messages of one session
  /api/journey            skills<->memory learning graph (fallback: fs scan)
  /api/memory             raw MEMORY.md / USER.md

Stdlib only. Bind 127.0.0.1:8317 by default (HERMES_NEURO_PORT to override).
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import urllib.request
import collections
import concurrent.futures
import threading
from urllib.parse import urlparse, parse_qs

HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
LOG = HERMES_HOME / "logs" / "agent.log"
DB = HERMES_HOME / "state.db"
PORT = int(os.environ.get("HERMES_NEURO_PORT", "8317"))
ROOT = Path(__file__).resolve().parent

# ---------------------------------------------------------------- live log

RE_CTX = re.compile(r"\[([0-9]{8}_[0-9]{6}_[0-9a-z]+)\]")
RE_API = re.compile(
    r"API call #(\d+): model=(\S+) provider=(\S+) in=(\d+) out=(\d+) "
    r"total=(\d+) latency=([\d.]+)s cache=(\d+)/(\d+) \((\d+)%\)")
RE_TOOL = re.compile(r"tool (\S+) completed \(([\d.]+)s, (\d+) chars\)")
RE_FLUSH = re.compile(r"\[(\w+)\] Flushing text batch ([\w:.-]+) \((\d+) chars\)")
RE_TURNEND = re.compile(r"Turn ended: reason=(\w+)")
RE_READY = re.compile(r"response ready: platform=(\w+) .*?time=(\S+).*?response=(\d+)")
RE_TS = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),(\d+)")
RE_TURN = re.compile(r"conversation turn: session=(\S+) model=(\S+) provider=(\S+) platform=(\S+) history=(\d+)")
RE_INBOUND = re.compile(r"inbound message: platform=(\S+) user=(.*?) chat=(\d+) msg='(.*?)'(?: reply_to_id=|$)")

def _tail_text(path: Path, nbytes: int = 220_000) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - nbytes))
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""

def parse_live() -> dict:
    text = _tail_text(LOG)
    events: list[dict] = []
    sessions: dict[str, float] = {}
    last_sess = None
    turn: dict = {}
    for line in text.splitlines():
        m_ts = RE_TS.match(line)
        ts = None
        if m_ts:
            try:
                ts = time.mktime(time.strptime(m_ts.group(1), "%Y-%m-%d %H:%M:%S"))
            except ValueError:
                pass
        m = RE_CTX.search(line)
        if m:
            last_sess = m.group(1)
            sessions[last_sess] = ts or sessions.get(last_sess, 0)
        m = RE_TURN.search(line)
        if m:
            turn = {"session": m.group(1), "model": m.group(2), "provider": m.group(3),
                    "platform": m.group(4), "history": int(m.group(5)), "ts": ts}
            continue
        ev = {"ts": ts, "session": last_sess}
        m = RE_INBOUND.search(line)
        if m:
            ev.update(kind="in", platform=m.group(1), user=m.group(2),
                      chat=m.group(3), msg=m.group(4)[:200], text=m.group(4)[:120])
            events.append(ev)
            continue
        m = RE_API.search(line)
        if m:
            ev.update(kind="think", n=int(m.group(1)), model=m.group(2),
                      provider=m.group(3), tin=int(m.group(4)), tout=int(m.group(5)),
                      latency=float(m.group(7)), cache=int(m.group(10)))
            events.append(ev)
            continue
        m = RE_TOOL.search(line)
        if m:
            ev.update(kind="act", tool=m.group(1), dur=float(m.group(2)), chars=int(m.group(3)))
            events.append(ev)
            continue
        m = RE_FLUSH.search(line)
        if m:
            ev.update(kind="stream", platform=m.group(1), chars=int(m.group(3)))
            events.append(ev)
            continue
        m = RE_TURNEND.search(line)
        if m:
            ev.update(kind="end", text="turn ended (" + m.group(1) + ")")
            events.append(ev)
            continue
        m = RE_READY.search(line)
        if m:
            # "response ready" is the delivery: the gateway has handed the message to the
            # platform. Only this may light the reply node; a flushed batch is compose writing.
            ev.update(kind="deliver", platform=m.group(1), chars=int(m.group(3)),
                      text="delivered")
            events.append(ev)
            continue
        if "run_agent:" in line or "httpx" in line or "httpcore" in line:
            continue  # plumbing noise
        if " INFO " in line or " WARNING " in line or "ERROR" in line:
            lvl = "err" if ("ERROR" in line or "WARNING" in line) else "sys"
            body = line.split(" ", 2)[2] if line.count(" ") >= 2 else line
            ev.update(kind=lvl, text=body[:220])
            events.append(ev)
    active = max(sessions, key=sessions.get) if sessions else None
    now = time.time()
    # busy means the loop is mid-turn: take the last *work* event, not the last log line.
    # A finished turn writes "Turn ended" / "response ready" / a flush — after that the
    # brain is idle even though the process is still alive and the log keeps ticking.
    flow = [e for e in events if e.get("kind") in ("in", "think", "act", "stream", "deliver", "end")]
    last_flow = flow[-1] if flow else None
    flow_kind = (last_flow or {}).get("kind")
    flow_age = (now - (last_flow.get("ts") or 0)) if last_flow else None
    busy = bool(flow_kind in ("in", "think", "act", "stream") and flow_age is not None and flow_age < 90)
    return {"events": events[-140:], "active_session": active, "busy": busy,
            "flow": flow_kind, "flow_age": round(flow_age, 1) if flow_age is not None else None,
            "turn": turn,
            "log_path": str(LOG), "log_age": round(now - (sessions.get(active) or 0), 1) if active else None}

# ---------------------------------------------------------------- state.db

def _ro() -> sqlite3.Connection:
    uri = f"file:{DB.as_posix()}?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=3)

def sessions_list(limit: int = 40) -> list[dict]:
    out = []
    try:
        db = _ro()
        rows = db.execute(
            "SELECT m.session_id, MAX(m.timestamp), COUNT(*), s.source, s.display_name, s.model "
            "FROM messages m LEFT JOIN sessions s ON s.id = m.session_id "
            "GROUP BY m.session_id ORDER BY 2 DESC LIMIT ?", (limit,)).fetchall()
        db.close()
        for sid, ts, n, src, name, model in rows:
            out.append({"id": sid, "ts": ts, "messages": n, "source": src,
                        "name": name or (sid[:16] if sid else "?"), "model": model})
    except sqlite3.Error as e:
        out = [{"error": str(e)}]
    return out

def _brief(s, n):
    if not s:
        return ""
    s = re.sub(r"\s+", " ", str(s)).strip()
    return s[:n] + ("…" if len(s) > n else "")

def session_messages(sid: str, limit: int = 250) -> list[dict]:
    try:
        db = _ro()
        rows = db.execute(
            "SELECT role, tool_name, tool_calls, content, reasoning_content, "
            "token_count, timestamp, display_kind FROM messages "
            "WHERE session_id=? ORDER BY id", (sid,)).fetchall()
        db.close()
    except sqlite3.Error as e:
        return [{"kind": "err", "text": str(e)}]
    msgs = []
    for role, tname, tcalls, content, reasoning, toks, ts, dkind in rows[-limit:]:
        m = {"role": role, "ts": ts, "tokens": toks, "display_kind": dkind}
        if role == "assistant" and tcalls:
            try:
                calls = json.loads(tcalls) if isinstance(tcalls, str) else tcalls
                if isinstance(calls, list):
                    tools = []
                    for c in calls:
                        if not isinstance(c, dict):
                            continue
                        fn = c.get("function") or c
                        args = fn.get("arguments") or "{}"
                        try:
                            a = json.loads(args) if isinstance(args, str) else args
                            argstr = _brief(json.dumps(a, ensure_ascii=False), 160)
                        except Exception:
                            argstr = _brief(str(args), 160)
                        tools.append({"name": fn.get("name") or "?", "args": argstr})
                    if tools:
                        m["kind"] = "toolcall"
                        m["tools"] = tools
                        msgs.append(m)
                        continue
            except Exception:
                pass
        if reasoning:
            m["kind"] = "reason"
            m["text"] = _brief(reasoning, 500)
        elif role == "tool":
            m["kind"] = "result"
            m["tool"] = tname or ""
            m["text"] = _brief(content, 260)
        elif role == "user":
            m["kind"] = "user"
            m["text"] = _brief(content, 400)
        else:
            m["kind"] = "reply"
            m["text"] = _brief(content, 400)
        msgs.append(m)
    return msgs

# ---------------------------------------------------------------- journey

def journey() -> dict:
    try:
        src = HERMES_HOME / "hermes-agent"
        if src.is_dir():
            sys.path.insert(0, str(src))
            os.environ.setdefault("HERMES_HOME", str(HERMES_HOME))
            from agent.learning_graph import build_learning_graph  # type: ignore
            return build_learning_graph()
    except Exception as e:
        pass
    # fallback: skills dir scan + memory files
    nodes, now = [], time.time()
    for kind, d in (("skill", HERMES_HOME / "skills"),):
        if d.is_dir():
            for p in sorted(d.glob("**/SKILL.md")):
                st = p.stat()
                nodes.append({"id": p.parent.name, "label": p.parent.name, "kind": kind,
                              "timestamp": st.st_mtime, "category": d.name})
    return {"nodes": nodes, "edges": [], "clusters": [], "memory": [],
            "stats": {"learned_skills": len(nodes), "fallback": True}}

def memory_raw() -> dict:
    out = {}
    memdir = HERMES_HOME / "memories"
    for key, name in (("memory", "MEMORY.md"), ("user", "USER.md")):
        p = memdir / name
        if not p.exists():
            p = HERMES_HOME / name
        try:
            out[key] = p.read_text(encoding="utf-8", errors="replace")[:40_000]
        except OSError:
            out[key] = ""
    return out

def skill_content(name: str) -> dict:
    """Head of a profile skill's SKILL.md by directory name (read-only)."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "", name)[:80]
    for base in (HERMES_HOME / "skills", HERMES_HOME / "hermes-agent" / "skills"):
        for p in base.glob(f"**/{safe}/SKILL.md"):
            try:
                txt = p.read_text(encoding="utf-8", errors="replace")[:20_000]
                return {"name": safe, "path": str(p.parent), "content": txt}
            except OSError:
                pass
    return {"name": safe, "content": "(not found)"}

MNEMO_DB = HERMES_HOME / "mnemosyne" / "data" / "mnemosyne.db"

# ---------------------------------------------------------------- demo install
# `--demo` points every reader at demo/: a fake Hermes with the same schema, plus a log
# that demo/live.py keeps writing. The rest of the app cannot tell the difference.
DEMO = ("--demo" in sys.argv) or os.environ.get("BRAIN_VIEWER_DEMO") == "1"
if DEMO:
    HERMES_HOME = ROOT / "demo"
    LOG = HERMES_HOME / "agent.log"
    DB = HERMES_HOME / "state.db"
    MNEMO_DB = HERMES_HOME / "mnemosyne.db"

if not DEMO and "--home" in sys.argv:
    HERMES_HOME = Path(sys.argv[sys.argv.index("--home") + 1]).expanduser().resolve()
    LOG = HERMES_HOME / "logs" / "agent.log"
    DB = HERMES_HOME / "state.db"
    MNEMO_DB = HERMES_HOME / "mnemosyne" / "data" / "mnemosyne.db"

_PROFILE_HIT: tuple[float, dict] | None = None


def profile_payload() -> dict:
    """What this install is made of — the frontend builds its columns from this."""
    global _PROFILE_HIT
    now = time.time()
    if _PROFILE_HIT and now - _PROFILE_HIT[0] < 60:
        return _PROFILE_HIT[1]
    try:
        import scan
        prof = scan.scan(HERMES_HOME)
    except Exception as e:                       # a broken scan must not take the viewer down
        prof = {"error": str(e), "memory": [], "actions": [], "stats": {}, "tool_map": {}}
    _PROFILE_HIT = (now, prof)
    return prof

def _mnemo() -> sqlite3.Connection:
    return sqlite3.connect(f"file:{MNEMO_DB.as_posix()}?mode=ro", uri=True, timeout=3)

def mnemosyne_stats(tier: str | None = None, limit: int = 25) -> dict:
    """Counts per memory tier + recent entries, read-only. The real long-term brain."""
    if not MNEMO_DB.exists():
        return {"error": "mnemosyne db not found", "tiers": [], "recent": []}
    from datetime import datetime, timedelta, timezone
    iso24 = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%S")
    iso24s = iso24.replace("T", " ")
    try:
        db = _mnemo()
        tiers = []
        def add(tid, label, table, tscol, cutoff, where=""):
            n = db.execute(f"SELECT COUNT(*) FROM {table} {where}").fetchone()[0]
            recent = db.execute(
                f"SELECT COUNT(*) FROM {table} {where + ' AND' if where else 'WHERE'} {tscol} >= ?",
                (cutoff,)).fetchone()[0]
            last = db.execute(f"SELECT MAX({tscol}) FROM {table}").fetchone()[0]
            tiers.append({"id": tid, "label": label, "count": n, "recent24h": recent, "last": last})
        # created_at = when the row was WRITTEN; `timestamp` is the source event time
        # (consolidation backdates it), so a fresh pass would still read as "2d ago".
        add("working", "working", "working_memory", "created_at", iso24s)
        add("episodic", "episodic", "episodic_memory", "created_at", iso24s)
        add("facts", "facts", "facts", "created_at", iso24s)
        add("canonical", "canonical", "canonical_facts", "created_at", iso24s, "WHERE valid_until IS NULL")
        ge = db.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0]
        tr = db.execute("SELECT COUNT(*) FROM triples").fetchone()[0]
        ge24 = db.execute("SELECT COUNT(*) FROM graph_edges WHERE created_at >= ?", (iso24s,)).fetchone()[0]
        gelast = db.execute("SELECT MAX(created_at) FROM graph_edges").fetchone()[0]
        tiers.append({"id": "graph", "label": "graph", "count": ge + tr,
                      "recent24h": ge24, "last": gelast})

        recent = []
        if tier:
            table = {"working": "working_memory", "episodic": "episodic_memory",
                     "facts": "facts", "canonical": "canonical_facts", "graph": "graph_edges"}.get(tier)
            if table == "facts":
                rows = db.execute(
                    f"SELECT subject || ' — ' || predicate || ' — ' || object, confidence, created_at "
                    f"FROM facts ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
                recent = [{"tier": tier, "text": r[0], "score": r[1], "ts": r[2]} for r in rows]
            elif table == "canonical_facts":
                rows = db.execute(
                    "SELECT name || ': ' || body, confidence, created_at FROM canonical_facts "
                    "ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
                recent = [{"tier": tier, "text": r[0], "score": r[1], "ts": r[2]} for r in rows]
            elif table:
                rows = db.execute(
                    f"SELECT content, importance, coalesce(created_at, timestamp) FROM {table} "
                    f"ORDER BY rowid DESC LIMIT ?", (limit,)).fetchall()
                recent = [{"tier": tier, "text": r[0], "score": r[1], "ts": r[2]} for r in rows]
        else:
            rows = db.execute(
                "SELECT content, importance, coalesce(created_at, timestamp), 'working' FROM working_memory "
                "ORDER BY created_at DESC LIMIT 12").fetchall()
            rows += db.execute(
                "SELECT content, importance, coalesce(created_at, timestamp), 'episodic' FROM episodic_memory "
                "ORDER BY created_at DESC LIMIT 6").fetchall()
            rows.sort(key=lambda r: str(r[2] or ""), reverse=True)
            recent = [{"tier": r[3], "text": r[0], "score": r[1], "ts": r[2]} for r in rows[:limit]]
        db.close()
        return {"tiers": tiers, "recent": recent,
                "total": sum(t["count"] for t in tiers if t["id"] != "graph"),
                "db": str(MNEMO_DB)}
    except sqlite3.Error as e:
        return {"error": str(e), "tiers": [], "recent": []}

def usage_stats(days: int = 7) -> dict:
    """Token economy per source/model + recent subagent delegations. No money — tokens only."""
    from datetime import datetime, time, timedelta
    if not DB.exists():
        return {"error": "state.db missing"}
    t0 = datetime.combine(datetime.now().date(), time()).timestamp()
    try:
        db = _ro()
        def agg(since):
            r = db.execute(
                "SELECT COALESCE(SUM(api_call_count),0), COALESCE(SUM(input_tokens),0),"
                " COALESCE(SUM(output_tokens),0), COALESCE(SUM(cache_read_tokens),0),"
                " COALESCE(SUM(reasoning_tokens),0) FROM session_model_usage WHERE last_seen>=?",
                (since,)).fetchone()
            tin, tout, cache = r[1], r[2], r[3]
            return {"calls": r[0], "in": tin, "out": tout, "cache_read": cache,
                    "reasoning": r[4],
                    "cache_pct": round(cache / max(1, tin + cache) * 100, 1)}
        by_source = [{"source": r[0] or "?", "calls": r[1] or 0, "in": r[2] or 0,
                      "out": r[3] or 0, "cache": r[4] or 0} for r in db.execute(
            "SELECT COALESCE(s.source,'?'), SUM(u.api_call_count), SUM(u.input_tokens),"
            " SUM(u.output_tokens), SUM(u.cache_read_tokens)"
            " FROM session_model_usage u LEFT JOIN sessions s ON s.id=u.session_id"
            " WHERE u.last_seen>=? GROUP BY 1 ORDER BY 2 DESC LIMIT 8", (t0,))]
        by_model = [{"model": r[0], "calls": r[1] or 0, "in": r[2] or 0,
                     "out": r[3] or 0, "cache": r[4] or 0} for r in db.execute(
            "SELECT model, SUM(api_call_count), SUM(input_tokens), SUM(output_tokens),"
            " SUM(cache_read_tokens) FROM session_model_usage WHERE last_seen>=?"
            " GROUP BY 1 ORDER BY 2 DESC LIMIT 8", (t0,))]
        today = agg(t0)
        week = agg(t0 - days * 86400)
        dels = []
        for d in db.execute(
                "SELECT delegation_id, state, dispatched_at, completed_at, delivery_state, task_json"
                " FROM async_delegations ORDER BY dispatched_at DESC LIMIT 10"):
            goal = ""
            try:
                import json as _json
                goal = (_json.loads(d[5] or "{}").get("goal") or "")[:160]
            except Exception:
                pass
            dur = None
            if d[2] and d[3]:
                dur = round(float(d[3]) - float(d[2]), 1)
            dels.append({"id": d[0], "state": d[1], "disp": d[2], "done": d[3],
                         "delivery": d[4], "goal": goal, "dur": dur})
        db.close()
        return {"today": today, "week": week,
                "by_source": by_source, "by_model": by_model, "delegates": dels,
                "delegates_today": sum(1 for d in dels if d["disp"] and float(d["disp"]) >= t0)}
    except sqlite3.Error as e:
        return {"error": str(e)}

_HEALTH_CACHE = None   # (ts, payload) — errors.log is multi-MB and messages LIKE-scans are slow
_SKILLS_CACHE = None  # (ts, payload) — skill_view usage is stable for ~30s


_DNAME = {}            # chat_id -> (ts, {name, parent, type}) from Discord REST


def _skill_desc(name: str) -> str:
    """One plain line about what this playbook is for, from its own frontmatter.

    Skills live either at skills/<name>/SKILL.md or grouped under a category, so both
    shapes are searched; the description may also be a folded YAML block.
    """
    for base in (HERMES_HOME / "skills", Path.home() / ".hermes" / "skills"):
        for f in list(base.glob(f"{name}/SKILL.md")) + list(base.glob(f"*/{name}/SKILL.md")):
            try:
                head = f.read_text(encoding="utf-8", errors="ignore")[:2000]
            except OSError:
                continue
            m = re.search(r"^description:\s*(.*)$", head, re.M)
            if not m:
                continue
            val = m.group(1).strip()
            if val in (">", ">-", "|", "|-", ""):        # folded block: take the next lines
                rest = head[m.end():].splitlines()[1:]
                buf = []
                for line in rest:
                    if re.match(r"^[a-zA-Z_]+:", line):
                        break
                    if line.strip():
                        buf.append(line.strip())
                val = " ".join(buf)
            val = val.strip().strip('"').strip("'")
            val = re.sub(r"^Use(?:\s+(?:when|for))?\b[ ,]*", "", val, flags=re.I).strip()
            val = re.sub(r"^any(?:thing)? involving\s+", "", val, flags=re.I).strip()
            return val[:110]
    return ""


_GATES_CACHE = None    # (ts, payload) — walking 7 days of tool results costs ~0.6s, cache 60s

_RE_SCHEMA = re.compile(r"missing required|unknown tool|invalid argument|not valid json|malformed", re.I)
_RE_GUARD = re.compile(r"command was flagged|required approval|requires approval|command was blocked|\bblocked by\b|auto-approved|denied by policy|refused:|read_file.{0,24}first", re.I)


def _gate_kind(tool: str, content: str):
    """Classify one tool result as a gate event.

    Only structured results count: a tool that merely *printed* the word BLOCKED is not a
    block. Returns (column, one-line message) or None.
    """
    try:
        j = json.loads(content)
    except Exception:
        return None
    if not isinstance(j, dict):
        return None
    appr = j.get("approval")
    if isinstance(appr, str) and _RE_GUARD.search(appr):
        return ("guard", appr.strip())
    err = j.get("error")
    msg = str(err).strip() if err else ""
    if not msg and str(j.get("status") or "").lower() in ("error", "failed"):
        msg = str(j.get("message") or j.get("output") or "").strip()
    if msg:
        if _RE_SCHEMA.search(msg):
            return ("schema", msg)
        if _RE_GUARD.search(msg):
            return ("guard", msg)
    return None


def _one_line(msg: str) -> str:
    """A gate label a human can read in one glance: verdict · the thing it touched."""
    m = re.sub(r"\s+", " ", msg).strip()
    m = re.sub(r"^error:\s*", "", m, flags=re.I)
    rules = [
        (r"^tool_call to '([^']+)' is missing required argument\(s\):?\s*([^\.]*)",
         lambda x: f"missing arg · {x.group(2).strip() or x.group(1).split('__')[-1]}"),
        (r"Command was flagged \((.+?)\)", lambda x: f"flagged · {x.group(1)}"),
        (r"Command required approval \((.+?)\)", lambda x: f"needed approval · {x.group(1)}"),
        (r"Command was blocked \((.+?)\)", lambda x: f"blocked · {x.group(1)}"),
        (r"^Missing required parameter:?\s*(.*)", lambda x: "missing param · " + (x.group(1)[:24] or "required")),
        (r"^(.{0,18}?) is missing required argument\(s\):?\s*(.*)",
         lambda x: f"missing arg · {x.group(2)[:24] or x.group(1)}"),
    ]
    for pat, fn in rules:
        if re.search(pat, m, flags=re.I):
            m = re.sub(pat, fn, m, count=1, flags=re.I)
            break
    # keep the verdict, drop the explanation Hermes appends after it
    m = re.split(r" (?:and (?:auto-approved|was approved|the user)|and was approved)|\. The tool|\. Parameters",
                 m)[0].strip()
    m = re.sub(r"^missing param · provide '([^']+)'.*", r"missing param · \1", m)
    m = re.sub(r"^tool_call to '([^']+)'\s*", r"\1 ", m)
    return m[:72]


def gates_stats(limit: int = 4) -> dict:
    """The two gates every tool call passes before it is allowed to run.

    schema  — does the payload match the tool's contract (name known, args present, JSON parses)?
    guard   — is this action permitted here (destructive command, approval, permission, redaction)?
    Both are read from the tool results Hermes itself wrote, so a column that never fires
    stays honestly empty instead of inventing traffic.
    """
    global _GATES_CACHE
    now = time.time()
    if _GATES_CACHE and now - _GATES_CACHE[0] < 60:
        cached = _GATES_CACHE[1]
        return {k: ({**v, "events": v["events"][:limit]} if isinstance(v, dict) and "events" in v else v)
                for k, v in cached.items()}
    out = {"schema": {"n7": 0, "today": 0, "events": []}, "guard": {"n7": 0, "today": 0, "events": []},
           "checked7": 0}
    try:
        db = _ro()
        t0 = time.time() - 7 * 86400
        sod = time.time() - (time.time() % 86400)
        rows = db.execute(
            "SELECT tool_name, timestamp, content FROM messages"
            " WHERE role='tool' AND timestamp > ? ORDER BY timestamp DESC", (t0,)).fetchall()
        db.close()
        out["checked7"] = len(rows)
        for tool, ts, content in rows:
            if not content:
                continue
            kind = _gate_kind(tool or "", content)
            if not kind:
                continue
            col, msg = kind
            bucket = out[col]
            bucket["n7"] += 1
            if ts >= sod:
                bucket["today"] += 1
            if len(bucket["events"]) < 8:
                bucket["events"].append({"tool": tool or "", "msg": _one_line(msg), "ts": ts})
    except sqlite3.Error as e:
        return {"error": str(e)}
    _GATES_CACHE = (now, out)
    return {k: ({**v, "events": v["events"][:limit]} if isinstance(v, dict) and "events" in v else v)
            for k, v in out.items()}


_TOOLS_CACHE = None    # (ts, payload) — all-time tool counts move slowly, cache 2 min


def tools_stats(limit: int = 40) -> dict:
    """How often each tool really ran, all time.

    Used to sort the ACTION column so the busiest tools sit in the middle of the column —
    traffic in the centre reads as balance; traffic pinned to the top edge reads as a tilt.
    """
    global _TOOLS_CACHE
    now = time.time()
    if _TOOLS_CACHE and now - _TOOLS_CACHE[0] < 120:
        c = _TOOLS_CACHE[1]
        return {"tools": c["tools"][:limit], "total": c["total"]}
    try:
        db = _ro()
        rows = db.execute(
            "SELECT tool_name, COUNT(*) FROM messages"
            " WHERE role='tool' AND tool_name IS NOT NULL AND tool_name<>''"
            " GROUP BY tool_name ORDER BY COUNT(*) DESC LIMIT 200").fetchall()
        db.close()
    except sqlite3.Error as e:
        return {"error": str(e)}
    payload = {"tools": [{"name": n, "n": c} for n, c in rows],
               "total": sum(c for _, c in rows)}
    _TOOLS_CACHE = (now, payload)
    return {"tools": payload["tools"][:limit], "total": payload["total"]}


_DELEG_CACHE = None    # (ts, payload) — 5s, subagents move fast but not per-frame


_PEEK_CACHE = [0.0, {}]


def _code_of(args: dict, name: str):
    """Pull the text that is actually being written: code for execute_code, the new
    body for write_file, the replacement for patch."""
    if name == "execute_code":
        return args.get("code") or ""
    if name == "write_file":
        return args.get("content") or ""
    if name == "patch":
        return args.get("new_string") or ""
    return ""


_THINK_CACHE = [0.0, {}]


def think_stats() -> dict:
    """The newest reasoning text, for the status card.

    Hermes commits an assistant row once a think step emits its tool call, so this is the
    most recent completed thought — not a live token stream. The card reveals it
    progressively, which is a display decision, not a claim that we can watch it type.
    """
    global _THINK_CACHE
    now = time.time()
    if _THINK_CACHE[0] and now - _THINK_CACHE[0] < 2:
        return _THINK_CACHE[1]

    out = {"text": "", "chars": 0, "ts": 0, "age": None}
    try:
        db = _ro()
        rows = db.execute(
            "SELECT reasoning_content, timestamp FROM messages"
            " WHERE role='assistant' AND reasoning_content IS NOT NULL"
            "   AND length(reasoning_content) > 24"
            " ORDER BY rowid DESC LIMIT 4").fetchall()
        db.close()
    except sqlite3.Error as e:
        return {**out, "error": str(e)}

    for text, ts in rows:
        text = (text or "").strip()
        if len(text) <= 24:
            continue
        ts = float(ts or 0)
        out = {"text": text[-700:], "chars": len(text), "ts": ts,
               "age": round(now - ts, 1) if ts else None}
        break

    _THINK_CACHE = [now, out]
    return out


def peek_stats() -> dict:
    """What the two big action nodes are doing, in their own words.

    code / file come straight out of messages.tool_calls: scan the newest 80 rows
    rather than LIKE over a 660 MB table. Delegation progress comes from the real
    rows: tasks dispatched vs results returned.
    """
    global _PEEK_CACHE
    now = time.time()
    if _PEEK_CACHE[0] and now - _PEEK_CACHE[0] < 4:
        return _PEEK_CACHE[1]

    out = {"code": None, "file": None, "deleg": None}
    try:
        db = _ro()
        rows = db.execute(
            "SELECT tool_calls FROM messages WHERE tool_calls IS NOT NULL"
            " ORDER BY rowid DESC LIMIT 80").fetchall()
        db.close()
    except sqlite3.Error as e:
        return {"error": str(e), "code": None, "file": None, "deleg": None}

    for (tc,) in rows:
        try:
            calls = json.loads(tc)
        except Exception:
            continue
        if isinstance(calls, dict):
            calls = [calls]
        for c in calls or []:
            fn = (c or {}).get("function") or {}
            name = fn.get("name") or ""
            if name not in ("execute_code", "write_file", "patch"):
                continue
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except Exception:
                continue
            body = _code_of(args, name)
            if not body:
                continue
            lines, total = _tail_lines(body, 8)
            if total > len(lines):
                lines[0] = "… " + lines[0]          # marks that the top was cut, not the bottom
            item = {"tool": name, "lines": lines, "chars": len(body), "more": max(0, total - len(lines))}
            if name == "execute_code" and not out["code"]:
                out["code"] = item
            elif name in ("write_file", "patch") and not out["file"]:
                item["path"] = args.get("path") or args.get("file_path") or ""
                out["file"] = item
        if out["code"] and out["file"]:
            break

    try:
        db = _ro()
        row = db.execute(
            "SELECT delegation_id, state, dispatched_at, completed_at, task_json, result_json"
            " FROM async_delegations ORDER BY dispatched_at DESC LIMIT 1").fetchone()
        db.close()
    except sqlite3.Error:
        row = None
    if row:
        did, state, d0, d1, tj, rj = row
        try:
            tasks = json.loads(tj or "{}")
            res = json.loads(rj or "{}")
        except Exception:
            tasks, res = {}, {}
        goals = [str((t or {}).get("goal") or (t or {}).get("context") or "")
                 for t in (tasks.get("tasks") or [])]
        if not goals and tasks.get("goal"):
            goals = [str(tasks.get("goal"))]
        total = len(goals) or (1 if tasks else 0)
        done = len(res.get("results") or [])
        out["deleg"] = {
            "id": did, "state": state, "tasks": total, "done": done,
            "elapsed": round((float(d1 or now) - float(d0 or now)), 0),
            "goal": goals[0] if goals else "",
            "goals": [g[:160] for g in goals[:4]],
        }

    # never cache an empty answer: a scan that lands between two tool calls would
    # otherwise pin "nothing yet" for the whole TTL and the card would never appear
    if out["code"] or out["file"] or out["deleg"]:
        _PEEK_CACHE = [now, out]
    return out


def _tail_lines(text: str, n: int):
    """Last n non-empty lines — you watch code being written, not its imports.

    Returns (lines, total) so the caller can say how much was cut off the top.
    """
    src = str(text).replace("\r", "")
    lines = [ln[:160] for ln in src.split("\n")]
    while lines and not lines[-1].strip():
        lines.pop()
    while lines and not lines[0].strip():
        lines.pop(0)
    total = len(lines)
    return lines[-n:], total


def delegations_stats(limit: int = 4) -> dict:
    """Subagent duty cycle, from the real delegation rows.

    Each row carries its tasks in task_json and its outcome in result_json, so progress is
    countable: tasks finished / tasks dispatched. A batch that is still running has fewer
    results than tasks, which is the only honest progress signal in the whole system.
    """
    global _DELEG_CACHE
    now = time.time()
    if _DELEG_CACHE and now - _DELEG_CACHE[0] < 5:
        return _DELEG_CACHE[1]
    out = {"running": 0, "recent": [], "done7": 0}
    try:
        db = _ro()
        rows = db.execute(
            "SELECT delegation_id, state, dispatched_at, completed_at, task_json, result_json"
            " FROM async_delegations WHERE dispatched_at > ? ORDER BY dispatched_at DESC",
            (now - 7 * 86400,)).fetchall()
        db.close()
    except sqlite3.Error as e:
        return {"error": str(e), "running": 0, "recent": []}
    for did, state, d0, d1, tj, rj in rows:
        try:
            tasks = json.loads(tj or "{}")
            res = json.loads(rj or "{}")
        except Exception:
            tasks, res = {}, {}
        total = len(tasks.get("tasks") or []) or (1 if tasks else 0)
        done = len(res.get("results") or [])
        if state != "running":
            out["done7"] += 1
        if state == "running":
            out["running"] += 1
        if len(out["recent"]) < limit:
            out["recent"].append({
                "id": did, "state": state, "tasks": total, "done": done,
                "t0": float(d0 or 0), "t1": float(d1 or 0),
                "elapsed": round((float(d1 or now) - float(d0 or now)), 1),
                "goal": str((tasks.get("tasks") or [{}])[0].get("goal", "") if tasks.get("tasks") else tasks.get("goal", ""))[:90],
            })
    payload = {"running": out["running"], "recent": out["recent"], "done7": out["done7"]}
    _DELEG_CACHE = (now, payload)
    return payload


def skills_stats(limit: int = 6) -> dict:
    """Which playbook was loaded before it started thinking — from real skill_view calls."""
    global _SKILLS_CACHE
    now = time.time()
    if _SKILLS_CACHE and now - _SKILLS_CACHE[0] < 30:
        return _SKILLS_CACHE[1]
    counts, last, order = collections.Counter(), {}, []
    try:
        db = _ro()
        rows = db.execute(
            "SELECT tool_calls, timestamp FROM messages"
            " WHERE tool_calls LIKE '%skill_view%' ORDER BY rowid DESC LIMIT 500").fetchall()
        db.close()
        for tc, ts in rows:
            try:
                arr = json.loads(tc or "[]")
            except Exception:
                continue
            if isinstance(arr, dict):
                arr = [arr]
            for c in arr:
                fn = c.get("function") or {}
                if fn.get("name") != "skill_view":
                    continue
                try:
                    a = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    a = {}
                n = (a.get("name") or "").strip()
                if not n:
                    continue
                counts[n] += 1
                if n not in last:
                    last[n] = ts
                    order.append(n)
    except sqlite3.Error as e:
        return {"error": str(e)}
    ranked = order[:40]                      # already newest-first from the query
    ranked.sort(key=lambda n: -counts[n])
    top = ranked[:limit]
    newest = order[0] if order else None
    if newest and newest not in top:         # always surface the one loaded most recently
        top = (top[:limit - 1] + [newest]) if limit > 1 else [newest]
    out = []
    for n in top:
        out.append({"name": n, "desc": _skill_desc(n), "calls": counts[n],
                    "last": last.get(n), "active": n == newest})
    payload = {"skills": out, "total": len(counts), "active": newest or ""}
    _SKILLS_CACHE = (now, payload)
    return payload




def health_stats() -> dict:
    """Errors, tool-output flags, delivery + cron board + mnemosyne consolidation. Read-only."""
    from datetime import datetime, time, timedelta
    import re as _re
    global _HEALTH_CACHE
    now_ts = datetime.now().timestamp()
    if _HEALTH_CACHE and now_ts - _HEALTH_CACHE[0] < 15:
        return _HEALTH_CACHE[1]          # cheap repeat reads: the panel polls, don't thrash the disk
    t0 = datetime.combine(datetime.now().date(), time()).timestamp()
    day = datetime.now().strftime("%Y-%m-%d")
    out: dict = {}
    # ---- errors.log: ONE pass
    sigs, errs, warns, all_fail, fail_today = {}, 0, 0, 0, 0
    try:
        with open(LOG.parent / "errors.log", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                if "summarization failed" in line:
                    all_fail += 1
                    if line.startswith(day):
                        fail_today += 1
                if not line.startswith(day):
                    continue
                lvl = "ERROR" if "ERROR" in line else "WARNING" if "WARNING" in line else None
                if lvl == "ERROR":
                    errs += 1
                elif lvl == "WARNING":
                    warns += 1
                if lvl:
                    m = _re.search(r"(?:ERROR|WARNING)\s+\S+:\s+(.{0,110})", line)
                    if m:
                        key = _re.sub(r"\b\d+\b", "N", m.group(1))[:90]
                        d = sigs.setdefault(key, {"text": key, "level": lvl, "n": 0})
                        d["n"] += 1
    except OSError:
        pass
    out["errors"] = {"today": errs, "warnings": warns,
                     "top": sorted(sigs.values(), key=lambda x: -x["n"])[:8],
                     "summarization_failed_total": all_fail}
    # ---- tool output flags (keyword heuristic, NOT structured error flags)
    try:
        db = _ro()
        bad, tot = db.execute(
            "SELECT SUM(CASE WHEN content LIKE 'Error%' OR content LIKE '%Traceback%'"
            " OR content LIKE '%failed%' THEN 1 ELSE 0 END), COUNT(*) FROM"
            " (SELECT content FROM messages WHERE role='tool' ORDER BY rowid DESC LIMIT 2000)"
        ).fetchone()
        out["tools"] = {"flagged": bad or 0, "total": tot or 0,
                        "pct": round((bad or 0) / max(1, tot) * 100, 1)}
        out["delivery"] = {r[0]: r[1] for r in db.execute(
            "SELECT state, COUNT(*) FROM delivery_obligations"
            " WHERE created_at>=? GROUP BY 1", (t0,))}
        out["delivery_failed_recent"] = [
            {"platform": r[0], "at": r[1], "err": (r[2] or "")[:120]} for r in db.execute(
                "SELECT platform, created_at, last_error FROM delivery_obligations"
                " WHERE state='failed' ORDER BY created_at DESC LIMIT 5")]
        out["admissions"] = {r[0]: r[1] for r in db.execute(
            "SELECT COALESCE(outcome,'-'), COUNT(*) FROM session_admissions GROUP BY 1")}
        out["cron_incomplete_today"] = db.execute(
            "SELECT COUNT(*) FROM sessions WHERE end_reason='cron_incomplete_no_output'"
            " AND started_at>=?", (t0,)).fetchone()[0]
        db.close()
    except sqlite3.Error as e:
        out["db_error"] = str(e)
    # ---- cron board
    jobs = []
    try:
        import json as _json
        raw = _json.load(open(LOG.parent.parent / "cron" / "jobs.json", encoding="utf-8"))
        jl = raw.get("jobs", raw) if isinstance(raw, dict) else raw
        if isinstance(jl, dict):
            jl = list(jl.values())
        for j in jl:
            if not isinstance(j, dict):
                continue
            sch = j.get("schedule") or {}
            expr = sch.get("expr") or sch.get("value") or sch.get("kind") or ""
            last = j.get("last_run") or j.get("last_run_at") or j.get("last_fire")
            jobs.append({"name": j.get("name", "?"), "enabled": bool(j.get("enabled", True)),
                         "kind": sch.get("kind", ""), "expr": str(expr)[:40], "last": last})
    except (OSError, ValueError):
        pass
    out["cron"] = jobs
    # ---- mnemosyne consolidation verdict
    cons = next((j for j in jobs if "mnemosyne" in j["name"].lower()
                 and "consolid" in j["name"].lower()), None)
    last_ts = None
    if cons and cons.get("last"):
        try:
            last_ts = datetime.fromisoformat(str(cons["last"]).replace("Z", "")).timestamp()
        except ValueError:
            last_ts = None
    age_h = round((datetime.now().timestamp() - last_ts) / 3600, 1) if last_ts else None
    status = "unknown"
    if cons:
        status = "failing" if fail_today else ("stale" if age_h and age_h > 36 else "ok")
    out["consolidation"] = {"job": cons["name"] if cons else None, "status": status,
                            "last_hours": age_h, "failed_today": fail_today,
                            "failed_total": out["errors"]["summarization_failed_total"]}
    _HEALTH_CACHE = (now_ts, out)
    return out

def _discord_name(cid: str) -> dict:
    """Authoritative channel/thread name straight from Discord (read-only GET, 10 min cache)."""
    now = time.time()
    hit = _DNAME.get(cid)
    if hit and now - hit[0] < 600:
        return hit[1]
    out = {}
    try:
        tok = ""
        if os.environ.get("BRAIN_VIEWER_DISCORD") != "1":
            return out          # opt-in: the viewer should not touch your bot token by default
        envf = HERMES_HOME / ".env"
        if envf.exists():
            for line in envf.read_text(encoding="utf-8", errors="ignore").splitlines():
                if line.startswith("DISCORD_BOT_TOKEN="):
                    tok = line.split("=", 1)[1].strip()
                    break
        if not tok or cid in ("", None):
            return out
        req = urllib.request.Request(
            f"https://discord.com/api/v10/channels/{cid}",
            headers={"Authorization": f"Bot {tok}", "User-Agent": "brain-viewer/1"})
        with urllib.request.urlopen(req, timeout=4) as r:
            d = json.loads(r.read().decode())
        nm = {"name": d.get("name") or "", "type": d.get("type"),
              "parent_id": d.get("parent_id") or "", "guild_id": d.get("guild_id") or ""}
        pid = nm["parent_id"]
        if pid and pid != cid:
            hit2 = _DNAME.get(pid)
            if hit2 and now - hit2[0] < 600:
                nm["parent"] = hit2[1].get("name", "")
            else:
                try:
                    req2 = urllib.request.Request(
                        f"https://discord.com/api/v10/channels/{pid}",
                        headers={"Authorization": f"Bot {tok}", "User-Agent": "brain-viewer/1"})
                    with urllib.request.urlopen(req2, timeout=4) as r2:
                        d2 = json.loads(r2.read().decode())
                    nm["parent"] = d2.get("name") or ""
                    _DNAME[pid] = (now, {"name": nm["parent"], "type": d2.get("type")})
                except Exception:
                    nm["parent"] = ""
        out = nm
        _DNAME[cid] = (now, nm)
    except Exception:
        pass
    return out


def _dname_warm(cids) -> None:
    """Resolve names in the background so /api/origins never blocks on Discord latency."""
    def run():
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            list(ex.map(_discord_name, cids))
    threading.Thread(target=run, daemon=True).start()


def origins_stats(limit: int = 8) -> dict:
    """Which Discord channel/thread each prompt comes from — real names, real sessions."""
    from datetime import datetime, time, timedelta
    if not DB.exists():
        return {"error": "state.db missing"}
    t0 = datetime.combine(datetime.now().date(), time()).timestamp()
    try:
        db = _ro()
        rows = db.execute(
            "SELECT id, chat_id, chat_type, thread_id, display_name, origin_json,"
            " last_activity_at, message_count, source FROM sessions"
            " WHERE chat_id IS NOT NULL AND chat_id<>'' AND source='discord'"
            " ORDER BY last_activity_at DESC LIMIT 400").fetchall()
        seen, chans = set(), []
        for r in rows:
            cid = str(r[1])
            if cid in seen:
                continue
            seen.add(cid)
            name = (r[4] or "").strip()
            parent = ""
            if not name:
                try:
                    import json as _json
                    o = _json.loads(r[5] or "{}").get("origin") or {}
                    name = o.get("chat_name") or ""
                    parent = o.get("parent_chat_id") or ""
                except Exception:
                    pass
            chans.append({"chat_id": cid, "name": name, "type": r[2] or "",
                          "thread_id": r[3] or "", "session": r[0],
                          "last": r[6], "messages": r[7] or 0})
            if len(chans) >= limit:
                break
        # inbound traffic per chat, today
        day = datetime.now().strftime("%Y-%m-%d")
        counts, lastmsg = {}, {}
        try:
            with open(LOG, encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    m = RE_INBOUND.search(line)
                    if not m or not line.startswith(day):
                        continue
                    cid = m.group(3)
                    counts[cid] = counts.get(cid, 0) + 1
                    lastmsg[cid] = m.group(4)[:90]
        except OSError:
            pass
        missing = []
        for c in chans:
            c["today"] = counts.get(c["chat_id"], 0)
            c["preview"] = lastmsg.get(c["chat_id"], "")
            hit = _DNAME.get(c["chat_id"])
            live = hit[1] if hit else {}
            if not live:
                missing.append(c["chat_id"])
            c["live"] = bool(live)
            c["pending"] = not live
            kind = {0: "channel", 1: "dm", 2: "voice", 5: "announcement",
                    10: "thread", 11: "thread", 12: "thread"}.get(live.get("type"), "")
            if kind:
                c["type"] = kind
            c["channel"], c["thread"] = "", ""
            if live:
                if kind == "thread" or live.get("parent_id"):
                    c["thread"] = live.get("name") or ""
                    c["channel"] = live.get("parent") or ""
                else:
                    c["channel"] = live.get("name") or ""
            if not c["channel"]:                      # fall back to the recorded chat_name
                parts = [p.strip() for p in (c.get("name") or "").split(" / ") if p.strip()]
                if c["type"] == "dm":
                    c["channel"] = "direct message"
                    c["thread"] = parts[0] if parts else c["chat_id"]
                else:
                    ci = next((i for i, p in enumerate(parts) if p.startswith("#")), -1)
                    if ci >= 0:
                        c["channel"] = parts[ci].lstrip("#")
                        c["thread"] = " ".join(parts[ci + 1:])
                    else:
                        c["channel"] = parts[-1] if parts else c["chat_id"]
            c["label"] = c["thread"] or c["channel"]
        chans.sort(key=lambda c: (-(c["today"] or 0), -(c["last"] or 0)))
        if missing:
            _dname_warm(missing)
        db.close()
        # active chat = chat of the newest inbound line
        active = ""
        if lastmsg:
            try:
                with open(LOG, encoding="utf-8", errors="ignore") as fh:
                    newest = None
                    for line in fh:
                        if "inbound message:" in line:
                            newest = line
                    if newest:
                        m = RE_INBOUND.search(newest)
                        if m:
                            active = m.group(3)
            except OSError:
                pass
        return {"channels": chans, "active": active, "day_counts": counts}
    except sqlite3.Error as e:
        return {"error": str(e)}

# ---------------------------------------------------------------- server

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8",
              cache="no-store", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/api/profile":
                body = profile_payload()
            elif u.path == "/api/live":
                body = parse_live()
            elif u.path == "/api/sessions":
                body = sessions_list()
            elif u.path == "/api/session":
                body = {"messages": session_messages(q.get("id", [""])[0])}
            elif u.path == "/api/journey":
                body = journey()
            elif u.path == "/api/memory":
                body = memory_raw()
            elif u.path == "/api/skill":
                body = skill_content(q.get("name", [""])[0])
            elif u.path == "/api/mnemosyne":
                body = mnemosyne_stats(q.get("tier", [None])[0],
                                       int(q.get("limit", ["25"])[0]))
            elif u.path == "/api/usage":
                body = usage_stats(int(q.get("days", ["7"])[0]))
            elif u.path == "/api/health":
                body = health_stats()
            elif u.path == "/api/origins":
                body = origins_stats(int(q.get("limit", ["8"])[0]))
            elif u.path == "/api/skills":
                body = skills_stats(int(q.get("limit", ["6"])[0]))
            elif u.path == "/api/tools":
                body = tools_stats(int(q.get("limit", ["40"])[0]))
            elif u.path == "/api/think":
                body = think_stats()
            elif u.path == "/api/peek":
                body = peek_stats()
            elif u.path == "/api/delegations":
                body = delegations_stats(int(q.get("limit", ["4"])[0]))
            elif u.path in ("/", "/index.html"):
                return self._send(200, (ROOT / "static" / "index.html").read_bytes(),
                                  "text/html; charset=utf-8")
            elif u.path == "/app.js":
                return self._send(200, (ROOT / "static" / "app.js").read_bytes(),
                                  "text/javascript; charset=utf-8")
            elif u.path == "/style.css":
                return self._send(200, (ROOT / "static" / "style.css").read_bytes(),
                                  "text/css; charset=utf-8")
            elif u.path == "/sw.js":
                # served from the root scope on purpose: a worker under /static could not
                # control the app shell. never cached, or a stale worker pins old JS forever.
                return self._send(200, (ROOT / "static" / "sw.js").read_bytes(),
                                  "text/javascript; charset=utf-8", cache="no-store",
                                  extra={"Service-Worker-Allowed": "/"})
            elif u.path == "/manifest.webmanifest":
                return self._send(200, (ROOT / "static" / "manifest.webmanifest").read_bytes(),
                                  "application/manifest+json; charset=utf-8", cache="no-store")
            elif u.path in ("/favicon.ico",) or u.path.startswith("/icon-"):
                name = u.path.lstrip("/")
                fp = (ROOT / "static" / name)
                if not fp.is_file() or fp.suffix not in (".png", ".ico"):
                    return self._send(404, b'{"error":"not found"}')
                ctype = "image/png" if fp.suffix == ".png" else "image/x-icon"
                return self._send(200, fp.read_bytes(), ctype, cache="public, max-age=86400")
            else:
                return self._send(404, b'{"error":"not found"}')
            self._send(200, json.dumps(body, ensure_ascii=False, default=str).encode("utf-8"))
        except Exception as e:
            self._send(500, json.dumps({"error": str(e)}).encode("utf-8"))

if __name__ == "__main__":
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--port" in sys.argv:
        PORT = int(sys.argv[sys.argv.index("--port") + 1])
    HOST = "127.0.0.1"
    if "--host" in sys.argv:
        HOST = sys.argv[sys.argv.index("--host") + 1]
    if DEMO:
        try:
            import demo.live as demo_live
            demo_live.start()
            print("[brain] demo mode: writing a scripted turn into demo/agent.log")
        except Exception as e:
            print(f"[brain] demo writer unavailable: {e}")
    print(f"[brain] HERMES_HOME={HERMES_HOME}")
    print(f"[brain] http://{HOST}:{PORT}  (read-only)")
    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
