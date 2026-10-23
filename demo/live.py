"""Keep the demo log alive.

The viewer's live column is not a websocket: it tails `agent.log` and parses it. So the demo
does not fake API responses — it writes a believable log at a believable pace, and every other
part of the app runs exactly as it does against a real Hermes install.

One cycle is a real turn: an inbound message, six API calls, five tool calls, three streamed
batches, the delivery, the turn end. Then it sits idle for a while, because a graph that never
rests reads as decoration.
"""
from __future__ import annotations

import random
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOG = HERE / "agent.log"
SID = "20261023_152001_demo"
MODEL = "claude-sonnet-4-5"
PROVIDER = "anthropic"

ASK = ("The nightly digest did not run on Tuesday. Find out why and fix the schedule.")

# (delay before the line, body) — timings mirror a real turn, not an animation
CYCLE: list[tuple[float, str]] = [
    (0.0, f"[{SID}] conversation turn: session={SID} model={MODEL} provider={PROVIDER} "
          f"platform=discord history=42"),
    (0.4, f"inbound message: platform=discord user=you chat=123456789 msg='{ASK}' reply_to_id="),
    (0.8, "API call #1: model=%s provider=%s in=18240 out=412 total=18652 latency=2.8s "
          "cache=12800/18240 (70%%)" % (MODEL, PROVIDER)),
    (0.4, "tool read_file completed (0.31s, 1204 chars)"),
    (1.1, "API call #2: model=%s provider=%s in=19460 out=286 total=19746 latency=1.9s "
          "cache=17200/19460 (88%%)" % (MODEL, PROVIDER)),
    (0.5, "tool terminal completed (1.42s, 8190 chars)"),
    (0.9, "API call #3: model=%s provider=%s in=20880 out=344 total=21224 latency=2.2s "
          "cache=19800/20880 (95%%)" % (MODEL, PROVIDER)),
    (0.6, "tool execute_code completed (0.94s, 2210 chars)"),
    (1.2, "API call #4: model=%s provider=%s in=22410 out=508 total=22918 latency=2.6s "
          "cache=21000/22410 (94%%)" % (MODEL, PROVIDER)),
    (0.5, "tool mcp__playwright__browser_navigate completed (3.20s, 640 chars)"),
    (1.4, "API call #5: model=%s provider=%s in=23560 out=196 total=23756 latency=1.7s "
          "cache=22800/23560 (97%%)" % (MODEL, PROVIDER)),
    (0.4, "tool patch completed (0.24s, 88 chars)"),
    (1.0, "API call #6: model=%s provider=%s in=24020 out=642 total=24662 latency=2.4s "
          "cache=23400/24020 (97%%)" % (MODEL, PROVIDER)),
    (0.5, "[discord] Flushing text batch 4812 (142 chars)"),
    (0.7, "[discord] Flushing text batch 4812 (208 chars)"),
    (0.9, "[discord] Flushing text batch 4812 (291 chars)"),
    (0.8, "response ready: platform=discord chat=123456789 time=21.6s response=642"),
    (0.3, "Turn ended: reason=complete"),
]

# how long the brain rests between turns (seconds)
IDLE = (14.0, 26.0)


def _stamp() -> str:
    t = time.time()
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)) + ",%03d" % int((t % 1) * 1000)


def _trim() -> None:
    try:
        if LOG.stat().st_size < 400_000:
            return
        lines = LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-600:]
        LOG.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass


def run() -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            with open(LOG, "a", encoding="utf-8") as f:
                for delay, body in CYCLE:
                    time.sleep(delay)
                    f.write(f"{_stamp()} INFO {body}\n")
                    f.flush()
            _trim()
            time.sleep(random.uniform(*IDLE))
        except Exception:
            time.sleep(5)


def start() -> threading.Thread:
    th = threading.Thread(target=run, name="demo-live", daemon=True)
    th.start()
    return th
