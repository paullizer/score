import type { GradeContext, GradeFunction } from '../../domain/real-grades'

export function GradeContextFields({ name, context, grades, onName, onContext, onGrades, disabled = false, retainedGrades = [] }: {
  name: string
  context: GradeContext
  grades: number[]
  onName: (name: string) => void
  onContext: (context: GradeContext) => void
  onGrades: (grades: number[]) => void
  disabled?: boolean
  retainedGrades?: number[]
}) {
  function patch(next: Partial<GradeContext>) { onContext({ ...context, ...next, confirmed: false }) }
  return <fieldset disabled={disabled} className="grade-context-fields">
    <label className="field"><span className="field-label">Ladder family name</span>
      <input className="input" value={name} maxLength={160} required onChange={(event) => onName(event.target.value)} placeholder="A recognizable role or specialty" /></label>
    <div className="grade-form-grid">
      <label className="field"><span className="field-label">GS occupational series</span>
        <input className="input" aria-label="GS occupational series" inputMode="numeric" value={context.series} maxLength={4} pattern="[0-9]{4}" required onChange={(event) => patch({ series: event.target.value.replace(/\D/g, '') })} placeholder="Four digits, e.g. 0801" />
        <span className="field-hint">Any GS series. Confirm from evidence; a title is not a series determination.</span></label>
      <label className="field"><span className="field-label">Agency / organization</span>
        <input className="input" value={context.agency} maxLength={240} onChange={(event) => patch({ agency: event.target.value })} placeholder="Name the relevant agency" /></label>
    </div>
    <div className="grade-form-grid">
      <label className="field"><span className="field-label">Agency applicability</span>
        <select className="input" aria-label="Agency applicability" value={context.agencyType} onChange={(event) => patch({ agencyType: event.target.value as GradeContext['agencyType'] })}>
          <option value="unknown">Unknown — do not assume</option><option value="dod">Department of Defense</option><option value="other-federal">Other federal agency</option><option value="non-federal">Non-federal</option>
        </select><span className="field-hint">For example, 1102 qualifications have a DoD exclusion.</span></label>
      <label className="field"><span className="field-label">Supervisory / leader coverage</span>
        <select className="input" aria-label="Supervisory / leader coverage" value={context.supervision} onChange={(event) => patch({ supervision: event.target.value as GradeContext['supervision'] })}>
          <option value="unknown">Unknown — needs evidence</option><option value="nonsupervisory">Nonsupervisory</option><option value="supervisor">Supervisor</option><option value="leader">Work or team leader</option>
        </select><span className="field-hint">Leadership language or contractor oversight alone does not establish supervisory coverage.</span></label>
    </div>
    <fieldset><legend className="field-label">Applicable functions</legend><div className="grade-checks">
      {([['research', 'Research'], ['development', 'Development'], ['test-evaluation', 'Test / evaluation']] as [GradeFunction, string][]).map(([value, label]) =>
        <label className="check-label" key={value}><input type="checkbox" checked={context.functions.includes(value)} onChange={() => patch({ functions: context.functions.includes(value) ? context.functions.filter((item) => item !== value) : [...context.functions, value] })} />{label}</label>)}
    </div><p className="field-hint">Select only evidenced functions. Discovery checks applicable functional guides; it does not infer coverage from a title.</p></fieldset>
    <label className="field"><span className="field-label">Specialty and scope</span><textarea className="input" aria-label="Specialty and scope" rows={2} maxLength={1000} value={context.specialty} onChange={(event) => patch({ specialty: event.target.value })} placeholder="Describe the position's actual work and any limits on applicability." /></label>
    {Object.entries(context.answers).map(([key, value]) => <label className="field" key={key}><span className="field-label">{key}</span><textarea className="input" aria-label={key} maxLength={2000} value={value} onChange={(event) => patch({ answers: { ...context.answers, [key]: event.target.value } })} /></label>)}
    <fieldset><legend className="field-label">Grades to prepare</legend><div className="grade-picker">
      {Array.from({ length: 15 }, (_, index) => index + 1).map((grade) => <label key={grade} className={grades.includes(grade) ? 'is-selected' : ''}>
        <input type="checkbox" checked={grades.includes(grade)} disabled={retainedGrades.includes(grade)} title={retainedGrades.includes(grade) ? 'Existing grades are retained so their saved versions stay accessible. Add grades without removing history.' : undefined} onChange={() => {
          onGrades(grades.includes(grade) ? grades.filter((item) => item !== grade) : [...grades, grade].sort((a, b) => a - b))
          onContext({ ...context, confirmed: false })
        }} /><span>GS-{grade}</span></label>)}
    </div><p className="field-hint">Each grade gets a separate draft. Unsupported distinctions remain visible gaps, never interpolated expectations.{retainedGrades.length > 0 && ' Existing grades remain in the family to keep their history accessible; you can add more grades.'}</p></fieldset>
    <label className="check-label grade-context-confirm"><input type="checkbox" checked={context.confirmed} onChange={(event) => onContext({ ...context, confirmed: event.target.checked })} />
      <span>I confirm the requested series, grades, and position context. Unknown coverage remains unresolved; this is not an official classification decision.</span></label>
  </fieldset>
}
