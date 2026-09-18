import type {
  RealAnalysisResumeSelection, RealAnalysisRunDetail, RealAnalysisRunSummary, RealAnalysisTargetSelection, RealAnalysisTargetSummary,
} from '../../domain/real-analyses'
import type { RealResumeSummary } from '../../domain/real-resumes'
import { analysisCancellationNeedsRetry } from '../../domain/real-analyses'
import type { Citation, SourceDocument, Workspace } from '../../domain/types'
import type { ReferenceDocument } from '../../domain/real-grades'
import { gradeHeadId } from '../../domain/real-grades'
import { isEntityArchived, isEntityRemoved, type LifecycleTarget } from '../../domain/lifecycle'
import { readyRealResume, resumeName } from '../resumes/resumeImportUi'

export interface SelectedRealResume {
  id: string
  label: string
  selection: RealAnalysisResumeSelection | null
  issue?: string
}

export interface SelectedRealTarget {
  id: string
  label: string
  selection: RealAnalysisTargetSelection | null
  summary?: RealAnalysisTargetSummary
  issue?: string
}

export function realAnalysisCancellationPending(summary: RealAnalysisRunSummary): boolean {
  return Boolean(summary.run.cancellation && !summary.run.cancellation.completedAt)
}

export function realAnalysisWorkActive(summary: RealAnalysisRunSummary): boolean {
  if (realAnalysisCancellationPaused(summary)) return false
  return ['initializing', 'queued', 'running'].includes(summary.run.status) || realAnalysisCancellationPending(summary)
}

export function realAnalysisCancellationPaused(summary: RealAnalysisRunSummary): boolean {
  return analysisCancellationNeedsRetry(summary.run)
}

export function realResumeSelection(summary: RealResumeSummary): RealAnalysisResumeSelection {
  if (!readyRealResume(summary) || !summary.documentRef) throw new Error('Only a ready real resume with an exact saved document can be selected.')
  return {
    resumeId: summary.resume.id, documentId: summary.documentRef.documentId,
    documentVersion: summary.documentRef.documentVersion, documentSha256: summary.documentRef.sha256,
  }
}

export function targetIdentity(selection: RealAnalysisTargetSelection): string {
  return selection.kind === 'job' ? `job:${selection.jobId}:${selection.rubricId}:${selection.rubricVersion}`
    : `grade:${selection.ladderId}:${selection.grade}:${selection.versionId}:${selection.version}`
}

export function targetFamilyIdentity(selection: RealAnalysisTargetSelection): string {
  return selection.kind === 'job' ? `job:${selection.jobId}:${selection.rubricId}` : `grade:${selection.ladderId}:${selection.grade}`
}

export function realTargetLifecycleTargets(workspace: Workspace, selection: RealAnalysisTargetSelection): LifecycleTarget[] {
  if (selection.kind === 'grade') return [{ kind: 'ladder', id: selection.ladderId }, { kind: 'rubric', id: gradeHeadId(selection.ladderId, selection.grade) }]
  const rubric = workspace.rubrics.find((item) => item.id === selection.rubricId && item.jobId === selection.jobId)
    ?? workspace.rubrics.find((item) => item.jobId === selection.jobId && item.dataKind === 'real')
  return [{ kind: 'job', id: selection.jobId }, { kind: 'rubric', id: rubric?.groupId ?? selection.rubricId }]
}

export function realTargetArchived(workspace: Workspace, selection: RealAnalysisTargetSelection): boolean {
  return realTargetLifecycleTargets(workspace, selection).some((target) => isEntityArchived(workspace, target))
}

export function realTargetAvailable(workspace: Workspace, selection: RealAnalysisTargetSelection): boolean {
  return !realTargetArchived(workspace, selection) && !realTargetRemoved(workspace, selection)
}

export function realTargetRemoved(workspace: Workspace, selection: RealAnalysisTargetSelection): boolean {
  if (selection.kind === 'job' && workspace.jobs.find((item) => item.id === selection.jobId)?.rubricDeletedAt) return true
  return realTargetLifecycleTargets(workspace, selection).some((target) => isEntityRemoved(workspace, target))
}

export function currentRealTarget(selection: RealAnalysisTargetSelection, targets: RealAnalysisTargetSummary[]): RealAnalysisTargetSummary | undefined {
  return targets.find((target) => targetIdentity(target.selection) === targetIdentity(selection))
    ?? targets.filter((target) => targetFamilyIdentity(target.selection) === targetFamilyIdentity(selection))
      .sort((left, right) => right.rubricVersion - left.rubricVersion)[0]
}

export function newerSavedJobTarget(selection: RealAnalysisTargetSelection, targets: RealAnalysisTargetSummary[]): RealAnalysisTargetSummary | undefined {
  if (selection.kind !== 'job') return undefined
  return targets.filter((target) => target.kind === 'job' && targetFamilyIdentity(target.selection) === targetFamilyIdentity(selection)
    && target.selection.rubricVersion > selection.rubricVersion).sort((left, right) => right.rubricVersion - left.rubricVersion)[0]
}

export function sameResumeSelection(a: RealAnalysisResumeSelection, b: RealAnalysisResumeSelection): boolean {
  return a.resumeId === b.resumeId && a.documentId === b.documentId && a.documentVersion === b.documentVersion && a.documentSha256 === b.documentSha256
}

export function sameTargetSelection(a: RealAnalysisTargetSelection, b: RealAnalysisTargetSelection): boolean {
  if (a.kind === 'job' && b.kind === 'job') return a.jobId === b.jobId && a.rubricId === b.rubricId && a.rubricVersion === b.rubricVersion
    && a.rubricHash === b.rubricHash && a.documentId === b.documentId && a.documentVersion === b.documentVersion && a.documentSha256 === b.documentSha256
  if (a.kind === 'grade' && b.kind === 'grade') return a.ladderId === b.ladderId && a.grade === b.grade && a.versionId === b.versionId
    && a.version === b.version && a.versionHash === b.versionHash && a.approvalId === b.approvalId && a.reviewId === b.reviewId
    && a.sourceSetId === b.sourceSetId && a.sourceSetHash === b.sourceSetHash
  return false
}

export const REAL_ANALYSIS_LINK_MAX_LENGTH = 1500

export interface RealAnalysisLinkInput {
  resumes?: RealAnalysisResumeSelection[]
  targets?: RealAnalysisTargetSelection[]
  from?: string
}

export interface RealAnalysisSelectionTransfer {
  kind: 'real-analysis-selection-v1'
  id: string
  workspaceId: string
  input: RealAnalysisLinkInput
}

export interface RealAnalysisNavigation {
  to: string
  state?: RealAnalysisSelectionTransfer
}

function exactLinkInput(input: RealAnalysisLinkInput): RealAnalysisLinkInput {
  return {
    ...(input.resumes ? { resumes: input.resumes.map((item) => ({
      resumeId: item.resumeId, documentId: item.documentId, documentVersion: item.documentVersion, documentSha256: item.documentSha256,
    })) } : {}),
    ...(input.targets ? { targets: input.targets.map((item): RealAnalysisTargetSelection => item.kind === 'job' ? {
      kind: 'job', jobId: item.jobId, rubricId: item.rubricId, rubricVersion: item.rubricVersion, rubricHash: item.rubricHash,
      documentId: item.documentId, documentVersion: item.documentVersion, documentSha256: item.documentSha256,
    } : {
      kind: 'grade', ladderId: item.ladderId, grade: item.grade, versionId: item.versionId, version: item.version, versionHash: item.versionHash,
      approvalId: item.approvalId, reviewId: item.reviewId, sourceSetId: item.sourceSetId, sourceSetHash: item.sourceSetHash,
    }) } : {}),
    ...(input.from ? { from: input.from } : {}),
  }
}

function addExactLinkInput(params: URLSearchParams, input: RealAnalysisLinkInput) {
  if (input.resumes?.length) params.set('resumeSelections', JSON.stringify(input.resumes))
  if (input.targets?.length) params.set('targetSelections', JSON.stringify(input.targets))
  if (input.from) params.set('from', input.from)
}

// Large selections use router history state, never an oversized URL or source-content browser storage.
export function realAnalysisLink(input: RealAnalysisLinkInput = {}, workspaceId?: string): RealAnalysisNavigation {
  const exact = exactLinkInput(input)
  const params = new URLSearchParams({ data: 'real' })
  addExactLinkInput(params, exact)
  const link = `/analyses/new?${params}`
  if (link.length <= REAL_ANALYSIS_LINK_MAX_LENGTH) return { to: link }
  if (!workspaceId) throw new Error('A large exact selection needs its originating workspace. No selections were discarded.')
  const id = crypto.randomUUID()
  return {
    to: `/analyses/new?${new URLSearchParams({ data: 'real', selectionTransfer: id })}`,
    state: { kind: 'real-analysis-selection-v1', id, workspaceId, input: exact },
  }
}

export function resolveRealAnalysisNavigation(params: URLSearchParams, state: unknown, workspaceId?: string): {
  params: URLSearchParams; transferred: boolean; error: string | null
} {
  if (!params.has('selectionTransfer')) return { params, transferred: false, error: null }
  const missing = () => ({
    params, transferred: false,
    error: 'The exact selections transferred with this navigation are unavailable in this tab or workspace. A copied large-selection URL alone cannot restore them. Return to the source library or choose inputs again. No inputs were substituted or started.',
  })
  const id = params.get('selectionTransfer')
  if (params.getAll('selectionTransfer').length !== 1 || !id || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)
    || !object(state) || state.kind !== 'real-analysis-selection-v1' || state.id !== id || !workspaceId || state.workspaceId !== workspaceId
    || !object(state.input)) return missing()
  const input = state.input
  if ((input.resumes !== undefined && (!Array.isArray(input.resumes) || !input.resumes.every(isRealResumeSelection)))
    || (input.targets !== undefined && (!Array.isArray(input.targets) || !input.targets.every(isRealTargetSelection)))
    || (input.from !== undefined && !text(input.from))) return missing()
  if (!(Array.isArray(input.resumes) && input.resumes.length) && !(Array.isArray(input.targets) && input.targets.length) && !text(input.from)) return missing()
  if (['resumes', 'rubrics', 'jobs', 'job', 'targets', 'ladder', 'grade', 'version', 'rubricVersion', 'from', 'resumeSelections', 'targetSelections', 'selectionTransport'].some((key) => params.has(key))) {
    return { params, transferred: false, error: 'This link mixes transferred selections with other requested inputs. Nothing was skipped or replaced. Start a separate selection or return to the original library.' }
  }
  const restored = new URLSearchParams(params)
  restored.delete('selectionTransfer')
  addExactLinkInput(restored, exactLinkInput(input as RealAnalysisLinkInput))
  return { params: restored, transferred: true, error: null }
}

export function targetVersionLabel(selection: RealAnalysisTargetSelection): string {
  return selection.kind === 'job' ? `Job rubric v${selection.rubricVersion} · source v${selection.documentVersion}`
    : `GS-${selection.grade} · approved v${selection.version}`
}

const ids = (value: string | null) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const version = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0
const hash = (value: unknown) => typeof value === 'string' && /^[a-f\d]{64}$/i.test(value)

export function isRealResumeSelection(value: unknown): value is RealAnalysisResumeSelection {
  return object(value) && text(value.resumeId) && text(value.documentId) && version(value.documentVersion) && hash(value.documentSha256)
}

export function isRealTargetSelection(value: unknown): value is RealAnalysisTargetSelection {
  if (!object(value)) return false
  if (value.kind === 'job') return text(value.jobId) && text(value.rubricId) && version(value.rubricVersion)
    && hash(value.rubricHash) && text(value.documentId) && version(value.documentVersion) && hash(value.documentSha256)
  return value.kind === 'grade' && text(value.ladderId) && version(value.grade) && Number(value.grade) <= 15
    && text(value.versionId) && version(value.version) && hash(value.versionHash) && text(value.approvalId) && text(value.reviewId)
    && text(value.sourceSetId) && hash(value.sourceSetHash)
}

function parseSelections<T>(raw: string | null, check: (value: unknown) => value is T, label: string, errors: string[]): T[] {
  if (raw === null) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || !value.length || !value.every(check)) throw new Error('Invalid selection')
    return value
  } catch {
    errors.push(`The exact ${label} selection in this link is invalid. Nothing will be silently skipped or replaced. Clear the requested selection and choose inputs again.`)
    return []
  }
}

export function initialRealSelections(
  params: URLSearchParams, resumes: RealResumeSummary[], targets: RealAnalysisTargetSummary[], previous?: RealAnalysisRunDetail,
  fragment = '',
): { resumes: SelectedRealResume[]; targets: SelectedRealTarget[]; errors: string[] } {
  const errors: string[] = []
  const chosenResumes: SelectedRealResume[] = []
  const chosenTargets: SelectedRealTarget[] = []
  if (params.has('selectionTransfer')) return {
    resumes: [], targets: [], errors: ['The exact navigation transfer has not been restored. No inputs were skipped or replaced; choose inputs again if this link has no matching state.'],
  }
  if (params.has('selectionTransport')) {
    const invalidLink = () => ({ resumes: [], targets: [], errors: ['The exact selections in this link are missing, ambiguous, or too large. Nothing was skipped or replaced. Open the complete link or explicitly choose inputs again.'] })
    if (params.getAll('selectionTransport').length !== 1 || params.get('selectionTransport') !== 'fragment' ||
      !fragment || fragment.length > 256_000) return invalidLink()
    const transferred = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment)
    if (!transferred.size ||
      [...transferred.keys()].some((key) => !['resumeSelections', 'targetSelections'].includes(key) ||
        transferred.getAll(key).length !== 1 || params.has(key))) return invalidLink()
    params = new URLSearchParams(params)
    for (const [key, value] of transferred) params.set(key, value)
    params.delete('selectionTransport')
  }
  const exactResumes = parseSelections(params.get('resumeSelections'), isRealResumeSelection, 'resume', errors)
  const exactTargets = parseSelections(params.get('targetSelections'), isRealTargetSelection, 'target', errors)
  if (previous) {
    chosenResumes.push(...previous.resumes.map((item) => ({ id: item.selection.resumeId, label: item.name || 'Name not stated', selection: item.selection })))
    chosenTargets.push(...previous.targets.map((item) => ({ id: targetIdentity(item.selection), label: item.label, selection: item.selection, summary: item })))
    if (['resumes', 'rubrics', 'jobs', 'job', 'targets', 'ladder', 'resumeSelections', 'targetSelections'].some((key) => params.has(key))) {
      errors.push('This link combines a previous run with additional inputs. Start a new selection or use only the saved run inputs; nothing will be silently ignored.')
    }
  } else {
    for (const selection of exactResumes) {
      const current = resumes.find((item) => item.resume.id === selection.resumeId)
      chosenResumes.push({ id: selection.resumeId, label: current ? resumeName(current) : 'Requested resume', selection })
    }
    for (const id of ids(params.get('resumes'))) {
      const current = resumes.find((item) => item.resume.id === id)
      chosenResumes.push(current && readyRealResume(current)
        ? { id, label: resumeName(current), selection: realResumeSelection(current) }
        : { id, label: current ? resumeName(current) : 'Requested resume', selection: null, issue: `Resume ${id} is not a ready real source in this workspace. Sample, missing, and unfinished inputs cannot be used.` })
    }
    for (const selection of exactTargets) {
      const current = targets.find((item) => targetIdentity(item.selection) === targetIdentity(selection))
      chosenTargets.push({ id: targetIdentity(selection), label: current?.label ?? 'Requested target', selection, summary: current })
    }
    function choose(matches: RealAnalysisTargetSummary[], requested: string) {
      if (matches.length !== 1) {
        chosenTargets.push({ id: `requested:${requested}`, label: requested, selection: null, issue: `${requested} is missing, ambiguous, a sample, or not an eligible real target. An exact saved job or approved GS version is required.` })
      } else {
        const current = matches[0]
        chosenTargets.push({ id: targetIdentity(current.selection), label: current.label, selection: current.selection, summary: current })
      }
    }
    for (const id of ids(params.get('targets'))) choose(targets.filter((target) => target.id === id), `Target ${id}`)
    for (const id of ids(params.get('rubrics'))) {
      const requestedVersion = params.get('rubricVersion')
      choose(targets.filter((target) => (target.rubricId === id || (target.kind === 'grade' && target.selection.versionId === id))
        && (requestedVersion === null || String(target.rubricVersion) === requestedVersion)), `Rubric ${id}${requestedVersion ? ` v${requestedVersion}` : ''}`)
    }
    for (const id of [...ids(params.get('jobs')), ...ids(params.get('job'))]) {
      choose(targets.filter((target) => target.kind === 'job' && target.selection.jobId === id), `Job ${id}`)
    }
    if (params.has('ladder')) {
      const matches = targets.filter((target) => target.kind === 'grade' && target.selection.ladderId === params.get('ladder')
        && (!params.has('grade') || String(target.selection.grade) === params.get('grade'))
        && (!params.has('version') || target.selection.versionId === params.get('version') || String(target.selection.version) === params.get('version')))
      if (matches.length) for (const target of matches) choose([target], target.label)
      else choose([], `Approved GS target in ladder ${params.get('ladder')}`)
    }
  }
  return { resumes: chosenResumes, targets: chosenTargets, errors }
}

export function resumeSelectionIssue(choice: SelectedRealResume, current: RealResumeSummary[], workspace?: Workspace): string | null {
  if (!choice.selection) return choice.issue ?? 'No exact resume version is selected.'
  if (workspace && (isEntityArchived(workspace, { kind: 'resume', id: choice.selection.resumeId }) || isEntityRemoved(workspace, { kind: 'resume', id: choice.selection.resumeId }))) {
    return 'This selected resume is archived or removed. Choose an active source; saved analyses keep their original evidence.'
  }
  const available = current.find((item) => item.resume.id === choice.selection?.resumeId)
  if (!available || !readyRealResume(available)) return 'This selected resume is archived, missing, or no longer ready in this workspace. Nothing was substituted.'
  if (!sameResumeSelection(choice.selection, realResumeSelection(available))) {
    return `The saved selection is document v${choice.selection.documentVersion}; the current ready source is v${available.documentRef?.documentVersion}. Its identity or hash changed. Review and explicitly select the current source.`
  }
  return null
}

export function targetSelectionIssue(choice: SelectedRealTarget, current: RealAnalysisTargetSummary[], workspace?: Workspace): string | null {
  if (!choice.selection) return choice.issue ?? 'No exact target version is selected.'
  if (workspace && !realTargetAvailable(workspace, choice.selection)) return 'This target or its parent is archived or removed. Unarchive the input before starting a new run; retained analysis snapshots are unchanged.'
  const available = currentRealTarget(choice.selection, current)
  if (!available) return 'This exact real target is no longer eligible. Unapproved, missing, and sample rubrics cannot be used.'
  if (!sameTargetSelection(choice.selection, available.selection)) {
    return `Selected: ${targetVersionLabel(choice.selection)}. Available now: ${targetVersionLabel(available.selection)}. The version, hash, approval, or source set changed; review before explicitly selecting it.`
  }
  return null
}

export function citationMatches(document: SourceDocument | ReferenceDocument, citation: Citation): boolean {
  if (document.sample !== false || document.id !== citation.documentId || document.version !== citation.documentVersion || !citation.quote) return false
  return document.paragraphs.some((paragraph) => paragraph.id === citation.paragraphId && paragraph.page === citation.page
    && paragraph.heading === citation.heading && paragraph.text.includes(citation.quote))
}
