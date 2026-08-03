/** Toolbar button reporting what an AI agent can do with this page.
 *
 *  The old button opened a Claude Code session the app had launched itself.
 *  A page cannot start a process, so the arrangement is inverted now: the user
 *  brings an agent and viberoom offers it tools through WebMCP. There is
 *  nothing to open, so this reports state instead — whether the browser
 *  supports it, and which tools are live.
 */
import { useState } from 'react'
import { Bot } from 'lucide-react'
import { webmcpToolCount, webmcpToolNames } from '../webmcp'

export function AgentToolsButton() {
  const [open, setOpen] = useState(false)
  const count = webmcpToolCount()
  const supported = typeof navigator !== 'undefined' && 'modelContext' in navigator

  return (
    <div className="relative">
      <button
        className={`btn btn-sm ${count ? 'btn-primary' : 'btn-ghost'}`}
        title={
          count
            ? `${count} tools available to an AI agent`
            : 'No agent tools — needs Chrome 146+ with WebMCP enabled'
        }
        onClick={() => setOpen((v) => !v)}
      >
        <Bot size={14} />
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-80 rounded-box bg-base-200 p-4 shadow-lg text-sm">
          {count > 0 ? (
            <>
              <p className="font-medium mb-1">An agent can drive this page</p>
              <p className="opacity-70 mb-2">
                {count} tools are published to whatever AI agent your browser provides.
                Nothing runs unless you ask it to.
              </p>
              <ul className="font-mono text-xs opacity-70 leading-5">
                {webmcpToolNames().map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
              <p className="opacity-70 mt-2">
                Editing a recipe outright asks you to confirm first.
              </p>
              {/* The distinction people get wrong: these tools are published
                  *into the page*, so only something running in the browser can
                  see them. An agent on your machine cannot reach into a tab. */}
              <p className="opacity-70 mt-2 border-t border-base-300 pt-2">
                Reachable by agents running <em>in the browser</em> — Chrome's own,
                or an extension. An agent on your computer, like Claude Code,
                cannot see into a page: run the{' '}
                <code className="text-xs">viberoom-mcp</code> server from the
                Python package for that.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium mb-1">No agent tools published</p>
              <p className="opacity-70">
                {supported
                  ? 'Your browser supports WebMCP but the tools did not register — check the console.'
                  : 'Needs Chrome 146 or later, with WebMCP enabled at chrome://flags/#enable-webmcp-testing.'}
              </p>
              <p className="opacity-70 mt-2">
                To drive viberoom from Claude Code instead, run the{' '}
                <code className="text-xs">viberoom-mcp</code> server.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
