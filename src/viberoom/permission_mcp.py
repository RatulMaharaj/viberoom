"""Permission-prompt MCP server, mounted in-process at /mcp-approve.

Claude Code calls this (via --permission-prompt-tool) whenever the embedded
session wants a tool that isn't pre-allowed. It hands the request to the
broker, which surfaces approve/deny buttons in the sidebar, and blocks until
the user decides.
"""

from __future__ import annotations

import json
from typing import Any

from mcp.server.mcpserver import MCPServer

from viberoom import agent

mcp = MCPServer("viberoom_approve")


@mcp.tool(structured_output=False)
async def permission_prompt(
    tool_name: str, input: dict[str, Any], tool_use_id: str = ""
) -> str:
    """Ask the viberoom user to approve a tool call. Returns the decision.

    structured_output=False matters: the CLI requires the result to be a
    single text block, and an advertised output schema adds a structured
    companion that makes it reject the decision as malformed.
    """
    session = agent.current()
    if session is None:
        decision = {"behavior": "deny", "message": "No agent session is open."}
    else:
        decision = await agent.broker.ask(session, tool_name, input)

    if decision.get("behavior") == "allow":
        # Echo the input back unchanged; the CLI expects updatedInput on allow.
        return json.dumps({"behavior": "allow", "updatedInput": input})
    return json.dumps(
        {"behavior": "deny", "message": decision.get("message", "Denied.")}
    )
