import { AlertTriangle, FileSearch, ShieldCheck } from 'lucide-react'
import { Badge, ExternalSource } from '../../components/ui'
import type { Citation } from '../../domain/types'
import type { GradeIssue, GradeLevelStatus, ReferenceIssueResolution } from '../../domain/real-grades'
import { gradeStatusLabels, uniqueCitations } from './gradeUi'

export function GradeStatus({ status }: { status: GradeLevelStatus }) {
  return <Badge dot tone={status === 'approved' || status === 'ready-for-review' ? 'success' : status === 'needs-sources' ? 'warning' : status === 'error' ? 'danger' : 'neutral'}>{gradeStatusLabels[status]}</Badge>
}

export function GradeDisclaimer() {
  return <div className="info-callout grade-disclaimer"><ShieldCheck size={18} aria-hidden="true" /><div><strong>Source-grounded work for human review</strong>
    <p>Reviewer approval is not OPM certification, an official position classification, or an eligibility decision. Weights are review choices, not federal classification points.</p></div></div>
}

export function GradeIssues({ issues, title = 'Unresolved evidence and applicability' }: { issues: GradeIssue[]; title?: string }) {
  const unique = [...new Map(issues.map((issue) => [issue.id, issue])).values()]
  if (!unique.length) return null
  return <section className="grade-issues" aria-label={title}><h3><AlertTriangle size={16} aria-hidden="true" />{title}</h3>
    <ul>{unique.map((issue) => <li key={issue.id}><Badge tone={issue.severity === 'blocker' ? 'danger' : 'warning'}>{issue.severity === 'blocker' ? 'Blocks approval' : 'Warning'}</Badge>
      <div><p>{issue.grade !== undefined && <strong>GS-{issue.grade} · </strong>}{issue.message}</p><span className="text-[10px] text-muted">{issue.scope} · {issue.code}</span></div></li>)}</ul>
    <p className="mt-3 text-[11px] text-muted">A source-selection decision cannot dismiss a federal evidence gap. Affected grades stay drafts until the sources and grounding review support them.</p>
  </section>
}

export function GradeCitations({ citations, onOpen }: { citations: Citation[]; onOpen: (citation: Citation) => void }) {
  return <div className="grade-citations">{uniqueCitations(citations).map((citation, index) => <div key={`${citation.documentId}-${citation.paragraphId}-${index}`}>
    <span className="grade-field-kicker">Exact source quotation</span>
    <blockquote className="source-quote">“{citation.quote}”</blockquote>
    <button className="text-link mt-2 text-[11px]" type="button" onClick={() => onOpen(citation)}><FileSearch size={13} aria-hidden="true" />
      Captured v{citation.documentVersion} · p. {citation.page} · {citation.heading || 'Source passage'}
    </button>
  </div>)}</div>
}

export function GradeIssueResolutions({ resolutions }: { resolutions: ReferenceIssueResolution[] }) {
  if (!resolutions.length) return null
  const labels = {
    'complete-source-extraction': 'The archived source was completely extracted',
    'captured-named-section': 'The exact named section was captured',
    'captured-reference-target': 'The exact linked reference and section were captured in this source set',
  }
  return <details className="mt-4 rounded-lg border bg-soft p-3 text-[11px]">
    <summary className="cursor-pointer font-medium">{resolutions.length} resolved source-capture {resolutions.length === 1 ? 'notice' : 'notices'}</summary>
    <ul className="mt-3 space-y-3">{resolutions.map((resolution) => <li key={`${resolution.issue.id}-${resolution.evidence.documentId}`}>
      <strong>{resolution.issue.code}</strong>
      <p className="mt-1 text-muted">{resolution.issue.message}</p>
      <p className="mt-1">{labels[resolution.reason]}. Document v{resolution.evidence.documentVersion} · SHA-256 {resolution.evidence.sha256.slice(0, 12)}</p>
      {resolution.evidence.targetUrl && <ExternalSource url={resolution.evidence.targetUrl}>Resolved reference{resolution.evidence.intendedSection ? ` · ${resolution.evidence.intendedSection}` : ''}</ExternalSource>}
    </li>)}</ul>
    <p className="mt-3 text-muted">This resolves a capture fact, not grade support or source authority. Earlier snapshots and the original discovery notices are preserved.</p>
  </details>
}
