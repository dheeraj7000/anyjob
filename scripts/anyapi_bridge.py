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


class DaemonBridgeError(Exception):
    """Wraps the daemon's structured error dict (kind/message/retry_after/
    debug_path -- see anyapi.shared.errors.DaemonError.to_dict()) so main()
    can forward it as JSON fields instead of collapsing it into str(dict),
    which throws away retry_after and leaves the Node side unable to tell a
    genuine rate limit (with a known wait time) from any other failure."""

    def __init__(self, data):
        self.data = data if isinstance(data, dict) else {"message": str(data)}
        super().__init__(self.data.get("message", str(data)))


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
            raise DaemonBridgeError(event.data)
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
    except DaemonBridgeError as e:
        payload = {"type": "error", "error": e.data.get("message", str(e))}
        if "kind" in e.data:
            payload["kind"] = e.data["kind"]
        if "retry_after" in e.data:
            payload["retry_after"] = e.data["retry_after"]
        emit(payload)
        sys.exit(1)
    except Exception as e:
        emit({"type": "error", "error": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
