import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useGradeLadders } from '../../app/grade-ladders-context'
import { useGradeLeaveGuard } from '../../app/grade-navigation-context'
import type { GradeLadderDetail } from '../../domain/real-grades'
import { Button, InlineError, Modal } from '../../components/ui'
import { GradeContextFields } from './GradeContextFields'
import { contextErrors } from './gradeUi'

export function GradeContextEditor({ detail, onClose }: { detail: GradeLadderDetail; onClose: () => void }) {
  const api = useGradeLadders()
  const [name, setName] = useState(detail.ladder.name)
  const [context, setContext] = useState(() => structuredClone(detail.ladder.context))
  const [grades, setGrades] = useState([...detail.ladder.grades])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const etag = useRef(detail.etag)
  const inFlight = useRef(false)
  const alive = useRef(true)
  const guard = useGradeLeaveGuard(dirty, saving, 'Ladder context and requested grades')
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const close = () => { void guard.close(onClose) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!api || inFlight.current || !api.canWrite) return
    const errors = contextErrors(name, context, grades)
    if (errors.length) { setError(errors.join(' ')); return }
    inFlight.current = true
    setSaving(true)
    setError('')
    try {
      await api.update(detail.ladder.id, { name: name.trim(), context, grades }, etag.current)
      if (alive.current) { guard.release(); onClose() }
    } catch (caught) { if (alive.current) setError(caught instanceof Error ? caught.message : 'The new context was not saved.') }
    finally { inFlight.current = false; if (alive.current) setSaving(false) }
  }
  return <Modal open onOpenChange={(open) => { if (!open) close() }} title="Update context or add GS grades" description="Previous grade versions, approvals, and their frozen evidence are immutable. New work needs reviewed sources for this context." wide
    footer={<><Button onClick={close}>Cancel</Button><Button form="grade-context-edit" type="submit" variant="primary" disabled={saving || !api?.canWrite || !dirty}>{saving ? 'Saving…' : 'Save revised context'}</Button></>}>
    <form id="grade-context-edit" onSubmit={submit} noValidate className="space-y-5">
      <GradeContextFields name={name} context={context} grades={grades} retainedGrades={detail.ladder.grades} onName={(value) => { setName(value); setDirty(true) }} onContext={(value) => { setContext(value); setDirty(true) }} onGrades={(value) => { setGrades(value); setDirty(true) }} disabled={saving || !api?.canWrite} />
      <p className="text-[11px] text-muted">Changing context or requested grades invalidates confirmation for new work. Rediscover applicable OPM references, review sources, and create a new generation; earlier approved versions stay inspectable.</p>
      {error && <InlineError>{error}</InlineError>}
    </form>
  </Modal>
}
