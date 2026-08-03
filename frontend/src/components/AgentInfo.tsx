import { useState } from 'react'
import { Check, Copy, Plug } from 'lucide-react'

const MCP_CMD = 'claude mcp add --transport http viberoom http://127.0.0.1:8423/mcp'
const API_URL = `${window.location.origin}/api/v1`

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="text-xs opacity-60 mb-1">{label}</div>
      <div className="flex items-center gap-1">
        <code className="bg-base-300 rounded px-2 py-1.5 text-xs flex-1 overflow-x-auto whitespace-nowrap">
          {value}
        </code>
        <button
          className="btn btn-sm btn-square btn-ghost"
          onClick={() => {
            navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  )
}

export function AgentInfoButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className="btn btn-sm btn-ghost btn-square"
        title="Connect an external agent (MCP / REST)"
        onClick={() => setOpen(true)}
      >
        <Plug size={16} />
      </button>
      {open && (
        <dialog className="modal modal-open">
          <div className="modal-box max-w-xl">
            <h3 className="font-bold flex items-center gap-2">
              <Plug size={18} /> Point your agent here
            </h3>
            <p className="text-sm opacity-70 mt-1 mb-3">
              All editing in Viberoom is agent-drivable. Use the sidebar for a session
              right here, or connect your own agent:
            </p>
            <div className="space-y-3">
              <CopyRow label="MCP (Claude Code) — served over HTTP by this server; no paths to keep in sync" value={MCP_CMD} />
              <CopyRow label="REST API — interactive docs at /api/v1/docs" value={API_URL} />
              <CopyRow
                label="Sidecar files — edit JSON next to your images, then rescan"
                value="<image>.vibe.json  ·  POST /api/v1/library/scan"
              />
            </div>
            <p className="text-xs opacity-50 mt-3">
              Try: “open my library, auto-adjust my current image, then export the picks at quality 85”
            </p>
            <div className="modal-action">
              <button className="btn btn-sm" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </div>
          <div className="modal-backdrop" onClick={() => setOpen(false)} />
        </dialog>
      )}
    </>
  )
}
