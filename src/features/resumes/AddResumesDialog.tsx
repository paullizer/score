import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { FileText, Files, FlaskConical, Loader2, Plus, X } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { Badge, Button, DemoNote, InlineError, Modal } from '../../components/ui'
import { RESUME_FIXTURE_COUNT } from '../../data/fixtures'
import type { ImportCandidate } from '../../domain/types'
import { LifecycleBanner } from '../../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'

export function AddResumesDialog({ open, onOpenChange, onAdded, onError }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (ids: string[]) => void
  onError: (message: string) => void
}) {
  const { addResumes, notify, cloud } = useWorkspace()
  const { canEdit } = useLifecycleAccess()
  const [items, setItems] = useState<ImportCandidate[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const formId = useId()
  const fileHintId = useId()

  function changeOpen(next: boolean) {
    if (!next && !submitting.current) {
      setItems([])
      setErrors([])
    }
    onOpenChange(next)
  }

  function selectNames(names: string[]) {
    if (submitting.current || !canEdit) return
    const seen = new Set(items.map((item) => item.label.toLocaleLowerCase()))
    const problems: string[] = []
    const selected = names.map((name) => name.trim())
    for (const name of selected) {
      if (!name || !name.replace(/\.pdf$/i, '').trim()) {
        problems.push('Each PDF needs a nonempty filename before the .pdf extension.')
      } else if (!/\.pdf$/i.test(name)) {
        problems.push(`“${name}” is not a PDF filename. Choose files ending in .pdf.`)
      } else if (seen.has(name.toLocaleLowerCase())) {
        problems.push(`“${name}” is already selected. Choose it only once per batch.`)
      }
      seen.add(name.toLocaleLowerCase())
    }
    setErrors(problems)
    onError('')
    if (problems.length) return
    setItems((previous) => [
      ...previous,
      ...selected.map((label, index) => ({
        key: `resume-import-${crypto.randomUUID()}`,
        label,
        title: label.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim(),
        fixtureIndex: (previous.length + index) % RESUME_FIXTURE_COUNT,
      })),
    ])
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const names = Array.from(event.currentTarget.files ?? [], (file) => file.name)
    event.currentTarget.value = ''
    if (names.length) selectNames(names)
  }

  async function importResumes() {
    if (submitting.current || !canEdit) return
    if (!items.length) {
      setErrors(['Choose at least one PDF filename, or load the sample batch.'])
      return
    }
    submitting.current = true
    setBusy(true)
    setErrors([])
    onError('')
    try {
      const ids = await addResumes(items.map((item) => ({ ...item })))
      if (!ids.length) throw new Error('Resume preparation stopped because the workspace changed or was archived. No profiles were added. Unarchive the workspace before explicitly retrying.')
      setItems([])
      onAdded(ids)
      onOpenChange(false)
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught
      const message = caught.message
      setErrors([message])
      onError(message)
      notify(message)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void importResumes()
  }

  return <Modal
    open={open}
    onOpenChange={changeOpen}
    title="Add resumes"
    description="Choose PDF filenames to try a batch import. Score creates fictional replacement profiles; your file contents are never accessed."
    footer={<>
      <Button onClick={() => changeOpen(false)}>{busy ? 'Close' : 'Cancel'}</Button>
      <Button type="submit" form={formId} icon={busy ? Loader2 : Plus} variant="primary" disabled={busy || !canEdit || !items.length}>
        {busy ? 'Preparing samples…' : `Add ${items.length || ''} ${items.length === 1 ? 'sample resume' : 'sample resumes'}`.replace('  ', ' ')}
      </Button>
    </>}
  >
    <LifecycleBanner />
    <form id={formId} onSubmit={submit} className="space-y-5" aria-busy={busy}>
      <fieldset disabled={busy || !canEdit} className="space-y-5">
      {errors.length > 0 && <InlineError><ul className="space-y-1">{errors.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul></InlineError>}
      <div className="rounded-xl border border-dashed bg-surface px-5 py-7 text-center">
        <Files size={28} className="mx-auto mb-3 text-accent" aria-hidden="true" />
        <h3 className="text-[14px] font-semibold">A few resumes. One batch.</h3>
        <p id={fileHintId} className="mx-auto mb-4 mt-2 max-w-sm text-[11px] text-muted">Select multiple PDFs. Only their names become {cloud ? 'workspace' : 'local'} labels; the files themselves are not read, uploaded, or stored.</p>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,application/pdf"
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose PDF filenames"
          aria-describedby={fileHintId}
          onChange={chooseFiles}
          disabled={busy}
        />
        <Button icon={Files} onClick={() => fileInput.current?.click()} disabled={busy}>Choose PDF filenames</Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-soft p-4">
        <div><p className="text-[12px] font-medium">Just exploring?</p><p className="mt-1 text-[10px] text-muted">Try three fictional profiles. No files needed.</p></div>
        <Button
          size="sm"
          icon={FlaskConical}
          disabled={busy}
          onClick={() => selectNames(['Sample profile 01.pdf', 'Sample profile 02.pdf', 'Sample profile 03.pdf'])}
        >Load sample batch</Button>
      </div>

      {items.length > 0 && <section aria-label="Selected filenames">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-[12px] font-semibold">Ready to prepare</h3><Badge>{items.length} {items.length === 1 ? 'filename' : 'filenames'}</Badge>
        </div>
        <ul className="max-h-56 overflow-y-auto rounded-xl border">
          {items.map((item) => <li className="flex items-center gap-3 border-b bg-surface p-3 last:border-b-0" key={item.key}>
            <FileText size={17} className="shrink-0 text-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1"><p className="break-words text-[11px] font-medium">{item.label}</p><p className="mt-1 text-[10px] text-muted">Will use fictional replacement content</p></div>
            <Button icon={X} size="sm" variant="ghost" className="icon-button" aria-label={`Remove ${item.label}`} disabled={busy} onClick={() => {
              setItems((value) => value.filter((candidate) => candidate.key !== item.key))
              setErrors([])
            }} />
          </li>)}
        </ul>
      </section>}

      {busy && <div className="flex items-start gap-3 rounded-xl border bg-accent-soft p-4" role="status" aria-live="polite">
        <Loader2 size={17} className="mt-0.5 shrink-0 motion-safe:animate-spin text-accent" aria-hidden="true" />
        <div><p className="text-[12px] font-medium">Preparing {items.length} fictional {items.length === 1 ? 'profile' : 'profiles'}…</p><p className="mt-1 text-[11px] text-muted">This is simulated progress, not PDF parsing. Preparation continues if you close this dialog.</p></div>
      </div>}
      <DemoNote>All imported profiles, document text, and later citations come from the demo fixtures—not from the selected PDFs. {cloud ? 'Sample profiles and filename labels are saved to this private cloud workspace; no PDF bytes are sent.' : 'Filename labels stay on this device.'}</DemoNote>
      </fieldset>
    </form>
  </Modal>
}
