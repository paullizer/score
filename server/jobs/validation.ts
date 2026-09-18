import { JOB_IMPORT_LIMITS } from '../../src/domain/real-jobs'
import type { RealJobRecord } from '../../src/domain/real-jobs'
import type { Citation, Rubric, SourceDocument } from '../../src/domain/types'
import { isValidWorkspaceId } from '../ids'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const JOB_ID_PATTERN = new RegExp(`^job-${UUID_PATTERN.source.slice(1, -1)}$`, 'i')
const DOCUMENT_ID_PATTERN = new RegExp(`^document-${UUID_PATTERN.source.slice(1, -1)}$`, 'i')
const SAFE_BLOB_FILE_PATTERN = /^(?:original\.pdf|original\.html|source-document\.json)$/

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
  kindOrContentType: 'pdf' | 'url' | 'application/pdf' | 'text/html',
): string {
  const extension = kindOrContentType === 'pdf' || kindOrContentType === 'application/pdf' ? 'pdf' : 'html'
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

export function validateRealSourceDocument(value: unknown): string[] {
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
      Number(paragraphValue.page) > JOB_IMPORT_LIMITS.maxPdfPages) {
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

export function validateRealRubric(rubric: Rubric, document: SourceDocument): string[] {
  const errors = validateRealSourceDocument(document)
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
    !hasOnlyKeys(rubric.provenance, ['kind', 'model', 'promptVersion']) ||
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
    !isRecord(value.provenance) || !hasOnlyKeys(value.provenance, ['kind', 'model', 'promptVersion']) ||
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
    'id', 'workspaceId', 'recordType', 'job', 'source', 'inputFingerprint', 'createdBy', 'updatedAt', 'attempts',
    'nextAttemptAt', 'lease', 'extractedBlobName', 'error', 'warnings',
  ]) || value.recordType !== 'job' || typeof value.id !== 'string' || !isValidJobId(value.id) ||
    typeof value.workspaceId !== 'string' || !isValidWorkspaceId(value.workspaceId) || !isRecord(value.job) ||
    !hasOnlyKeys(value.job, [
      'id', 'title', 'organization', 'location', 'arrangement', 'employmentType', 'grade', 'series', 'source',
      'sourceLabel', 'batchId', 'documentId', 'rubricId', 'status', 'errorStage', 'error', 'createdAt', 'dataKind',
    ]) ||
    value.job.id !== value.id || value.job.dataKind !== 'real' || typeof value.job.documentId !== 'string' ||
    !isValidDocumentId(value.job.documentId) || !isRecord(value.source) ||
    !hasOnlyKeys(value.source, [
      'kind', 'displayName', 'url', 'finalUrl', 'originalBlobName', 'originalContentType', 'sha256', 'bytes',
      'capturedAt', 'extractionMethod',
    ]) ||
    (value.source.kind !== 'pdf' && value.source.kind !== 'url') || !isNonBlank(value.source.displayName) ||
    !isNonBlank(value.inputFingerprint) || !isNonBlank(value.createdBy) || !isTimestamp(value.updatedAt) ||
    !Number.isInteger(value.attempts) || Number(value.attempts) < 0 || !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === 'string')) {
    return false
  }
  if (value.source.originalBlobName !== undefined) {
    if (typeof value.source.originalBlobName !== 'string' ||
      (value.source.originalContentType !== 'application/pdf' && value.source.originalContentType !== 'text/html') ||
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
  if (value.source.kind === 'pdf' &&
    (value.source.originalContentType !== 'application/pdf' || value.source.originalBlobName === undefined)) {
    return false
  }
  if (value.source.kind === 'url' && !isNonBlank(value.source.url)) {
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
  if (value.source.extractionMethod !== undefined &&
    !['document-intelligence', 'html', 'browser'].includes(String(value.source.extractionMethod))) return false
  if (value.job.source !== value.source.kind || value.job.sourceLabel !== value.source.displayName ||
    !['queued', 'parsing', 'generating', 'ready', 'error', 'cancelled'].includes(String(value.job.status))) {
    return false
  }
  if (value.job.status === 'ready' && value.job.rubricId === null) return false
  if (value.nextAttemptAt !== undefined && !isTimestamp(value.nextAttemptAt)) return false
  if (value.lease !== undefined && (!isRecord(value.lease) || !hasOnlyKeys(value.lease, ['owner', 'expiresAt']) ||
    !isNonBlank(value.lease.owner) || !isTimestamp(value.lease.expiresAt))) {
    return false
  }
  if (value.error !== undefined && (!isRecord(value.error) || !hasOnlyKeys(value.error, ['code', 'message', 'retryable']) ||
    !isNonBlank(value.error.code) || !isNonBlank(value.error.message) || typeof value.error.retryable !== 'boolean')) return false
  return true
}
