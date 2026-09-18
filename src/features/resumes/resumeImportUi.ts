import { RESUME_IMPORT_LIMITS, type RealResumeSummary } from '../../domain/real-resumes'
import type { UploadFormat } from '../../domain/document-formats'
import { isSafeUploadedFilename, uploadedFileKind, type UploadedSourceKind } from '../../domain/source-files'
import { uploadFileByteLimit, uploadFormatNames, validateUploadFile } from '../../services/documentUploads'
import { lifecycleIsRemoved } from '../../domain/lifecycle'

export type RealResumeImportSource = { kind: UploadedSourceKind | 'unsupported'; file: File } | { kind: 'url'; url: string }

export function resumeFileSource(file: File): RealResumeImportSource {
  return { kind: uploadedFileKind(file) ?? 'unsupported', file }
}

export interface RealResumeImportItem {
  key: string
  source: RealResumeImportSource | { kind: UploadedSourceKind; file: null }
  label: string
  state: 'pending' | 'invalid' | 'uploading' | 'accepted' | 'unconfirmed'
  error?: string
  warning?: string
  resumeId?: string
}

export interface RealResumeImportBatch {
  id: string
  // Locked at first submission, including invalid entries; every retry keeps this declared size.
  inputCount: number | null
  items: RealResumeImportItem[]
}

export function resumeFileInput(file: File): RealResumeImportSource {
  return resumeFileSource(file)
}

export function validateResumeInput(source: RealResumeImportSource, limits = RESUME_IMPORT_LIMITS, formats: readonly UploadFormat[] | boolean = ['pdf']): string | undefined {
  const available: readonly UploadFormat[] = typeof formats === 'boolean' ? formats ? ['pdf', 'markdown'] : ['pdf'] : formats
  if (source.kind !== 'url') {
    if (source.kind === 'unsupported' || uploadedFileKind(source.file) !== source.kind) return `Choose a supported file: ${uploadFormatNames(available)}. Other file types are not supported.`
    const label = uploadFormatNames([source.kind])
    if (!isSafeUploadedFilename(source.file.name, source.kind)) return `Choose a ${label} file with a safe filename without reserved names, path separators, or control characters.`
    if (source.kind === 'markdown' && !available.includes('markdown')) return 'Markdown resume imports are not enabled in this deployment. PDFs and public URLs are still supported.'
    return validateUploadFile(source.file, available, uploadFileByteLimit(source.kind, limits))
  }
  if (source.url.length > limits.maxUrlLength) return `This URL exceeds ${limits.maxUrlLength} characters and could not be processed.`
  if (!URL.canParse(source.url)) return 'Use a complete public http or https resume/profile URL.'
  const url = new URL(source.url)
  if (!['http:', 'https:'].includes(url.protocol)) return 'Only public http or https resume/profile URLs can be processed.'
  if (url.username || url.password) return 'URLs with embedded usernames or passwords cannot be processed. Supply a publicly accessible URL without credentials.'
  if (/\.(docx?|docm|dotx?)$/i.test(url.pathname)) return 'Word URLs cannot be imported. Download the document and upload a supported file instead.'
  if (/\.(md|markdown)$/i.test(url.pathname)) return 'Markdown URLs cannot be imported. Download the document and upload a Markdown file instead.'
  return undefined
}

export function resumeUrlLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

export function appendResumeInputs(batch: RealResumeImportBatch, inputs: RealResumeImportSource[], limits = RESUME_IMPORT_LIMITS, formats: readonly UploadFormat[] | boolean = ['pdf']): RealResumeImportBatch {
  if (batch.inputCount !== null) throw new Error('This batch has already been submitted. Retry its unchanged items, or explicitly start another batch.')
  if (batch.items.length + inputs.length > limits.maxBatchItems) {
    throw new Error(`A batch can contain at most ${limits.maxBatchItems} total files and URLs. Nothing was truncated; your existing selection is unchanged.`)
  }
  const existingUrls = new Set(batch.items.flatMap((item) => item.source.kind === 'url' ? [item.source.url] : []))
  const items = inputs.map((source): RealResumeImportItem => {
    const error = validateResumeInput(source, limits, formats)
    const repeated = source.kind === 'url' && existingUrls.has(source.url)
    if (source.kind === 'url') existingUrls.add(source.url)
    return {
      key: crypto.randomUUID(), source, label: source.kind === 'url' ? source.url : source.file.name,
      state: error ? 'invalid' : 'pending', error,
      warning: repeated ? 'This URL is repeated in the batch. It remains a separate input; the server will report duplicate evidence.' : undefined,
    }
  })
  return { ...batch, items: [...batch.items, ...items] }
}

export function resumeWorkActive(summary: RealResumeSummary): boolean {
  return ['queued', 'parsing', 'profiling'].includes(summary.resume.status)
}

export function readyRealResume(summary: RealResumeSummary): boolean {
  const ref = summary.documentRef
  return !summary.lifecycle?.archivedAt && !lifecycleIsRemoved(summary.lifecycle) &&
    (!summary.lifecycleOperation || summary.lifecycleOperation.status === 'complete') &&
    summary.resume.dataKind === 'real' && summary.resume.status === 'ready' && Boolean(ref
    && ref.documentId === summary.resume.documentId && ref.documentVersion === summary.resume.documentVersion && ref.sha256)
}

export function resumeName(summary: RealResumeSummary): string {
  return summary.resume.name?.trim() || 'Name not stated'
}

export function resumeErrorMessage(summary: RealResumeSummary): string | null {
  if (!summary.error) return null
  return summary.error.code === 'access-blocked'
    ? 'This URL is not publicly accessible and could not be processed. Use a publicly accessible resume/profile URL, or upload a supported document you are authorized to use. Score cannot sign in or bypass site restrictions.'
    : summary.error.message
}
