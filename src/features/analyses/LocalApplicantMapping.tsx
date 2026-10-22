import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, CheckLabel, InlineError } from '../../components/ui'
import type { ReportCandidate } from '../../domain/analysis-reports'
import {
  mappingRows, resolveApplicantIdentities, type ApplicantMappingRow, type MappingWorkbook,
} from '../../services/analysisReports/applicant-mapping'

export function LocalApplicantMapping({ candidates, disabled, onChange }: {
  candidates: ReportCandidate[]
  disabled: boolean
  onChange: (rows: ApplicantMappingRow[] | null | undefined) => void
}) {
  const id = useId()
  const [enabled, setEnabled] = useState(false)
  const [workbook, setWorkbook] = useState<MappingWorkbook | null>(null)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [header, setHeader] = useState(0)
  const [identifierColumn, setIdentifierColumn] = useState(-1)
  const [nameColumn, setNameColumn] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  const sheet = workbook?.sheets[sheetIndex]
  const result = useMemo(() => {
    if (!enabled || !sheet || identifierColumn < 0 || nameColumn < 0) return null
    try {
      const rows = mappingRows(sheet, header, identifierColumn, nameColumn)
      return { rows, identities: resolveApplicantIdentities(candidates, rows), error: '' }
    } catch (caught) {
      return { rows: null, identities: [], error: caught instanceof Error ? caught.message : 'The local mapping is invalid. Remove it or correct the selected columns.' }
    }
  }, [enabled, sheet, header, identifierColumn, nameColumn, candidates])
  useEffect(() => { onChange(enabled ? result?.rows ?? null : undefined) }, [enabled, onChange, result])

  function clear(resetInput = true) {
    active.current?.abort(); active.current = null
    setWorkbook(null); setError(''); setLoading(false)
    setSheetIndex(0); setHeader(0); setIdentifierColumn(-1); setNameColumn(-1)
    if (resetInput && input.current) input.current.value = ''
    onChange(enabled ? null : undefined)
  }
  async function selectFile(file: File | undefined) {
    clear(false)
    if (!file) return
    const controller = new AbortController()
    active.current = controller
    setLoading(true)
    try {
      const { readLocalMapping } = await import('../../services/analysisReports/mapping-client')
      controller.signal.throwIfAborted()
      const value = await readLocalMapping(file, controller.signal)
      if (active.current === controller && !controller.signal.aborted) setWorkbook(value)
    } catch (caught) {
      if (active.current === controller && !controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : 'The local mapping could not be read. Choose another file or remove the mapping.')
      }
    } finally {
      if (active.current === controller) { active.current = null; setLoading(false) }
    }
  }
  const columnCount = sheet?.rows[header]?.length ?? 0
  const matched = result?.identities.filter(identity => identity.name !== null).length ?? 0
  const columns = Array.from({ length: columnCount }, (_, index) => {
    const value = sheet?.rows[header]?.[index]
    return <option key={index} value={index}>{index + 1}: {typeof value === 'string' && value.trim() ? value : 'Untitled column'}</option>
  })
  return <section className="space-y-3" aria-label="Local applicant name mapping">
    <CheckLabel checked={enabled} disabled={disabled} onChange={() => {
      clear(); setEnabled(value => !value); onChange(enabled ? undefined : null)
    }}>Add applicant names from a local mapping file</CheckLabel>
    {enabled && <>
      <p className="text-[12px] text-muted">Read on this computer only: not uploaded, saved in Score, or sent to AI. This download may contain personal information. Names are cleared when you close this dialog.</p>
      <div className="space-y-2">
        <label className="block text-[12px] font-semibold" htmlFor={`${id}-file`}>Excel or CSV mapping</label>
        <input ref={input} id={`${id}-file`} type="file" accept=".xlsx,.csv" disabled={disabled}
          className="block w-full min-w-0 text-[12px]" onChange={event => void selectFile(event.target.files?.[0])} />
        <p className="text-[11px] text-muted">Up to 5 MiB, 20 worksheets, 10,000 rows, 50 columns and 200,000 cells; expanded Excel data up to 16 MiB. Use plain values, not formulas. Identifiers must be text, up to 512 characters; names up to 300.</p>
      </div>
      {loading && <p className="text-[12px]" role="status">Reading the local mapping...</p>}
      {workbook && <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="mb-1 block text-[12px] font-semibold" htmlFor={`${id}-sheet`}>Worksheet</label>
          <select id={`${id}-sheet`} className="filter-select w-full" disabled={disabled} value={sheetIndex} onChange={event => {
            setSheetIndex(Number(event.target.value)); setHeader(0); setIdentifierColumn(-1); setNameColumn(-1)
          }}>{workbook.sheets.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select></div>
        <div><label className="mb-1 block text-[12px] font-semibold" htmlFor={`${id}-header`}>Header row</label>
          <input id={`${id}-header`} type="number" className="filter-select w-full" min={1} max={sheet?.rows.length ?? 1}
            disabled={disabled} value={header + 1} onChange={event => {
              setHeader(Number(event.target.value) - 1); setIdentifierColumn(-1); setNameColumn(-1)
            }} /></div>
        <div><label className="mb-1 block text-[12px] font-semibold" htmlFor={`${id}-identifier`}>Applicant identifier column</label>
          <select id={`${id}-identifier`} className="filter-select w-full" disabled={disabled} value={identifierColumn}
            onChange={event => setIdentifierColumn(Number(event.target.value))}><option value={-1}>Choose a column</option>{columns}</select></div>
        <div><label className="mb-1 block text-[12px] font-semibold" htmlFor={`${id}-name`}>Full name column</label>
          <select id={`${id}-name`} className="filter-select w-full" disabled={disabled} value={nameColumn}
            onChange={event => setNameColumn(Number(event.target.value))}><option value={-1}>Choose a column</option>{columns}</select></div>
      </div>}
      <p className="text-[11px] text-muted">Matches use the original source filename, ignoring its resume-file extension and outer spaces only. Case and leading zeros matter. Unmatched applicants keep their identifiers.</p>
      {result && !result.error && <div className="space-y-2 text-[12px]">
        <p role="status">{matched} matched; {result.identities.length - matched} unmatched of {result.identities.length} unique applicants in completed reviews.</p>
        {matched === 0 && <p className="text-muted">No names match this scope. All completed reviews will still export under their identifiers.</p>}
        <dl className="space-y-1">{result.identities.slice(0, 8).map(identity => <div key={identity.resumeId} className="grid gap-x-3 sm:grid-cols-2">
          <dt className="break-words">{identity.identifier}</dt><dd className="break-words">{identity.name ?? 'No match - identifier retained'}</dd>
        </div>)}</dl>
        {result.identities.length > 8 && <p className="text-muted">Showing the first 8 applicants. Check the selected columns before downloading.</p>}
      </div>}
      {(error || result?.error) && <InlineError>{error || result?.error}</InlineError>}
      {!loading && !error && !result && <p className="text-[12px]" role="status">{workbook ? 'Choose the identifier and full-name columns to prepare this export.' : 'Choose a mapping file, or turn off name mapping to export normally.'}</p>}
      <Button size="sm" disabled={disabled} onClick={() => { clear(); setEnabled(false); onChange(undefined) }}>Remove mapping</Button>
    </>}
  </section>
}
