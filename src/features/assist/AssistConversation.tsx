import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AlertCircle, CornerDownLeft, LocateFixed, RotateCcw, Sparkles, X } from 'lucide-react'
import { ASSIST_LIMITS } from '../../domain/assist'
import { Button, InlineError } from '../../components/ui'
import type { AssistAppliedChange, AssistConversationUiTurn } from './useAssistConversation'

export interface AssistConversationProps {
  turns: readonly AssistConversationUiTurn[]
  pending: boolean
  elapsedSeconds: number
  disabledReason?: string | null
  focus?: { label: string; onClear: () => void } | null
  quickActions?: { id: string; label: string; instruction: string }[]
  onSend: (instruction: string) => void
  onCancel: () => void
  onRetry: (turnId: string) => void
  onUndoTurn: (turnId: string) => void
  onJump: (key: string) => void
  onQuote?: (change: AssistAppliedChange) => void
  placeholder?: string
  emptyState?: ReactNode
}

const outcomeLabels = { changed: 'Changed', explained: 'Explained', clarify: 'Question' }

function canSendText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && text.length <= ASSIST_LIMITS.maxInstructionCharacters
}

export function AssistConversation({
  turns,
  pending,
  elapsedSeconds,
  disabledReason = null,
  focus = null,
  quickActions = [],
  onSend,
  onCancel,
  onRetry,
  onUndoTurn,
  onJump,
  onQuote,
  placeholder = 'Ask AI to change or explain this draft',
  emptyState,
}: AssistConversationProps) {
  const [text, setText] = useState('')
  const textareaId = useId()
  const counterId = useId()
  const blocked = Boolean(disabledReason) || pending
  const overLimit = text.length > ASSIST_LIMITS.maxInstructionCharacters
  const sendDisabled = blocked || !canSendText(text)

  function submit(instruction = text) {
    if (pending || disabledReason || !canSendText(instruction)) return
    onSend(instruction.trim())
    if (instruction === text) setText('')
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  return <div className="assist-conversation">
    {focus && <div className="assist-focus-chip"><span>About: {focus.label}</span><button type="button" onClick={focus.onClear} aria-label={`Clear focus ${focus.label}`}><X size={13} /></button></div>}
    {quickActions.length > 0 && <div className="assist-quick-actions" aria-label="Quick actions">
      {quickActions.map(action => <button key={action.id} type="button" onClick={() => submit(action.instruction)} disabled={blocked}>{action.label}</button>)}
    </div>}
    <div className="assist-log" role="log" aria-live="polite" aria-relevant="additions text">
      {turns.length === 0 ? <div className="assist-empty-state">{emptyState ?? <>Describe a change and it's applied to this draft for your review. Nothing is saved until you choose Save, and this conversation stays in this editor.</>}</div>
        : turns.map(turn => <article key={turn.id} className={`assist-turn is-${turn.role} is-${turn.status}`}>
          <header><strong>{turn.role === 'user' ? 'You' : 'AI assist'}</strong>{turn.role === 'assistant' && turn.outcome && <span>{outcomeLabels[turn.outcome]}</span>}</header>
          <p className="assist-turn-text">{turn.text || (turn.status === 'pending' ? 'Working…' : '')}</p>
          {turn.role === 'assistant' && turn.changes && turn.changes.length > 0 && <div className="assist-change-card">
            <h4>Changes</h4>
            <ul>{turn.changes.map(change => <li key={change.key}>
              <div><strong>{change.label}</strong>{change.detail && <p>{change.detail}</p>}</div>
              <div className="assist-change-actions">
                <Button size="sm" variant="ghost" icon={LocateFixed} onClick={() => onJump(change.key)} aria-label={`Jump to ${change.label}`}>Jump to</Button>
              </div>
              {change.quote && <blockquote className="source-quote" onClick={() => onQuote?.(change)} tabIndex={onQuote ? 0 : undefined}
                role={onQuote ? 'button' : undefined} title={onQuote ? 'Show this passage in the job posting' : undefined}
                onKeyDown={(event) => { if (onQuote && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onQuote(change) } }}>{change.quote}</blockquote>}
            </li>)}</ul>
          </div>}
          {turn.role === 'assistant' && turn.warnings && turn.warnings.length > 0 && <div className="assist-warnings"><AlertCircle size={14} aria-hidden="true" /><ul>{turn.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
          {turn.role === 'assistant' && turn.status === 'done' && turn.changes && turn.changes.length > 0 && <div className="assist-turn-actions">
            <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => onUndoTurn(turn.id)} disabled={Boolean(turn.undone)}>
              {turn.undone ? `Undone (${turn.undone.reverted} reverted, ${turn.undone.skipped} skipped because they changed later)` : 'Undo this change'}
            </Button>
          </div>}
          {turn.role === 'assistant' && turn.status === 'error' && turn.error && <InlineError>
            <p>{turn.error.message}</p>
            {turn.error.retryAfterSeconds !== undefined && <p>Try again in {turn.error.retryAfterSeconds} s.</p>}
            {turn.error.retryable && <Button size="sm" variant="ghost" onClick={() => onRetry(turn.id)}>Retry</Button>}
          </InlineError>}
        </article>)}
    </div>
    {pending && <div className="assist-pending" role="status"><Sparkles size={15} aria-hidden="true" />AI assist is working… {elapsedSeconds} s <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button></div>}
    {disabledReason && <p className="assist-disabled-note">{disabledReason}</p>}
    <label className="assist-composer" htmlFor={textareaId}>
      <span>Message AI assist</span>
      <textarea id={textareaId} value={text} onChange={event => setText(event.target.value)} onKeyDown={handleKeyDown}
        placeholder={placeholder} maxLength={ASSIST_LIMITS.maxInstructionCharacters + 1} aria-describedby={counterId} disabled={Boolean(disabledReason)} />
    </label>
    <div className="assist-composer-footer">
      <span id={counterId} aria-live="polite" className={overLimit ? 'is-over-limit' : ''}>{text.length.toLocaleString('en-US')} / {ASSIST_LIMITS.maxInstructionCharacters.toLocaleString('en-US')}</span>
      <Button variant="primary" size="sm" icon={CornerDownLeft} onClick={() => submit()} disabled={sendDisabled}>Send</Button>
    </div>
  </div>
}
