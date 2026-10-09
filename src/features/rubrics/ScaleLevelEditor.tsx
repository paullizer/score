import { useId } from 'react'
import {
  EVIDENCE_SCALE_V1, LEVEL_EXAMPLE_LIMITS, checkCriterionLevels, type CriterionLevelExamples,
} from '../../domain/evidence-scale'
import type { Criterion } from '../../domain/types'

const LEVELS = [1, 2, 3, 4, 5] as const

export function ScaleLevelEditor({ criterion, attempted = false, describedBy, onChange, onBlur }: {
  criterion: Pick<Criterion, 'levels' | 'sourceCitations'>
  attempted?: boolean
  describedBy?: string
  onChange: (levels: CriterionLevelExamples[]) => void
  onBlur?: () => void
}) {
  const hintId = useId()
  const levels = LEVELS.map(level => ({
    level, examples: criterion.levels?.find(entry => entry.level === level)?.examples ?? '',
  }))
  const warnings = checkCriterionLevels(levels, {
    sourceTexts: (criterion.sourceCitations ?? []).map(citation => citation.quote),
  }).filter(finding => finding.severity === 'warning')
  return <div className="field"><span className="field-label">Standard scale examples</span><div className="space-y-3">
    <div className="rounded-lg border bg-soft p-3 text-[11px] text-muted"><strong>0 · {EVIDENCE_SCALE_V1.levels[0].label}</strong><p className="mt-1">{EVIDENCE_SCALE_V1.levels[0].description}</p></div>
    {levels.map(entry => {
      const scale = EVIDENCE_SCALE_V1.levels[entry.level]
      const descriptionId = `${hintId}-${entry.level}`
      return <label className="field" key={entry.level}><span className="field-label">{entry.level} · {scale.label}</span><span id={descriptionId} className="field-hint">{scale.description}</span>
        <textarea className="input" rows={2} value={entry.examples} maxLength={LEVEL_EXAMPLE_LIMITS.maxCharacters} onBlur={onBlur}
          onChange={event => onChange(levels.map(item => item.level === entry.level ? { ...item, examples: event.target.value } : item))}
          required aria-describedby={[descriptionId, describedBy].filter(Boolean).join(' ')}
          aria-invalid={attempted && !entry.examples.trim()} placeholder="Resume-observable examples for this requirement." /></label>
    })}
  </div>{warnings.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-warning">{warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul>}</div>
}
