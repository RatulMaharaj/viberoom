import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Check, RotateCcw, Send, Settings2, Terminal, X } from 'lucide-react'

/** A live Claude Code session, driven by the user's local `claude` install. */

type Frame =
  | { type: 'status'; running: boolean; cwd?: string }
  | { type: 'ready'; session_id: string; model?: string }
  | { type: 'user'; text: string }
  | { type: 'text'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; is_error: boolean }
  | { type: 'permission_request'; id: string; tool_name: string; input: unknown }
  | { type: 'turn_end'; is_error: boolean; cost_usd?: number }
  | { type: 'config'; config: Config }
  | { type: 'error'; message: string }

type Config = { model: string; effort: string; permission_mode: string }
type Options = { model: string[]; effort: string[]; permission_mode: string[] }

type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; state: 'running' | 'ok' | 'error' }
  | { kind: 'notice'; text: string }

type Ask = { id: string; tool_name: string; input: unknown }

type Status = {
  available: boolean
  version: string | null
  cwd: string | null
  config: Config
  options: Options
}

/** `manual` is the CLI's name; "Ask every time" is what it does. */
const MODE_LABELS: Record<string, string> = {
  manual: 'Ask every time',
  acceptEdits: 'Auto-accept edits',
  plan: 'Plan only (read-only)',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Never ask (unsafe)',
}

/** Strip the MCP prefix so `mcp__viberoom__update_recipe` reads as `update_recipe`. */
function toolLabel(name: string) {
  const parts = name.split('__')
  return parts.length > 1 ? parts[parts.length - 1] : name
}

function summarize(input: unknown) {
  if (input == null) return ''
  if (typeof input === 'string') return input
  const o = input as Record<string, unknown>
  const first = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.image_id
  if (typeof first === 'string') return first
  const json = JSON.stringify(input)
  return json.length > 120 ? json.slice(0, 120) + '…' : json
}

export function AgentPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [asks, setAsks] = useState<Ask[]>([])
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [config, setConfig] = useState<Config | null>(null)
  const ws = useRef<WebSocket | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/v1/agent/status')
      .then((r) => r.json())
      .then((s: Status) => {
        setStatus(s)
        setConfig(s.config)
      })
      .catch(() =>
        setStatus({
          available: false,
          version: null,
          cwd: null,
          config: { model: 'default', effort: 'default', permission_mode: 'manual' },
          options: { model: [], effort: [], permission_mode: [] },
        }),
      )
  }, [])

  const apply = useCallback((f: Frame) => {
    setEntries((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      switch (f.type) {
        case 'user':
          next.push({ kind: 'user', text: f.text })
          break
        case 'text_delta':
          // Deltas stream into the open assistant bubble; the final `text`
          // frame for the same block replaces it.
          if (last?.kind === 'assistant') next[next.length - 1] = { kind: 'assistant', text: last.text + f.text }
          else next.push({ kind: 'assistant', text: f.text })
          break
        case 'text':
          if (last?.kind === 'assistant') next[next.length - 1] = { kind: 'assistant', text: f.text }
          else next.push({ kind: 'assistant', text: f.text })
          break
        case 'tool_use':
          next.push({ kind: 'tool', id: f.id, name: f.name, input: f.input, state: 'running' })
          break
        case 'tool_result': {
          const i = next.findIndex((e) => e.kind === 'tool' && e.id === f.id)
          if (i >= 0) next[i] = { ...(next[i] as Extract<Entry, { kind: 'tool' }>), state: f.is_error ? 'error' : 'ok' }
          break
        }
        case 'config':
          next.push({
            kind: 'notice',
            text: `Session restarted — model ${f.config.model}, effort ${f.config.effort}, ${
              MODE_LABELS[f.config.permission_mode] ?? f.config.permission_mode
            }.`,
          })
          break
        case 'error':
          next.push({ kind: 'notice', text: f.message })
          break
      }
      return next
    })

    if (f.type === 'config') {
      setConfig(f.config)
    }
    if (f.type === 'permission_request') {
      setAsks((a) => [...a, { id: f.id, tool_name: f.tool_name, input: f.input }])
    } else if (f.type === 'user') {
      setBusy(true)
    } else if (f.type === 'turn_end') {
      setBusy(false)
    } else if (f.type === 'status' && !f.running) {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!status?.available) return
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const sock = new WebSocket(`${proto}//${window.location.host}/api/v1/agent/ws`)
    ws.current = sock
    sock.onmessage = (e) => apply(JSON.parse(e.data) as Frame)
    sock.onclose = () => setBusy(false)
    return () => sock.close()
  }, [status?.available, apply])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [entries, asks])

  function send() {
    const text = draft.trim()
    if (!text || !ws.current) return
    ws.current.send(JSON.stringify({ type: 'user', text }))
    setDraft('')
  }

  function decide(id: string, allow: boolean) {
    ws.current?.send(JSON.stringify({ type: 'permission', id, allow }))
    setAsks((a) => a.filter((x) => x.id !== id))
  }

  function change(key: keyof Config, value: string) {
    if (!config) return
    const next = { ...config, [key]: value }
    setConfig(next)
    // Launch flags only bind on a fresh process, so this restarts the session.
    setEntries([])
    setAsks([])
    ws.current?.send(JSON.stringify({ type: 'config', config: next }))
  }

  function reset() {
    ws.current?.send(JSON.stringify({ type: 'reset' }))
    setEntries([])
    setAsks([])
    setBusy(false)
  }

  return (
    <div className="w-96 shrink-0 border-l border-base-300/40 bg-base-100 flex flex-col min-h-0 relative z-20">
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-base-300/40">
        <Bot size={15} />
        <span className="text-xs font-bold uppercase tracking-wide">Claude Code</span>
        {busy && <span className="loading loading-dots loading-xs" />}
        <div className="flex-1" />
        <button
          className={`btn btn-xs btn-square ${showSettings ? 'btn-primary' : 'btn-ghost'}`}
          title="Model, effort & permissions"
          onClick={() => setShowSettings((v) => !v)}
        >
          <Settings2 size={13} />
        </button>
        <button className="btn btn-xs btn-ghost btn-square" title="New session" onClick={reset}>
          <RotateCcw size={13} />
        </button>
        <button className="btn btn-xs btn-ghost btn-square" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      {showSettings && status?.available && config && (
        <div className="shrink-0 border-b border-base-300/40 p-2 space-y-1.5 text-xs bg-base-200/40">
          {(
            [
              ['model', 'Model'],
              ['effort', 'Effort'],
              ['permission_mode', 'Permissions'],
            ] as [keyof Config, string][]
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <span className="w-20 opacity-60">{label}</span>
              <select
                className="select select-xs select-bordered flex-1"
                value={config[key]}
                onChange={(e) => change(key, e.target.value)}
              >
                {status.options[key].map((o) => (
                  <option key={o} value={o}>
                    {key === 'permission_mode' ? MODE_LABELS[o] ?? o : o}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <p className="opacity-50 leading-snug">
            Changing any of these restarts the session — the conversation starts fresh.
            {config.permission_mode === 'bypassPermissions' && (
              <span className="text-warning">
                {' '}
                Nothing will ask before running commands in your library.
              </span>
            )}
          </p>
        </div>
      )}

      {status && !status.available ? (
        <div className="p-4 text-xs space-y-2 opacity-70">
          <p className="flex items-center gap-1.5 font-bold opacity-100">
            <Terminal size={13} /> No local Claude Code found
          </p>
          <p>Install it, then reopen this panel:</p>
          <code className="block bg-base-300 rounded px-2 py-1.5 font-mono">
            npm i -g @anthropic-ai/claude-code
          </code>
          <p>The sidebar uses your existing login — nothing to configure here.</p>
        </div>
      ) : (
        <>
          <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 text-xs">
            {entries.length === 0 && (
              <p className="opacity-50">
                Ask about the open photo — “why is this underexposed?”, “drop it two stops and
                warm it up”, “rate everything sharp in this folder”.
              </p>
            )}
            {entries.map((e, i) => {
              if (e.kind === 'user')
                return (
                  <div key={i} className="bg-base-300 rounded px-2.5 py-1.5 whitespace-pre-wrap">
                    {e.text}
                  </div>
                )
              if (e.kind === 'assistant')
                return (
                  <div key={i} className="whitespace-pre-wrap leading-relaxed">
                    {e.text}
                  </div>
                )
              if (e.kind === 'notice')
                return (
                  <div key={i} className="text-error">
                    {e.text}
                  </div>
                )
              return (
                <div key={i} className="flex items-baseline gap-1.5 font-mono opacity-60">
                  <span className={e.state === 'error' ? 'text-error' : e.state === 'ok' ? 'text-success' : ''}>
                    {e.state === 'running' ? '·' : e.state === 'ok' ? '✓' : '✗'}
                  </span>
                  <span className="font-bold">{toolLabel(e.name)}</span>
                  <span className="truncate opacity-70">{summarize(e.input)}</span>
                </div>
              )
            })}

            {asks.map((a) => (
              <div key={a.id} className="border border-warning/50 rounded p-2 space-y-1.5">
                <p className="font-bold">
                  Allow <span className="font-mono">{toolLabel(a.tool_name)}</span>?
                </p>
                <p className="font-mono opacity-60 break-all">{summarize(a.input)}</p>
                <div className="flex gap-1.5">
                  <button className="btn btn-xs btn-success" onClick={() => decide(a.id, true)}>
                    <Check size={12} /> Allow
                  </button>
                  <button className="btn btn-xs btn-ghost" onClick={() => decide(a.id, false)}>
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="shrink-0 border-t border-base-300/40 p-2 flex gap-1.5 items-end">
            <textarea
              className="textarea textarea-bordered textarea-xs flex-1 resize-none leading-snug"
              rows={2}
              placeholder="Ask Claude…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
                e.stopPropagation() // don't trigger the editor's global shortcuts
              }}
            />
            <button className="btn btn-xs btn-primary btn-square" onClick={send} disabled={!draft.trim()}>
              <Send size={13} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}
