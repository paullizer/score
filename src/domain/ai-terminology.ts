import { siTerminologyEnabled } from './feature-switches'

export interface AiTerminology {
  /** True when the SI (Superintelligence) terminology switch is on. */
  readonly si: boolean
  /** Short acronym: 'AI' or 'SI'. */
  readonly ai: 'AI' | 'SI'
  /** Full phrase: 'Artificial intelligence' or 'Superintelligence'. */
  readonly fullName: 'Artificial intelligence' | 'Superintelligence'
  /** Short badge/author label for changes and toolbar buttons: 'AI assist' or 'SI'. */
  readonly assistBadge: 'AI assist' | 'SI'
  /** Attribution byline: 'by AI assist' or 'by SI'. */
  readonly byAssist: 'by AI assist' | 'by SI'
  /** Attribution summary phrase: 'from AI assist' or 'from SI'. */
  readonly fromAssist: 'from AI assist' | 'from SI'
  /** Noun phrase for the assistant tool itself: 'AI assist' or 'SI assistant'. */
  readonly assistantName: 'AI assist' | 'SI assistant'
  /** Composer label: 'Message AI assist' or 'Message SI assistant'. */
  readonly messageAssistant: 'Message AI assist' | 'Message SI assistant'
  /** Pending status label: 'AI assist is working…' or 'SI assistant is working…'. */
  readonly assistantWorking: 'AI assist is working…' | 'SI assistant is working…'
  /** Default chat input placeholder. */
  readonly askPlaceholder: 'Ask AI to change or explain this draft' | 'Ask SI to change or explain this draft'
  /** Action button label: 'Ask AI' or 'Ask SI'. */
  readonly askAi: 'Ask AI' | 'Ask SI'
  /** Action button label: 'Edit with AI' or 'Edit with SI'. */
  readonly editWithAi: 'Edit with AI' | 'Edit with SI'
  /** Action button label: 'Fix with AI' or 'Fix with SI'. */
  readonly fixWithAi: 'Fix with AI' | 'Fix with SI'
  /** Action button label: 'Draft with AI' or 'Draft with SI'. */
  readonly draftWithAi: 'Draft with AI' | 'Draft with SI'
  /** Formats arbitrary user-facing copy by converting 'AI assist' and standalone 'AI' tokens when SI terminology is enabled. */
  readonly text: (value: string) => string
}

const AI_TERMS: AiTerminology = Object.freeze({
  si: false,
  ai: 'AI',
  fullName: 'Artificial intelligence',
  assistBadge: 'AI assist',
  byAssist: 'by AI assist',
  fromAssist: 'from AI assist',
  assistantName: 'AI assist',
  messageAssistant: 'Message AI assist',
  assistantWorking: 'AI assist is working…',
  askPlaceholder: 'Ask AI to change or explain this draft',
  askAi: 'Ask AI',
  editWithAi: 'Edit with AI',
  fixWithAi: 'Fix with AI',
  draftWithAi: 'Draft with AI',
  text: (value: string) => value,
})

export function formatSiText(value: string): string {
  return value
    .replace(/\bby AI assist\b/g, 'by SI')
    .replace(/\bfrom AI assist\b/g, 'from SI')
    .replace(/\bNew · AI assist\b/g, 'New · SI')
    .replace(/\basking AI assist\b/g, 'asking the SI assistant')
    .replace(/\bAI assist\b/g, 'SI assistant')
    .replace(/\bAI\b/g, 'SI')
}

const SI_TERMS: AiTerminology = Object.freeze({
  si: true,
  ai: 'SI',
  fullName: 'Superintelligence',
  assistBadge: 'SI',
  byAssist: 'by SI',
  fromAssist: 'from SI',
  assistantName: 'SI assistant',
  messageAssistant: 'Message SI assistant',
  assistantWorking: 'SI assistant is working…',
  askPlaceholder: 'Ask SI to change or explain this draft',
  askAi: 'Ask SI',
  editWithAi: 'Edit with SI',
  fixWithAi: 'Fix with SI',
  draftWithAi: 'Draft with SI',
  text: formatSiText,
})

export function aiTerminology(source?: boolean | { features?: { siTerminology?: boolean } } | null): AiTerminology {
  const enabled = typeof source === 'boolean' ? source : siTerminologyEnabled(source)
  return enabled ? SI_TERMS : AI_TERMS
}
