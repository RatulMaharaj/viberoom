import { createContext, useContext, useState, type ReactNode } from 'react'
import { Bot } from 'lucide-react'
import { AgentPanel } from './AgentPanel'

/** App-wide dock for the Claude Code panel.
 *
 * The panel lives in the shell rather than in a page, so the session — and its
 * WebSocket — survives navigation between Library and Develop.
 */

const AgentContext = createContext<{ open: boolean; toggle: () => void }>({
  open: false,
  toggle: () => {},
})

export const useAgent = () => useContext(AgentContext)

/** Toolbar button. Drop it into any page's navbar. */
export function AgentToggle() {
  const { open, toggle } = useAgent()
  return (
    <button
      className={`btn btn-sm ${open ? 'btn-primary' : 'btn-ghost'}`}
      title="Claude Code session (in-app)"
      onClick={toggle}
    >
      <Bot size={14} />
    </button>
  )
}

export function AgentDock({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <AgentContext.Provider value={{ open, toggle: () => setOpen((v) => !v) }}>
      <div className="h-screen flex overflow-hidden">
        <div className="flex-1 min-w-0 overflow-y-auto">{children}</div>
        {open && <AgentPanel onClose={() => setOpen(false)} />}
      </div>
    </AgentContext.Provider>
  )
}
