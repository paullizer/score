import { forwardRef, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertCircle, ArrowUpRight, Check, FlaskConical, Search, X, type LucideIcon } from 'lucide-react'
import type { JobStatus } from '../../domain/types'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: LucideIcon
}

const buttonVariants = { primary: 'button-primary', secondary: 'button-secondary', ghost: 'button-ghost', danger: 'button-danger' }
const buttonSizes = { sm: 'button-sm', md: 'button-md' }
const badgeTones = { neutral: 'badge-neutral', accent: 'badge-accent', success: 'badge-success', warning: 'badge-warning', danger: 'badge-danger' }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, className = '', children, type = 'button', ...props }, ref,
) {
  return <button ref={ref} type={type} className={`button ${buttonVariants[variant]} ${buttonSizes[size]} ${className}`} {...props}>
    {Icon && <Icon size={16} aria-hidden="true" />}{children}
  </button>
})

export function Badge({ children, tone = 'neutral', dot = false }: {
  children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; dot?: boolean
}) {
  return <span className={`badge ${badgeTones[tone]}`}>{dot && <span className="badge-dot" />}{children}</span>
}

export function StatusBadge({ status }: { status: JobStatus }) {
  const labels = { queued: 'Queued', ready: 'Rubric ready', parsing: 'Reading source', generating: 'Creating rubric', error: 'Needs attention', cancelled: 'Cancelled' }
  return <Badge tone={status === 'ready' ? 'success' : status === 'error' ? 'warning' : 'neutral'} dot>{labels[status]}</Badge>
}

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow?: string; title: string; description: string; actions?: ReactNode
}) {
  return <div className="page-heading">
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1 tabIndex={-1}>{title}</h1><p>{description}</p></div>
    {actions && <div className="heading-actions">{actions}</div>}
  </div>
}

export function SearchField({ value, onChange, placeholder, label }: {
  value: string; onChange: (value: string) => void; placeholder: string; label?: string
}) {
  return <label className="search-field"><Search size={17} aria-hidden="true" />
    <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={label ?? placeholder} />
  </label>
}

export function SegmentedControl<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (value: T) => void; options: { value: T; label: string; count?: number }[]; label: string
}) {
  return <div className="segmented" role="group" aria-label={label}>
    {options.map((option) => <button type="button" key={option.value} aria-pressed={value === option.value}
      className={value === option.value ? 'is-active' : ''} onClick={() => onChange(option.value)}>
      {option.label}{option.count !== undefined && <span className="tab-count">{option.count}</span>}
    </button>)}
  </div>
}

export function Modal({ open, onOpenChange, title, description, children, footer, wide = false, drawer = false, dismissDisabled = false, onOpenAutoFocus, onCloseAutoFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string
  children: ReactNode; footer?: ReactNode; wide?: boolean; drawer?: boolean
  dismissDisabled?: boolean; onOpenAutoFocus?: (event: Event) => void; onCloseAutoFocus?: (event: Event) => void
}) {
  const returnFocus = useRef<HTMLElement | null>(null)
  return <Dialog.Root open={open} onOpenChange={(next) => { if (next || !dismissDisabled) onOpenChange(next) }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className={`dialog-content ${wide ? 'dialog-wide' : ''} ${drawer ? 'dialog-drawer' : ''}`}
        onEscapeKeyDown={(event) => { if (dismissDisabled) event.preventDefault() }}
        onInteractOutside={(event) => { if (dismissDisabled) event.preventDefault() }}
        onOpenAutoFocus={(event) => {
          returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          onOpenAutoFocus?.(event)
        }}
        onCloseAutoFocus={(event) => {
          if (onCloseAutoFocus) { onCloseAutoFocus(event); return }
          if (returnFocus.current?.isConnected) {
            event.preventDefault()
            returnFocus.current.focus()
          }
        }}>
        <div className="dialog-header"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div>
          <Dialog.Close asChild><Button variant="ghost" size="sm" className="icon-button" aria-label="Close dialog" icon={X} disabled={dismissDisabled} /></Dialog.Close>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function EmptyState({ icon: Icon = Search, title, description, action }: {
  icon?: LucideIcon; title: string; description: string; action?: ReactNode
}) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={25} /></span><h3>{title}</h3><p>{description}</p>{action}</div>
}

export function InlineError({ children }: { children: ReactNode }) {
  return <div className="inline-error" role="alert"><AlertCircle size={17} /><div>{children}</div></div>
}

export function DemoNote({ children = 'A working preview with fictional documents and simulated results. Selected PDF contents are not read, and source URLs are not fetched.' }: { children?: ReactNode }) {
  return <div className="demo-note"><FlaskConical size={16} aria-hidden="true" /><span>{children}</span></div>
}

export function Avatar({ initials, small = false }: { initials: string; small?: boolean }) {
  return <span className={`avatar ${small ? 'avatar-small' : ''}`} aria-hidden="true">{initials}</span>
}

export function Score({ value, large = false }: { value: number | null; large?: boolean }) {
  return <span className={`score ${large ? 'score-large' : ''}`}>
    {value === null ? <span className="unscored">Not assessed</span> : <><strong>{value}</strong><span>/ 100</span></>}
  </span>
}

export function CheckLabel({ checked, onChange, children, disabled = false }: {
  checked: boolean; onChange: () => void; children: ReactNode; disabled?: boolean
}) {
  return <label className={`check-label ${disabled ? 'is-disabled' : ''}`}><input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />{children}</label>
}

export function StepLabel({ number, children, complete = false }: { number: number; children: ReactNode; complete?: boolean }) {
  return <div className="step-label"><span>{complete ? <Check size={13} /> : number}</span>{children}</div>
}

export function ExternalSource({ url, children }: { url: string; children: ReactNode }) {
  const parsed = URL.canParse(url) ? new URL(url) : null
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) return <span className="source-label">{children}</span>
  return <a href={url} target="_blank" rel="nofollow noopener noreferrer" className="text-link">{children}<ArrowUpRight size={13} /></a>
}
