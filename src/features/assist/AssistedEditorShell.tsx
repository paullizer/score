import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { PanelRightClose, PanelRightOpen, Redo2, Undo2 } from 'lucide-react'
import { Button } from '../../components/ui'
import '../../styles/assisted-editing.css'

export interface AssistedEditorPanel {
  id: string
  label: string
  icon?: LucideIcon
  badge?: string | number
  content: ReactNode
}

export interface AssistedEditorShellProps {
  main: ReactNode
  panels: AssistedEditorPanel[]
  activePanel: string | null
  onActivePanelChange: (id: string | null) => void
  sideLabel: string
  history?: {
    canUndo: boolean
    canRedo: boolean
    undoLabel: string
    redoLabel: string
    onUndo: () => void
    onRedo: () => void
    disabled?: boolean
  }
  summary?: {
    total: number
    ai: number
    onReview: () => void
    onNext: () => void
  }
  busy?: boolean
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

export function AssistedEditorShell({
  main,
  panels,
  activePanel,
  onActivePanelChange,
  sideLabel,
  history,
  summary,
  busy = false,
}: AssistedEditorShellProps) {
  const firstPanelId = panels[0]?.id ?? null
  const selectedPanelId = activePanel && panels.some(panel => panel.id === activePanel) ? activePanel : firstPanelId
  const selectedPanel = panels.find(panel => panel.id === selectedPanelId)
  const [compactPane, setCompactPane] = useState<'editor' | 'assistant'>('editor')
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const summaryVisible = Boolean(summary && summary.total > 0)

  useEffect(() => {
    if (activePanel === null && compactPane === 'assistant') setCompactPane('editor')
  }, [activePanel, compactPane])

  function focusTab(index: number) {
    const panel = panels[(index + panels.length) % panels.length]
    if (!panel) return
    onActivePanelChange(panel.id)
    tabRefs.current.get(panel.id)?.focus()
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowRight') { event.preventDefault(); focusTab(index + 1) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); focusTab(index - 1) }
    else if (event.key === 'Home') { event.preventDefault(); focusTab(0) }
    else if (event.key === 'End') { event.preventDefault(); focusTab(panels.length - 1) }
  }

  function handleShellKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!history || history.disabled || isTextEditingTarget(event.target)) return
    const key = event.key.toLowerCase()
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return
    if (key === 'z' && event.shiftKey) {
      if (history.canRedo) { event.preventDefault(); history.onRedo() }
    } else if (key === 'z') {
      if (history.canUndo) { event.preventDefault(); history.onUndo() }
    } else if (key === 'y' && event.ctrlKey) {
      if (history.canRedo) { event.preventDefault(); history.onRedo() }
    }
  }

  return <div className={`assisted-shell ${activePanel === null ? 'is-collapsed' : ''} is-compact-${compactPane}`} onKeyDown={handleShellKeyDown}>
    <div className="assisted-shell-toolbar">
      <div className="assisted-shell-history" aria-label="Edit history controls">
        {history && <>
          <Button size="sm" variant="ghost" icon={Undo2} onClick={history.onUndo} disabled={!history.canUndo || history.disabled || busy}
            aria-label={history.undoLabel} title={history.undoLabel}>Undo</Button>
          <Button size="sm" variant="ghost" icon={Redo2} onClick={history.onRedo} disabled={!history.canRedo || history.disabled || busy}
            aria-label={history.redoLabel} title={history.redoLabel}>Redo</Button>
        </>}
      </div>
      {summaryVisible && summary && <div className="assisted-summary-bar" role="status">
        <span>{summary.total.toLocaleString('en-US')} unsaved {summary.total === 1 ? 'change' : 'changes'} · {summary.ai.toLocaleString('en-US')} from AI assist</span>
        <Button size="sm" variant="ghost" onClick={summary.onReview}>Review changes</Button>
        <Button size="sm" variant="ghost" onClick={summary.onNext}>Next change</Button>
      </div>}
      <div className="assisted-compact-switch" role="group" aria-label="Editor panes">
        <button type="button" aria-pressed={compactPane === 'editor'} onClick={() => setCompactPane('editor')}>Editor</button>
        <button type="button" aria-pressed={compactPane === 'assistant'} onClick={() => {
          if (activePanel === null && firstPanelId) onActivePanelChange(firstPanelId)
          setCompactPane('assistant')
        }}>Assistant</button>
      </div>
    </div>
    <div className="assisted-shell-grid">
      <div className="assisted-main-pane" data-pane="editor">{main}</div>
      <aside className="assisted-side-pane" aria-label={sideLabel} data-pane="assistant">
        <div className="assisted-side-tabs">
          <div className="assisted-tablist" role="tablist" aria-label={sideLabel}>
            {panels.map((panel, index) => {
              const Icon = panel.icon
              const selected = activePanel !== null && panel.id === selectedPanelId
              return <button key={panel.id} ref={(node) => {
                if (node) tabRefs.current.set(panel.id, node)
                else tabRefs.current.delete(panel.id)
              }} type="button" role="tab" id={`assist-tab-${panel.id}`} aria-controls={`assist-panel-${panel.id}`}
                aria-selected={selected} tabIndex={selected || (activePanel === null && index === 0) ? 0 : -1}
                className={selected ? 'is-active' : ''} onClick={() => onActivePanelChange(panel.id)} onKeyDown={(event) => handleTabKey(event, index)}>
                {Icon && <Icon size={15} aria-hidden="true" />}
                <span>{panel.label}</span>
                {panel.badge !== undefined && <span className="assisted-tab-badge">{panel.badge}</span>}
              </button>
            })}
          </div>
          <Button size="sm" variant="ghost" className="icon-button" icon={activePanel === null ? PanelRightOpen : PanelRightClose}
            aria-label={activePanel === null ? `Open ${sideLabel}` : `Collapse ${sideLabel}`} title={activePanel === null ? `Open ${sideLabel}` : `Collapse ${sideLabel}`}
            onClick={() => onActivePanelChange(activePanel === null ? firstPanelId : null)} />
        </div>
        <div className="assisted-tabpanels">
          {panels.map(panel => <section key={panel.id} role="tabpanel" id={`assist-panel-${panel.id}`} aria-labelledby={`assist-tab-${panel.id}`}
            hidden={activePanel === null || panel.id !== selectedPanel?.id}>{panel.content}</section>)}
        </div>
      </aside>
    </div>
  </div>
}
