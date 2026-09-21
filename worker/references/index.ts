import { GRADE_LADDER_LIMITS } from '../../src/domain/real-grades'
import type { ExtractReferenceDocument, FetchReferenceOriginal } from './contracts'
import { WorkerError } from '../runtime'
import { extractReferenceHtml } from './html'
import { extractReferencePdf, referenceHash, REFERENCE_EXTRACTION_VERSION } from './pdf'
import { checkCancellation, fetchOriginalUrl, referenceUrl } from './transport'
import { fetchSettings } from '../settings'
import { urlMatchesPolicy } from '../../renderer/request-policy'

export type { DiscoveryOptions, ReferenceOriginal, ReferenceExtractionOptions, ReferenceExtraction } from './contracts'
export { getReferenceIssueTarget, reconcileReferenceIssues } from './issue-lifecycle'
export type { CapturedReferenceEvidence, ReferenceIssueReconciliation, ReferenceIssueResolution } from './issue-lifecycle'

/** The coordinator persists these complete bytes and redirect history in an immutable, authorized blob. */
export const fetchReferenceOriginal: FetchReferenceOriginal = async (source, options = {}) => {
  if (!source.requestedUrl) throw new WorkerError('reference-url-required', 'An uploaded reference must be read from its authorized immutable original blob.', false, 'download')
  return fetchOriginalUrl(source.requestedUrl, options, source.origin === 'opm')
}

const extractDocument: ExtractReferenceDocument = async (source, original, options) => {
  checkCancellation(options.signal)
  const limits = options.processingSettings?.settings.grades.references
  if (original.bytes.byteLength > (limits?.maxPdfBytes ?? GRADE_LADDER_LIMITS.maxPdfBytes)) throw new WorkerError('reference-too-large', 'The reference exceeds its captured byte limit.', false, 'parsing')
  if ((source.sha256 !== undefined && source.sha256 !== referenceHash(original.bytes)) ||
    (source.bytes !== undefined && source.bytes !== original.bytes.byteLength) ||
    (source.originalContentType !== undefined && source.originalContentType !== original.contentType)) {
    throw new WorkerError('reference-original-mismatch', 'The captured original does not match this source record’s immutable hash, size, or media type.', false, 'parsing')
  }
  const base = {
    id: source.documentId, version: source.documentVersion, kind: 'reference' as const, sample: false as const, title: source.title,
  }
  if (original.contentType === 'application/pdf') {
    const result = await extractReferencePdf(original.bytes, { ...source, finalUrl: original.finalUrl ?? source.finalUrl }, options)
    return {
      document: {
        ...base, paragraphs: result.paragraphs, pageCount: result.pageCount,
        selectedPages: result.selectedPages, completeness: result.completeness,
      },
      method: 'document-intelligence',
      extractionVersion: REFERENCE_EXTRACTION_VERSION,
      links: result.links,
      warnings: result.warnings,
    }
  }

  if (original.contentType !== 'text/html') throw new WorkerError('unsupported-reference-type', 'Only reference PDF and HTML extraction is supported.', false, 'parsing')
  if (source.selectedPages.length && (source.selectedPages.length !== 1 || source.selectedPages[0] !== 1)) {
    throw new WorkerError('reference-invalid-pages', 'HTML references have one logical page; use an intended section instead of PDF page ranges.', false, 'parsing')
  }
  const url = referenceUrl(original.finalUrl ?? source.finalUrl ?? source.requestedUrl ?? 'https://reference.invalid/').href
  const intendedSection = source.intendedSection || (source.requestedUrl ? new URL(source.requestedUrl).hash.replace(/^#/, '') : '') || undefined
  let extracted = extractReferenceHtml(Buffer.from(original.bytes).toString('utf8'), url, source.title, intendedSection, limits)
  let method: 'html' | 'browser' = 'html'
  if (extracted.thin && options.browser) {
    const renderOptions = options.processingSettings
      ? fetchSettings({ signal: options.signal }, options.processingSettings, source.origin === 'opm' ? 'opm' : 'agencyReferences')
      : { signal: options.signal, maxBytes: GRADE_LADDER_LIMITS.maxPdfBytes }
    const rendered = await options.browser.render(referenceUrl(source.requestedUrl ?? url, undefined, source.origin === 'opm').href, renderOptions)
    checkCancellation(options.signal)
    const finalUrl = referenceUrl(rendered.finalUrl, undefined, source.origin === 'opm').href
    if (!urlMatchesPolicy(finalUrl, renderOptions.urlPolicy)) throw new WorkerError('unsafe-url', 'The rendered reference is disallowed by its captured URL policy.', false, 'download')
    if (Buffer.byteLength(rendered.html, 'utf8') > (limits?.maxPdfBytes ?? GRADE_LADDER_LIMITS.maxPdfBytes)) {
      throw new WorkerError('reference-too-large', 'The rendered reference exceeds its captured byte limit.', false, 'parsing')
    }
    extracted = extractReferenceHtml(rendered.html, finalUrl, source.title, intendedSection, limits)
    extracted.warnings.push('Text was obtained from the injected isolated renderer; the immutable original retains the initially fetched HTML.')
    method = 'browser'
  }
  if (extracted.thin || !extracted.paragraphs.length) {
    throw new WorkerError('reference-empty', 'The captured page lacks substantive reference text. An isolated renderer or a directly supplied PDF may be required.', false, 'parsing')
  }
  checkCancellation(options.signal)
  return {
    document: { ...base, paragraphs: extracted.paragraphs, pageCount: 1, selectedPages: [1], completeness: 'complete' },
    method, extractionVersion: REFERENCE_EXTRACTION_VERSION, links: extracted.links, warnings: extracted.warnings,
  }
}

/** PDF checkpoints use opaque source/version/page/endpoint-bound keys; both cache callbacks must be immutable. */
export const extractReferenceDocument: ExtractReferenceDocument = async (source, original, options) => {
  try {
    return await extractDocument(source, original, options)
  } catch (error) {
    checkCancellation(options.signal)
    if (error instanceof Response) {
      throw new WorkerError('reference-ocr-unavailable', `Reference OCR returned HTTP ${error.status} after bounded retries.`,
        error.status === 429 || error.status >= 500, 'parsing')
    }
    throw error
  }
}
