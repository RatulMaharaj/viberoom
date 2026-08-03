"""Embedded Claude Code session.

Drives the user's *local* `claude` install as a long-lived subprocess in
stream-json mode and bridges it to the browser over a WebSocket. Nothing to
configure: the CLI brings its own auth, its own CLAUDE.md, and its own MCP
servers — we only add viberoom's on top.

Tool permissions are routed back into the UI via a permission-prompt MCP
server (see permission_mcp.py), so the agent can't touch originals without a
click. viberoom's own MCP tools are pre-allowed; they only ever write sidecars.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

# viberoom's own tools are non-destructive by design (sidecars only), so they
# skip the prompt. Everything else — bash, write, edit — asks.
PRE_ALLOWED = "mcp__viberoom"

PERMISSION_TIMEOUT = 300.0

# The session inherits the user's own settings — that's what makes setup
# zero-effort — but a global `permissions.allow: ["Bash", "Edit"]` would then
# silently disarm our prompt. `ask` outranks `allow`, so we re-arm it per
# session without touching the user's config.
ASK_TOOLS = ["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch"]
EDIT_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit"}

# Modes that mean "stop asking" — re-arming the prompt would contradict them.
NO_PROMPT_MODES = {"bypassPermissions", "dontAsk", "auto"}

MODELS = ["default", "fable", "opus", "sonnet", "haiku"]
EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"]
PERMISSION_MODES = ["manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]

DEFAULT_CONFIG = {"model": "default", "effort": "default", "permission_mode": "manual"}


def detect() -> dict:
    """Locate the local `claude` install, if any."""
    path = shutil.which("claude")
    if path is None:
        return {"available": False, "path": None, "version": None}
    version = None
    try:
        out = subprocess.run(
            [path, "--version"], capture_output=True, text=True, timeout=10
        )
        if out.returncode == 0:
            version = out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return {"available": True, "path": path, "version": version}


def _mcp_config(base_url: str) -> Path:
    """Write an --mcp-config wiring the session to viberoom's tools.

    Both servers are mounted on the viberoom HTTP server, so this is pure URL
    config — no subprocess to spawn and no dependency on running from a source
    checkout.
    """
    config = {
        "mcpServers": {
            "viberoom": {"type": "http", "url": f"{base_url}/mcp"},
            "viberoom_approve": {"type": "http", "url": f"{base_url}/mcp-approve"},
        }
    }
    fd, name = tempfile.mkstemp(prefix="viberoom-mcp-", suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(config, f)
    return Path(name)


def _session_settings(permission_mode: str) -> Path:
    """Settings that force a prompt for anything that writes or executes.

    Narrowed to match the chosen mode: acceptEdits shouldn't then be asked
    about edits, and the no-prompt modes opt out of the ask list entirely.
    """
    ask = list(ASK_TOOLS)
    if permission_mode == "acceptEdits":
        ask = [t for t in ask if t not in EDIT_TOOLS]
    elif permission_mode in NO_PROMPT_MODES:
        ask = []
    settings = {"permissions": {"ask": ask}}
    fd, name = tempfile.mkstemp(prefix="viberoom-settings-", suffix=".json")
    with os.fdopen(fd, "w") as f:
        json.dump(settings, f)
    return Path(name)


class PermissionBroker:
    """Pending tool-approval requests, keyed by id.

    The permission MCP server (a separate process) POSTs a request here and
    blocks; the UI answers over the WebSocket and unblocks it.
    """

    def __init__(self) -> None:
        self._pending: dict[str, asyncio.Future[dict]] = {}

    async def ask(self, session: AgentSession, tool_name: str, tool_input: Any) -> dict:
        req_id = uuid.uuid4().hex[:12]
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict] = loop.create_future()
        self._pending[req_id] = fut
        await session.emit(
            {
                "type": "permission_request",
                "id": req_id,
                "tool_name": tool_name,
                "input": tool_input,
            }
        )
        try:
            return await asyncio.wait_for(fut, PERMISSION_TIMEOUT)
        except asyncio.TimeoutError:
            return {"behavior": "deny", "message": "Timed out waiting for approval."}
        finally:
            self._pending.pop(req_id, None)

    def resolve(self, req_id: str, allow: bool, message: str | None = None) -> bool:
        fut = self._pending.get(req_id)
        if fut is None or fut.done():
            return False
        fut.set_result(
            {"behavior": "allow"}
            if allow
            else {"behavior": "deny", "message": message or "Denied by the user."}
        )
        return True


broker = PermissionBroker()


class AgentSession:
    """One `claude` subprocess plus the socket watching it."""

    def __init__(self, cwd: Path, base_url: str) -> None:
        self.cwd = cwd
        self.base_url = base_url
        self.config = dict(DEFAULT_CONFIG)
        self.proc: asyncio.subprocess.Process | None = None
        self.session_id: str | None = None
        self._config_path: Path | None = None
        self._settings_path: Path | None = None
        self._pump: asyncio.Task | None = None
        self._subscribers: set[asyncio.Queue] = set()
        self._history: list[dict] = []

    # ---------- fan-out to connected sockets ----------

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    async def emit(self, frame: dict) -> None:
        self._history.append(frame)
        del self._history[:-500]
        for q in list(self._subscribers):
            q.put_nowait(frame)

    def replay(self) -> list[dict]:
        return list(self._history)

    # ---------- lifecycle ----------

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def start(self) -> None:
        if self.running:
            return
        info = detect()
        if not info["available"]:
            raise RuntimeError("`claude` was not found on PATH.")

        mode = self.config.get("permission_mode", "manual")
        self._config_path = _mcp_config(self.base_url)
        self._settings_path = _session_settings(mode)
        args = [
            info["path"],
            "--print",
            "--verbose",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--mcp-config", str(self._config_path),
            "--settings", str(self._settings_path),
            "--allowedTools", PRE_ALLOWED,
        ]
        # Only wire the prompt tool for modes that actually prompt.
        if mode not in NO_PROMPT_MODES:
            args += [
                "--permission-prompt-tool",
                "mcp__viberoom_approve__permission_prompt",
            ]
        if mode != "manual":
            args += ["--permission-mode", mode]
        if self.config.get("model", "default") != "default":
            args += ["--model", self.config["model"]]
        if self.config.get("effort", "default") != "default":
            args += ["--effort", self.config["effort"]]
        self.proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(self.cwd),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._pump = asyncio.create_task(self._read_stdout())
        asyncio.create_task(self._read_stderr())
        await self.emit(
            {
                "type": "status",
                "running": True,
                "cwd": str(self.cwd),
                "config": dict(self.config),
            }
        )

    async def configure(self, changes: dict) -> None:
        """Apply launch-flag changes. These only take effect on a fresh
        process, so restart — the UI says as much before you pick."""
        valid = {
            "model": MODELS,
            "effort": EFFORTS,
            "permission_mode": PERMISSION_MODES,
        }
        for key, allowed in valid.items():
            if key in changes and changes[key] in allowed:
                self.config[key] = changes[key]
        was_running = self.running
        await self.stop()
        await self.emit({"type": "config", "config": dict(self.config)})
        if was_running:
            await self.start()

    async def stop(self) -> None:
        if self.proc is not None and self.proc.returncode is None:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), 5)
            except asyncio.TimeoutError:
                self.proc.kill()
        if self._pump is not None:
            self._pump.cancel()
        for attr in ("_config_path", "_settings_path"):
            path = getattr(self, attr)
            if path is not None:
                path.unlink(missing_ok=True)
                setattr(self, attr, None)
        self.proc = None
        self.session_id = None
        self._history.clear()
        await self.emit({"type": "status", "running": False})

    async def send(self, text: str, echo: str | None = None) -> None:
        """Send `text` to the CLI, but show `echo` in the UI.

        They differ because we staple a context block onto the prompt; the
        user should see what they typed, not the plumbing.
        """
        if not self.running:
            await self.start()
        assert self.proc is not None and self.proc.stdin is not None
        frame = {
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": text}]},
        }
        await self.emit({"type": "user", "text": echo if echo is not None else text})
        self.proc.stdin.write((json.dumps(frame) + "\n").encode())
        await self.proc.stdin.drain()

    # ---------- stream translation ----------

    async def _read_stdout(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            for frame in self._translate(msg):
                await self.emit(frame)
        await self.emit({"type": "status", "running": False})

    async def _read_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        while True:
            line = await self.proc.stderr.readline()
            if not line:
                break
            print(f"[claude] {line.decode(errors='replace').rstrip()}", file=sys.stderr)

    def _translate(self, msg: dict) -> list[dict]:
        """Turn the CLI's stream-json into the small vocabulary the UI speaks."""
        kind = msg.get("type")

        if kind == "system" and msg.get("subtype") == "init":
            self.session_id = msg.get("session_id")
            return [{"type": "ready", "session_id": self.session_id,
                     "model": msg.get("model")}]

        if kind == "stream_event":
            event = msg.get("event", {})
            if event.get("type") == "content_block_delta":
                delta = event.get("delta", {})
                if delta.get("type") == "text_delta":
                    return [{"type": "text_delta", "text": delta.get("text", "")}]
            return []

        if kind == "assistant":
            out = []
            for block in msg.get("message", {}).get("content", []):
                if block.get("type") == "text" and block.get("text", "").strip():
                    out.append({"type": "text", "text": block["text"]})
                elif block.get("type") == "tool_use":
                    out.append(
                        {
                            "type": "tool_use",
                            "id": block.get("id"),
                            "name": block.get("name"),
                            "input": block.get("input"),
                        }
                    )
            return out

        if kind == "user":
            out = []
            for block in msg.get("message", {}).get("content", []):
                if block.get("type") == "tool_result":
                    out.append(
                        {
                            "type": "tool_result",
                            "id": block.get("tool_use_id"),
                            "is_error": bool(block.get("is_error")),
                        }
                    )
            return out

        if kind == "result":
            return [
                {
                    "type": "turn_end",
                    "is_error": bool(msg.get("is_error")),
                    "cost_usd": msg.get("total_cost_usd"),
                    "duration_ms": msg.get("duration_ms"),
                }
            ]

        return []


_session: AgentSession | None = None


def session(cwd: Path, base_url: str) -> AgentSession:
    """The process-wide session, restarted if the library moved."""
    global _session
    if _session is None or _session.cwd != cwd:
        _session = AgentSession(cwd, base_url)
    return _session


def current() -> AgentSession | None:
    return _session
