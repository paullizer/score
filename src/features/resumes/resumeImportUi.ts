import { RESUME_IMPORT_LIMITS, type RealResumeSummary } from '../../domain/real-resumes'

export type RealResumeImportSource = { kind: 'pdf'; file: File } | { kind: 'url'; url: string }

export interface RealResumeImportItem {
  key: string
  source: RealResumeImportSource | { kind: 'pdf'; file: null }
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

export function validateResumeInput(source: RealResumeImportSource, limits = RESUME_IMPORT_LIMITS): string | undefined {
  if (source.kind === 'pdf') {
    if (!source.file.name.trim() || (!/\.pdf$/i.test(source.file.name) && source.file.type !== 'application/pdf')) return 'Choose a PDF file (.pdf). No other file format is supported.'
    if (!source.file.size) return 'This file is empty and could not be processed. Choose a readable PDF.'
    if (source.file.size > limits.maxPdfBytes) return `This PDF exceeds ${limits.maxPdfBytes / 1024 / 1024} MiB and could not be processed. Choose a smaller PDF.`
    return undefined
  }
  if (source.url.length > limits.maxUrlLength) return `This URL exceeds ${limits.maxUrlLength} characters and could not be processed.`
  if (!URL.canParse(source.url)) return 'Use a complete public http or https resume/profile URL.'
  const url = new URL(source.url)
  if (!['http:', 'https:'].includes(url.protocol)) return 'Only public http or https resume/profile URLs can be processed.'
  if (url.username || url.password) return 'URLs with embedded usernames or passwords cannot be processed. Supply a publicly accessible URL without credentials.'
  return undefined
}

export function resumeUrlLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

export function appendResumeInputs(batch: RealResumeImportBatch, inputs: RealResumeImportSource[], limits = RESUME_IMPORT_LIMITS): RealResumeImportBatch {
  if (batch.inputCount !== null) throw new Error('This batch has already been submitted. Retry its unchanged items, or explicitly start another batch.')
  if (batch.items.length + inputs.length > limits.maxBatchItems) {
    throw new Error(`A batch can contain at most ${limits.maxBatchItems} total PDFs and URLs. Nothing was truncated; your existing selection is unchanged.`)
  }
  const existingUrls = new Set(batch.items.flatMap((item) => item.source.kind === 'url' ? [item.source.url] : []))
  const items = inputs.map((source): RealResumeImportItem => {
    const error = validateResumeInput(source, limits)
    const repeated = source.kind === 'url' && existingUrls.has(source.url)
    if (source.kind === 'url') existingUrls.add(source.url)
    return {
      key: crypto.randomUUID(), source, label: source.kind === 'pdf' ? source.file.name : source.url,
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
  return summary.resume.dataKind === 'real' && summary.resume.status === 'ready' && Boolean(ref
    && ref.documentId === summary.resume.documentId && ref.documentVersion === summary.resume.documentVersion && ref.sha256)
}

export function resumeName(summary: RealResumeSummary): string {
  return summary.resume.name?.trim() || 'Name not stated'
}

export function resumeErrorMessage(summary: RealResumeSummary): string | null {
  if (!summary.error) return null
  return summary.error.code === 'access-blocked'
    ? 'This URL is not publicly accessible and could not be processed. Use a publicly accessible resume/profile URL, or upload a PDF you are authorized to use. Score cannot sign in or bypass site restrictions.'
    : summary.error.message
}
