import { useEffect, useId, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Download, LoaderCircle } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { usePublicSettings } from '../../app/public-settings-context'
import { createDefaultAdminSettings } from '../../domain/admin-settings-defaults'
import {
  RUBRIC_EXPORT_FORMATS, RUBRIC_EXPORT_FORMAT_ORDER, isRubricExportFormat, rubricExportFormatAllowed, type RubricExportFormat,
} from '../../domain/rubric-exports'
import type { Rubric } from '../../domain/types'
import { Badge, Button, InlineError, Modal } from '../../components/ui'

/** Downloads one saved job rubric version as a file that people outside Score can read. */
export function RubricExport({ rubric }: { rubric: Rubric }) {
  const location = useLocation()
  const { workspace, cloud } = useWorkspace()
  const publicSettings = usePublicSettings()
  const policy = publicSettings.settings?.reports ?? createDefaultAdminSettings().reports
  const role = cloud.workspaces.find((item) => item.id === cloud.currentWorkspaceId)?.role
  const job = workspace.jobs.find((item) => item.id === rubric.jobId)
  const fieldId = useId()
  const preferredFormat: RubricExportFormat = policy.defaultFormat && rubricExportFormatAllowed(policy, policy.defaultFormat)
    ? policy.defaultFormat
    : RUBRIC_EXPORT_FORMAT_ORDER.find((value) => rubricExportFormatAllowed(policy, value)) ?? 'markdown'
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<RubricExportFormat>(preferredFormat)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const active = useRef<AbortController | null>(null)
  const identity = `${cloud.currentWorkspaceId}:${rubric.jobId ?? ''}:${rubric.id}:${rubric.version}`
  // The Rubric exports Admin switch, as reported by /api/features, decides whether the button appears at all.
  const available = cloud.realJobs.features?.rubricExports === true && rubric.kind === 'job' && Boolean(rubric.jobId)

  useEffect(() => {
    setOpen(false)
    setStage(null)
    setError('')
    setSuccess('')
    return () => { active.current?.abort(); active.current = null }
  }, [identity, location.key])

  if (!available) return null

  const disabledReason = publicSettings.cloud && (publicSettings.phase !== 'ready' || !publicSettings.settings)
    ? publicSettings.error ?? (publicSettings.phase === 'loading' ? 'Checking current export permissions.'
      : 'Current export policy is unavailable. The rubric remains readable.')
    : policy.allowedRoles.length === 0 ? 'Official exports are disabled for every workspace role. The rubric remains readable.'
    : !role || !policy.allowedRoles.includes(role) ? 'Your current workspace role is not allowed to export rubrics. The rubric remains readable.'
    : !job || job.rubricDeletedAt ? 'The linked job or its rubric is unavailable in this workspace.' : ''
  const formatDisabledReason = rubricExportFormatAllowed(policy, format) ? ''
    : `${RUBRIC_EXPORT_FORMATS[format].label} export is disabled by application policy. Choose an enabled format.`
  const busy = stage !== null

  function cancel() {
    active.current?.abort()
    active.current = null
    setStage(null)
  }
  function changeOpen(value: boolean) {
    if (!value) cancel()
    setError('')
    setSuccess('')
    if (value) setFormat(preferredFormat)
    setOpen(value)
  }
  async function exportFile() {
    if (active.current || disabledReason || formatDisabledReason || !rubric.jobId) return
    const controller = new AbortController()
    active.current = controller
    const { signal } = controller
    const current = () => active.current === controller && !signal.aborted
    setError('')
    setSuccess('')
    setStage('Loading the saved rubric')
    try {
      const { exportRubric } = await import('../../services/analysisReports/rubric-export-client')
      signal.throwIfAborted()
      const filename = await exportRubric(
        { workspaceId: cloud.currentWorkspaceId, jobId: rubric.jobId, rubricId: rubric.id, version: rubric.version }, format,
        { signal, onProgress: (message) => { if (current()) setStage(message) } },
      )
      if (current()) setSuccess(`Download started: ${filename}`)
    } catch (caught) {
      if (current()) setError(caught instanceof Error && caught.name === 'TimeoutError'
        ? 'Rubric export exceeded its time limit. No incomplete file was downloaded.'
        : caught instanceof Error ? caught.message : 'The rubric could not be exported. No file was downloaded.')
    } finally {
      if (active.current === controller) { active.current = null; setStage(null) }
    }
  }

  return <>
    <Button size="sm" icon={Download} disabled={Boolean(disabledReason)}
      title={disabledReason || 'Download this rubric version to share how each criterion is defined and scored.'}
      onClick={() => changeOpen(true)}>Export rubric</Button>
    <Modal open={open} onOpenChange={changeOpen} title="Export rubric"
      description="Download this saved rubric version so others can see what each criterion asks for and how it is scored."
      footer={<>
        <Button onClick={() => changeOpen(false)}>{busy ? 'Cancel export' : 'Close'}</Button>
        <Button variant="primary" icon={busy ? LoaderCircle : Download} disabled={busy || Boolean(disabledReason || formatDisabledReason)}
          onClick={() => void exportFile()}>
          {busy ? 'Preparing rubric...' : `Download ${RUBRIC_EXPORT_FORMATS[format].label}`}
        </Button>
      </>}>
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2"><Badge tone="accent">Saved rubric</Badge><Badge>Version {rubric.version}</Badge></div>
        <div><label className="mb-2 block text-[12px] font-semibold" htmlFor={`${fieldId}-format`}>File format</label>
          <select id={`${fieldId}-format`} className="filter-select w-full" value={format} disabled={busy} onChange={(event) => {
            const value = event.target.value
            if (isRubricExportFormat(value)) { setFormat(value); setError(''); setSuccess('') }
          }}>
            {RUBRIC_EXPORT_FORMAT_ORDER.map((value) => {
              const enabled = rubricExportFormatAllowed(policy, value)
              return <option key={value} value={value} disabled={!enabled}>{RUBRIC_EXPORT_FORMATS[value].label}{enabled ? '' : ' (disabled by policy)'}</option>
            })}
          </select>
          <p className="mt-2 text-[11px] text-muted">{RUBRIC_EXPORT_FORMATS[format].description}</p>
          {formatDisabledReason && <p className="mt-2 text-[11px] text-muted" role="status">{formatDisabledReason}</p>}</div>
        <p className="text-[11px] text-muted">The file describes the job and every criterion: what it asks for, whether it is required or preferred, its weight, the 0–5 score guidance and the job posting quotes behind it. It also explains how criterion scores combine into an overall score out of 100.</p>
        <p className="text-[11px] text-muted">The file is generated in your browser from this saved version. It contains no candidate information, but it does quote the job posting, so share it only as your organization allows.</p>
        {stage && <p className="flex items-center gap-2 text-[12px]" role="status" aria-live="polite"><LoaderCircle size={15} className="animate-spin" aria-hidden="true" />{stage}</p>}
        {(error || disabledReason) && <InlineError>{error || disabledReason}</InlineError>}
        {success && <p className="break-words text-[12px]" role="status">{success}</p>}
      </div>
    </Modal>
  </>
}
