import { JOB_IMPORT_LIMITS } from '../../src/domain/real-jobs'
import { processingSettingsSnapshotSchema } from '../../src/domain/admin-settings-schema'
import { promptExecutionProvenanceSchema } from '../../src/domain/prompt-versions'
import type { RealJobRecord } from '../../src/domain/real-jobs'
import { isSafeUploadedFilename } from '../../src/domain/source-files'
import type { Citation, Rubric, SourceDocument } from '../../src/domain/types'
import type { LifecycleMetadata } from '../../src/domain/lifecycle'
import { normalizeDisplayName } from '../../src/domain/displayNames'
import { invalidRequest } from '../errors'
import { isValidWorkspaceId } from '../ids'
import {
  isOriginalContentType, isUploadFormat, originalExtension, storedDocumentContentType, UPLOAD_CONTENT_TYPES,
  type OriginalContentType, type UploadFormat,
} from '../../src/domain/document-formats'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const JOB_ID_PATTERN = new RegExp(`^job-${UUID_PATTERN.source.slice(1, -1)}$`, 'i')
const DOCUMENT_ID_PATTERN = new RegExp(`^document-${UUID_PATTERN.source.slice(1, -1)}$`, 'i')
const SAFE_BLOB_FILE_PATTERN = /^(?:original\.(?:pdf|docx|doc|html|md)|source-document\.json)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

export function isNormalizedDisplayName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { return normalizeDisplayName(value) === value } catch { return false }
}

export function parseDisplayNameMetadata(value: unknown): { displayName: string } {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !hasOnlyKeys(value, ['displayName']) ||
    typeof value.displayName !== 'string') {
    throw invalidRequest('Metadata requests must contain only a displayName string.')
  }
  try { return { displayName: normalizeDisplayName(value.displayName) } } catch (error) {
    throw invalidRequest(error instanceof Error ? error.message : 'Display name is invalid.')
  }
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

export function isValidJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value)
}

export function isValidDocumentId(value: string): boolean {
  return DOCUMENT_ID_PATTERN.test(value)
}

export function originalBlobName(
  workspaceId: string,
  jobId: string,
  kindOrContentType: UploadFormat | 'url' | OriginalContentType,
): string {
  const contentType = isOriginalContentType(kindOrContentType) ? kindOrContentType
    : kindOrContentType === 'url' ? 'text/html' : isUploadFormat(kindOrContentType) ? UPLOAD_CONTENT_TYPES[kindOrContentType] : undefined
  if (!contentType) throw new Error('Invalid job original type.')
  const extension = originalExtension(contentType)
  return `${workspaceId}/${jobId}/original.${extension}`
}

export function extractedBlobName(workspaceId: string, jobId: string): string {
  return `${workspaceId}/${jobId}/source-document.json`
}

export function isSafeJobBlobName(value: string): boolean {
  const parts = value.split('/')
  return parts.length === 3 &&
    isValidWorkspaceId(parts[0]) &&
    isValidJobId(parts[1]) &&
    SAFE_BLOB_FILE_PATTERN.test(parts[2])
}

export function isBlobInJobPrefix(value: string, workspaceId: string, jobId: string): boolean {
  return isSafeJobBlobName(value) && value.startsWith(`${workspaceId}/${jobId}/`)
}

export function jobBlobPrefix(workspaceId: string, jobId?: string): string {
  if (!isValidWorkspaceId(workspaceId) || (jobId !== undefined && !isValidJobId(jobId))) {
    throw new Error('Invalid job blob scope.')
  }
  return jobId === undefined ? `${workspaceId}/` : `${workspaceId}/${jobId}/`
}

export function isJobBlobInScope(value: string, workspaceId: string, jobId?: string): boolean {
  const parts = value.split('/')
  return value.startsWith(jobBlobPrefix(workspaceId, jobId)) && parts.length >= 3 &&
    parts[0] === workspaceId && isValidJobId(parts[1]) &&
    (jobId === undefined || parts[1] === jobId) &&
    parts.slice(2).every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(part))
}

function isLifecycle(value: unknown): value is LifecycleMetadata | undefined {
  return value === undefined || (isRecord(value) &&
    hasOnlyKeys(value, ['archivedAt', 'deletingAt', 'deletedAt', 'parentKey']) &&
    ['archivedAt', 'deletingAt', 'deletedAt'].every(key => value[key] === undefined || isTimestamp(value[key])) &&
    (value.parentKey === undefined || isNonBlank(value.parentKey)))
}

export function jobBlobContentType(name: string): OriginalContentType | 'application/json' {
  if (!isSafeJobBlobName(name)) throw new Error('Invalid job blob name.')
  const contentType = storedDocumentContentType(name)
  if (!contentType) throw new Error('Invalid job blob content type.')
  return contentType
}

export function validateRealSourceDocument(value: unknown, contentType?: OriginalContentType): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['Source document must be an object.']
  if (!hasOnlyKeys(value, ['id', 'title', 'kind', 'version', 'paragraphs', 'sample'])) {
    errors.push('Source document contains unsupported fields.')
  }
  if (!isValidDocumentId(typeof value.id === 'string' ? value.id : '')) errors.push('Source document has an invalid id.')
  if (!isNonBlank(value.title)) errors.push('Source document title is required.')
  if (value.kind !== 'job') errors.push('Source document kind must be job.')
  if (!Number.isInteger(value.version) || Number(value.version) < 1) errors.push('Source document version must be a positive integer.')
  if (value.sample !== false) errors.push('Real source documents must have sample=false.')
  if (!Array.isArray(value.paragraphs) || value.paragraphs.length === 0) {
    errors.push('Source document must contain at least one paragraph.')
    return errors
  }

  const paragraphIds = new Set<string>()
  let sourceCharacters = 0
  for (const paragraphValue of value.paragraphs) {
    if (!isRecord(paragraphValue) || !hasOnlyKeys(paragraphValue, ['id', 'page', 'heading', 'text'])) {
      errors.push('Every source paragraph must be a complete paragraph object.')
      continue
    }
    if (!isNonBlank(paragraphValue.id)) errors.push('Every source paragraph needs an id.')
    else if (paragraphIds.has(paragraphValue.id)) errors.push(`Source document repeats paragraph id "${paragraphValue.id}".`)
    else paragraphIds.add(paragraphValue.id)
    if (!Number.isInteger(paragraphValue.page) || Number(paragraphValue.page) < 1 ||
      Number(paragraphValue.page) > (contentType === 'application/pdf' ? JOB_IMPORT_LIMITS.maxPdfPages : 100_000)) {
      errors.push('Source paragraph page is outside the supported range.')
    }
    if (typeof paragraphValue.heading !== 'string') errors.push('Every source paragraph needs a heading string.')
    if (!isNonBlank(paragraphValue.text)) errors.push('Every source paragraph needs text.')
    if (typeof paragraphValue.heading === 'string') sourceCharacters += paragraphValue.heading.length
    if (typeof paragraphValue.text === 'string') sourceCharacters += paragraphValue.text.length
  }
  if (sourceCharacters > JOB_IMPORT_LIMITS.maxSourceCharacters) {
    errors.push(`Source document exceeds ${JOB_IMPORT_LIMITS.maxSourceCharacters} characters.`)
  }
  return errors
}

function citationErrors(citation: unknown, document: SourceDocument, context: string): string[] {
  if (!isRecord(citation) ||
    !hasOnlyKeys(citation, ['documentId', 'documentVersion', 'paragraphId', 'page', 'heading', 'quote'])) {
    return [`${context} must contain complete citation objects.`]
  }
  const paragraph = typeof citation.paragraphId === 'string'
    ? document.paragraphs.find((candidate) => candidate.id === citation.paragraphId)
    : undefined
  if (citation.documentId !== document.id || citation.documentVersion !== document.version || !paragraph ||
    citation.page !== paragraph.page || citation.heading !== paragraph.heading ||
    !isNonBlank(citation.quote) || !paragraph.text.includes(citation.quote)) {
    return [`${context} has a citation that does not exactly match this source document.`]
  }
  return []
}

export function validateRealRubric(rubric: Rubric, document: SourceDocument, contentType?: OriginalContentType): string[] {
  const errors = validateRealSourceDocument(document, contentType)
  if (!isRecord(rubric)) return [...errors, 'Rubric must be an object.']
  if (!hasOnlyKeys(rubric as unknown as Record<string, unknown>, [
    'id', 'groupId', 'kind', 'jobId', 'name', 'description', 'version', 'criteria', 'createdAt', 'dataKind', 'provenance',
  ])) {
    errors.push('Rubric contains unsupported fields.')
  }
  if (!isNonBlank(rubric.id) || !isNonBlank(rubric.groupId)) errors.push('Rubric id and group id are required.')
  if (rubric.kind !== 'job' || !isValidJobId(rubric.jobId ?? '')) errors.push('Rubric must identify a real job.')
  if (!isNonBlank(rubric.name) || !isNonBlank(rubric.description)) errors.push('Rubric name and description are required.')
  if (!Number.isInteger(rubric.version) || rubric.version < 1) errors.push('Rubric version must be a positive integer.')
  if (!isTimestamp(rubric.createdAt)) errors.push('Rubric createdAt must be a timestamp.')
  if (rubric.dataKind !== 'real') errors.push('Real rubrics must have dataKind=real.')
  if (!isRecord(rubric.provenance) ||
    !hasOnlyKeys(rubric.provenance, ['kind', 'model', 'promptVersion', 'prompt']) ||
    (rubric.provenance.prompt !== undefined && (!promptExecutionProvenanceSchema.safeParse(rubric.provenance.prompt).success ||
      rubric.provenance.prompt.family !== 'jobRubric' || rubric.provenance.prompt.revisionId !== rubric.provenance.promptVersion)) ||
    !['generated', 'edited'].includes(String(rubric.provenance.kind)) ||
    !isNonBlank(rubric.provenance.model) || !isNonBlank(rubric.provenance.promptVersion)) {
    errors.push('Rubric provenance must identify its kind, model, and prompt version.')
  }
  if (!Array.isArray(rubric.criteria) || rubric.criteria.length < 1 ||
    rubric.criteria.length > JOB_IMPORT_LIMITS.maxCriteria) {
    errors.push(`Rubric must contain between 1 and ${JOB_IMPORT_LIMITS.maxCriteria} criteria.`)
    return errors
  }

  const criterionIds = new Set<string>()
  let weight = 0
  for (const criterion of rubric.criteria) {
    const context = `Criterion "${typeof criterion?.label === 'string' ? criterion.label : ''}"`
    if (!isRecord(criterion) || !hasOnlyKeys(criterion, [
      'id', 'key', 'label', 'description', 'weight', 'guidance', 'sourceParagraphId', 'requirementType', 'sourceCitations',
    ])) {
      errors.push(`${context} contains unsupported fields.`)
      continue
    }
    if (!isNonBlank(criterion.id)) errors.push(`${context} needs an id.`)
    else if (criterionIds.has(criterion.id)) errors.push(`Rubric repeats criterion id "${criterion.id}".`)
    else criterionIds.add(criterion.id)
    if (criterion.key !== 'custom') errors.push(`${context} must use the custom criterion key.`)
    if (!isNonBlank(criterion.label) || !isNonBlank(criterion.description) || !isNonBlank(criterion.guidance)) {
      errors.push(`${context} needs a label, description, and guidance.`)
    }
    if (typeof criterion.weight !== 'number' || !Number.isFinite(criterion.weight) ||
      criterion.weight <= 0 || criterion.weight > 100) {
      errors.push(`${context} has an invalid weight.`)
    } else {
      weight += criterion.weight
    }
    if (criterion.requirementType !== 'required' && criterion.requirementType !== 'preferred') {
      errors.push(`${context} must be required or preferred.`)
    }
    if (!Array.isArray(criterion.sourceCitations) || criterion.sourceCitations.length === 0) {
      errors.push(`${context} needs at least one exact source citation.`)
    } else {
      for (const citation of criterion.sourceCitations) errors.push(...citationErrors(citation, document, context))
    }
    if (criterion.sourceParagraphId !== undefined) {
      if (!isNonBlank(criterion.sourceParagraphId) ||
        !document.paragraphs.some((paragraph) => paragraph.id === criterion.sourceParagraphId)) {
        errors.push(`${context} has an invalid source paragraph id.`)
      }
    }
  }
  if (Math.abs(weight - 100) > 0.000001) errors.push('Rubric criterion weights must total exactly 100.')
  return errors
}

export function validateStoredRealRubric(value: unknown): value is Rubric {
  if (!isRecord(value) || value.dataKind !== 'real' || value.kind !== 'job' || !isValidJobId(String(value.jobId ?? '')) ||
    !isNonBlank(value.id) || !isNonBlank(value.groupId) || !isNonBlank(value.name) || !isNonBlank(value.description) ||
    !Number.isInteger(value.version) || Number(value.version) < 1 || !isTimestamp(value.createdAt) ||
    !Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > JOB_IMPORT_LIMITS.maxCriteria ||
    !isRecord(value.provenance) || !hasOnlyKeys(value.provenance, ['kind', 'model', 'promptVersion', 'prompt']) ||
    (value.provenance.prompt !== undefined && (!promptExecutionProvenanceSchema.safeParse(value.provenance.prompt).success ||
      !isRecord(value.provenance.prompt) || value.provenance.prompt.family !== 'jobRubric' ||
      value.provenance.prompt.revisionId !== value.provenance.promptVersion)) ||
    !['generated', 'edited'].includes(String(value.provenance.kind)) ||
    !isNonBlank(value.provenance.model) || !isNonBlank(value.provenance.promptVersion)) {
    return false
  }
  let totalWeight = 0
  const validCriteria = value.criteria.every((criterion) => {
    if (!isRecord(criterion) ||
      !hasOnlyKeys(criterion, [
        'id', 'key', 'label', 'description', 'weight', 'guidance', 'sourceParagraphId', 'requirementType', 'sourceCitations',
      ]) ||
      !isNonBlank(criterion.id) || criterion.key !== 'custom' || !isNonBlank(criterion.label) ||
      !isNonBlank(criterion.description) || typeof criterion.weight !== 'number' ||
      !Number.isFinite(criterion.weight) || criterion.weight <= 0 || criterion.weight > 100 ||
      !isNonBlank(criterion.guidance) || !['required', 'preferred'].includes(String(criterion.requirementType)) ||
      !Array.isArray(criterion.sourceCitations)) {
      return false
    }
    totalWeight += criterion.weight
    return criterion.sourceCitations.length > 0 && criterion.sourceCitations.every((citation): citation is Citation =>
      isRecord(citation) && hasOnlyKeys(citation, ['documentId', 'documentVersion', 'paragraphId', 'page', 'heading', 'quote']) &&
      isNonBlank(citation.documentId) && Number.isInteger(citation.documentVersion) &&
      isNonBlank(citation.paragraphId) && Number.isInteger(citation.page) && typeof citation.heading === 'string' &&
      isNonBlank(citation.quote))
  })
  return validCriteria && Math.abs(totalWeight - 100) <= 0.000001
}

export function validateRealJobRecord(value: unknown): value is RealJobRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'workspaceId', 'recordType', 'displayName', 'job', 'source', 'inputFingerprint', 'createdBy', 'updatedAt', 'attempts',
    'nextAttemptAt', 'lease', 'extractedBlobName', 'error', 'warnings', 'lifecycle', 'rubricLifecycle', 'processingSettings',
  ]) || value.recordType !== 'job' || typeof value.id !== 'string' || !isValidJobId(value.id) ||
    typeof value.workspaceId !== 'string' || !isValidWorkspaceId(value.workspaceId) || !isRecord(value.job) ||
    !hasOnlyKeys(value.job, [
      'id', 'title', 'organization', 'location', 'arrangement', 'employmentType', 'grade', 'series', 'source',
      'sourceLabel', 'batchId', 'documentId', 'rubricId', 'rubricDeletedAt', 'status', 'errorStage', 'error', 'createdAt', 'dataKind',
    ]) ||
    value.job.id !== value.id || value.job.dataKind !== 'real' || typeof value.job.documentId !== 'string' ||
    !isValidDocumentId(value.job.documentId) || !isRecord(value.source) ||
    !hasOnlyKeys(value.source, [
      'kind', 'displayName', 'url', 'finalUrl', 'originalBlobName', 'originalContentType', 'sha256', 'bytes',
      'capturedAt', 'extractionMethod',
    ]) ||
    (!isUploadFormat(value.source.kind) && value.source.kind !== 'url') || !isNonBlank(value.source.displayName) ||
    !isNonBlank(value.inputFingerprint) || !isNonBlank(value.createdBy) || !isTimestamp(value.updatedAt) ||
    !Number.isInteger(value.attempts) || Number(value.attempts) < 0 || !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === 'string')) {
    return false
  }
  if (value.displayName !== undefined && !isNormalizedDisplayName(value.displayName)) return false
  if (value.processingSettings !== undefined && !processingSettingsSnapshotSchema.safeParse(value.processingSettings).success) return false
  if (value.source.originalBlobName !== undefined) {
    if (typeof value.source.originalBlobName !== 'string' ||
      !isOriginalContentType(value.source.originalContentType) ||
      !isBlobInJobPrefix(value.source.originalBlobName, value.workspaceId, value.id) ||
      value.source.originalBlobName !== originalBlobName(value.workspaceId, value.id, value.source.originalContentType)) {
      return false
    }
  }
  if (value.extractedBlobName !== undefined &&
    (typeof value.extractedBlobName !== 'string' ||
      value.extractedBlobName !== extractedBlobName(value.workspaceId, value.id))) {
    return false
  }
  if (value.source.kind !== 'url') {
    const format = value.source.kind
    if (!isUploadFormat(format) || value.source.originalContentType !== UPLOAD_CONTENT_TYPES[format] ||
      value.source.originalBlobName === undefined ||
      value.source.url !== undefined || value.source.finalUrl !== undefined) return false
    if (format !== 'pdf' && (!isSafeUploadedFilename(value.source.displayName, format) ||
      typeof value.source.sha256 !== 'string' || !Number.isInteger(value.source.bytes) ||
      Number(value.source.bytes) < 1 || Number(value.source.bytes) >
        (format === 'markdown' ? JOB_IMPORT_LIMITS.maxMarkdownBytes : JOB_IMPORT_LIMITS.maxFileBytes))) return false
  }
  if (value.source.kind === 'url' &&
    (!isNonBlank(value.source.url) || (value.source.originalContentType !== undefined &&
      value.source.originalContentType !== 'application/pdf' && value.source.originalContentType !== 'text/html'))) {
    return false
  }
  const job = value.job
  if (!isNonBlank(job.title) || !isTimestamp(job.createdAt) ||
    !['organization', 'location', 'arrangement', 'employmentType', 'grade', 'series'].every(
      (field) => typeof job[field] === 'string',
    ) ||
    (job.rubricId !== null && !isNonBlank(job.rubricId)) ||
    (job.batchId !== undefined && (typeof job.batchId !== 'string' || !isUuid(job.batchId))) ||
    (job.errorStage !== undefined && !['download', 'parsing', 'rubric'].includes(String(job.errorStage))) ||
    (job.error !== undefined && !isNonBlank(job.error))) {
    return false
  }
  if (value.source.url !== undefined && typeof value.source.url !== 'string') return false
  if (value.source.finalUrl !== undefined && typeof value.source.finalUrl !== 'string') return false
  if (value.source.sha256 !== undefined && (typeof value.source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.source.sha256))) {
    return false
  }
  if (value.source.bytes !== undefined && (!Number.isInteger(value.source.bytes) || Number(value.source.bytes) < 0)) return false
  if (value.source.capturedAt !== undefined && !isTimestamp(value.source.capturedAt)) return false
  if (value.source.extractionMethod !== undefined) {
    switch (value.source.originalContentType) {
      case 'application/pdf':
      case UPLOAD_CONTENT_TYPES.docx:
        if (value.source.extractionMethod !== 'document-intelligence') return false
        break
      case UPLOAD_CONTENT_TYPES.doc:
        if (value.source.extractionMethod !== 'legacy-word') return false
        break
      case 'text/html':
        if (!['html', 'browser'].includes(String(value.source.extractionMethod))) return false
        break
      case 'text/markdown':
        if (value.source.extractionMethod !== 'markdown') return false
        break
      default: return false
    }
  }
  if (value.job.source !== value.source.kind || value.job.sourceLabel !== value.source.displayName ||
    !['queued', 'parsing', 'generating', 'ready', 'error', 'cancelled'].includes(String(value.job.status))) {
    return false
  }
  if (!isLifecycle(value.lifecycle) || !isLifecycle(value.rubricLifecycle)) return false
  if (job.rubricDeletedAt !== undefined &&
    (!isTimestamp(job.rubricDeletedAt) || job.rubricId !== null || !value.rubricLifecycle?.deletedAt)) return false
  if (value.rubricLifecycle?.deletedAt && (!job.rubricDeletedAt || job.rubricId !== null)) return false
  if (value.job.status === 'ready' && value.job.rubricId === null && !job.rubricDeletedAt) return false
  if (value.nextAttemptAt !== undefined && !isTimestamp(value.nextAttemptAt)) return false
  if (value.lease !== undefined && (!isRecord(value.lease) || !hasOnlyKeys(value.lease, ['owner', 'expiresAt']) ||
    !isNonBlank(value.lease.owner) || !isTimestamp(value.lease.expiresAt))) {
    return false
  }
  if (value.error !== undefined && (!isRecord(value.error) || !hasOnlyKeys(value.error, ['code', 'message', 'retryable']) ||
    !isNonBlank(value.error.code) || !isNonBlank(value.error.message) || typeof value.error.retryable !== 'boolean')) return false
  return true
}
