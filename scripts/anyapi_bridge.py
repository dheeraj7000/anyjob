#!/usr/bin/env python3
"""
Thin bridge between anyjob's Node LLM provider and anyapi's daemon.

Reads a JSON request on stdin: {"prompt": "...", "socket_path": "...(optional)"}
Sends it to a running `anyapi-daemon` over its Unix socket via anyapi's own
DaemonClient, and streams each event straight to stdout as its own JSON line
(flushed immediately) so the Node side can show live progress instead of
waiting silently for the whole reply:
  {"type": "status", "message": "..."}   -- daemon status update (e.g. typing)
  {"type": "token", "message": "..."}    -- one streamed text chunk
  {"type": "done", "text": "..."}        -- final full reply text
  {"type": "error", "error": "..."}      -- something went wrong

Requires the daemon to already be running (see anyjob README section on
DeepSeek setup) -- this script does not launch Chromium itself, it only
talks to an existing daemon socket.
"""
import asyncio
import json
import os
import sys
from pathlib import Path

from anyapi.cli.client import DaemonClient

DEFAULT_BASE = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "anyapi"


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


async def ask(socket_path: Path, prompt: str) -> str:
    client = DaemonClient(socket_path)
    text_parts = []
    async for event in client.send_request("ask", {"prompt": prompt}):
        if event.event == "token":
            text_parts.append(event.data)
            emit({"type": "token", "message": event.data})
        elif event.event == "status":
            emit({"type": "status", "message": str(event.data)})
        elif event.event == "done":
            # Some providers only emit a final "done" with the full text,
            # rather than incremental tokens -- prefer that if present.
            if isinstance(event.data, dict) and event.data.get("text"):
                return event.data["text"]
            return "".join(text_parts)
        elif event.event == "error":
            raise RuntimeError(str(event.data))
    return "".join(text_parts)


def main() -> None:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        emit({"type": "error", "error": f"invalid JSON on stdin: {e}"})
        sys.exit(1)

    prompt = req.get("prompt", "")
    provider = req.get("provider", "deepseek")
    socket_path = Path(req["socket_path"]) if req.get("socket_path") else DEFAULT_BASE / f"{provider}_daemon.sock"

    if not socket_path.exists():
        emit({
            "type": "error",
            "error": f"anyapi daemon socket not found at {socket_path}. "
                     f"Start it first: anyapi-daemon --provider {provider}"
        })
        sys.exit(1)

    try:
        text = asyncio.run(ask(socket_path, prompt))
        emit({"type": "done", "text": text})
    except Exception as e:
        emit({"type": "error", "error": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
