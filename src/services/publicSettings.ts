import type { PublicFeaturesResponse, PublicSettings } from '../domain/admin-settings'
import { JOB_IMPORT_LIMITS, type JobProcessingFeatures } from '../domain/real-jobs'
import { RESUME_IMPORT_LIMITS, type ResumeProcessingFeatures } from '../domain/real-resumes'
import { GRADE_LADDER_LIMITS, type GradeProcessingFeatures } from '../domain/real-grades'
import { ANALYSIS_LIMITS, type AnalysisProcessingFeatures } from '../domain/real-analyses'
import { cloudJsonRequest } from './cloudWorkspace'
import type { UploadFormat } from '../domain/document-formats'
import { validateUploadFile } from './documentUploads'

export type PublicFeatureResponse = Partial<PublicFeaturesResponse>

export function fetchPublicFeatures(signal?: AbortSignal): Promise<PublicFeatureResponse> {
  return cloudJsonRequest('/features', { method: 'GET', signal })
}

export type NewWorkKind = 'jobImports' | 'resumeImports' | 'gradeLadders' | 'newAnalyses' | 'summaryGeneration'

export function admissionReason(settings: PublicSettings | null | undefined, kind?: NewWorkKind): string | null {
  if (!settings) return null
  if (settings.runtimeReadiness?.newProcessingAllowed === false) {
    return settings.runtimeReadiness.message || 'New processing is paused until the worker rollout is verified. Saved records and evidence remain readable.'
  }
  if (settings.maintenance.pauseNewWork) return settings.maintenance.explanation || 'New work is paused by an application administrator. Saved work remains available.'
  if (kind && !settings.features[kind]) return 'This new action is disabled by application policy. Saved records, evidence, and history remain available.'
  return null
}

export function requireAdmission(settings: PublicSettings | null | undefined, kind: NewWorkKind) {
  const reason = admissionReason(settings, kind)
  if (reason) throw new Error(reason)
}

export function effectiveFormats(formats: readonly UploadFormat[], settings: PublicSettings | null | undefined, kind: 'jobs' | 'resumes'): UploadFormat[] {
  return formats.filter(format => !settings || settings.imports[kind].allowedFormats.includes(format))
}

export function requireImportFile(file: File, kind: 'jobs' | 'resumes', settings?: PublicSettings | null) {
  if (!settings) return
  requireAdmission(settings, kind === 'jobs' ? 'jobImports' : 'resumeImports')
  const policy = settings.imports[kind]
  const error = validateUploadFile(file, policy.allowedFormats, Math.min(10 * 1024 * 1024, policy.maxFileBytes))
  if (error) throw new Error(error)
}

export function requireImportUrl(url: string, kind: 'jobs' | 'resumes' | 'agencyReferences', settings?: PublicSettings | null) {
  if (!settings) return
  requireAdmission(settings, kind === 'jobs' ? 'jobImports' : kind === 'resumes' ? 'resumeImports' : 'gradeLadders')
  const allowed = kind === 'agencyReferences' ? settings.grades.references.allowAgencyUrls : settings.imports[kind].allowUrls
  if (!allowed) throw new Error('New public URL imports are disabled by application policy.')
  if (settings.imports.requireHttps && (!URL.canParse(url) || new URL(url).protocol !== 'https:')) {
    throw new Error('Application policy requires an HTTPS URL. Public-address and redirect checks still apply on the server.')
  }
}

export function requireImportBatch(count: number, kind: 'jobs' | 'resumes', settings?: PublicSettings | null) {
  const maximum = Math.min(10, settings?.imports[kind].maxBatchItems ?? 10)
  if (!Number.isInteger(count) || count < 1 || count > maximum) throw new Error(`Choose between 1 and ${maximum} inputs per batch. Nothing was truncated.`)
}

export function defaultApplicationPage(settings?: PublicSettings | null): string {
  // Libraries remain usable when admissions are paused: existing evidence must stay reachable.
  return `/${settings?.navigation.defaultPage ?? 'jobs'}`
}

export function boundedPollingInterval(settings: PublicSettings | null | undefined, jobs = false): number {
  const fallback = jobs ? 2000 : 3000
  const value = settings?.ui.polling[jobs ? 'jobsMilliseconds' : 'otherProcessingMilliseconds'] ?? fallback
  return Number.isFinite(value) ? Math.max(1000, Math.min(60_000, value)) : fallback
}

export function clampClientLimits<T extends Record<string, number>>(ceilings: T, limits?: Partial<{ [K in keyof T]: number }>): { [K in keyof T]: number } {
  return Object.fromEntries(Object.entries(ceilings).map(([key, ceiling]) => {
    const value = limits?.[key]
    return [key, typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(ceiling, Math.floor(value)) : ceiling]
  })) as { [K in keyof T]: number }
}

export function jobFeaturesWithPolicy(features: JobProcessingFeatures, settings?: PublicSettings | null): JobProcessingFeatures {
  const limits = clampClientLimits(JOB_IMPORT_LIMITS, features.limits)
  const intake = settings?.imports.jobs
  return { ...features, realJobImports: features.realJobImports && !admissionReason(settings, 'jobImports'),
    rubricAssistant: features.rubricAssistant === true,
    limits: clampClientLimits(JOB_IMPORT_LIMITS, { ...limits, ...(intake ? {
      maxFileBytes: intake.maxFileBytes, maxPdfBytes: intake.maxFileBytes, maxMarkdownBytes: intake.maxFileBytes,
      maxPdfPages: intake.maxPdfPages, maxSourceCharacters: intake.maxSourceCharacters, maxBatchFiles: intake.maxBatchItems,
      maxCriteria: settings.rubrics.jobs.maxCriteria,
    } : {}) }) }
}

export function resumeFeaturesWithPolicy(features: ResumeProcessingFeatures, settings?: PublicSettings | null): ResumeProcessingFeatures {
  const limits = clampClientLimits(RESUME_IMPORT_LIMITS, features.resumeLimits)
  const intake = settings?.imports.resumes
  return { ...features, realResumeImports: features.realResumeImports && !admissionReason(settings, 'resumeImports'),
    resumeLimits: clampClientLimits(RESUME_IMPORT_LIMITS, { ...limits, ...(intake ? {
      maxFileBytes: intake.maxFileBytes, maxPdfBytes: intake.maxFileBytes, maxMarkdownBytes: intake.maxFileBytes,
      maxPdfPages: intake.maxPdfPages, maxSourceCharacters: intake.maxSourceCharacters, maxBatchItems: intake.maxBatchItems,
    } : {}) }) }
}

export function gradeFeaturesWithPolicy(features: GradeProcessingFeatures, settings?: PublicSettings | null): GradeProcessingFeatures {
  const refs = settings?.grades.references
  return { ...features, realGradeLadders: features.realGradeLadders && !admissionReason(settings, 'gradeLadders'),
    gradeLimits: clampClientLimits(GRADE_LADDER_LIMITS, { ...features.gradeLimits, ...(refs ? {
      maxSources: refs.maxSources, maxPdfBytes: refs.maxPdfBytes, maxPdfPages: refs.maxSelectedPages,
      maxTotalPdfPages: refs.maxTotalSelectedPages, maxSourceCharacters: refs.maxSourceCharacters,
      pdfChunkPages: refs.pdfChunkPages, maxReferenceLinks: refs.maxLinks, maxCriteria: settings.grades.maxCriteria,
    } : {}) }) }
}

export function analysisFeaturesWithPolicy(features: AnalysisProcessingFeatures, settings?: PublicSettings | null): AnalysisProcessingFeatures {
  return { ...features, realAnalyses: features.realAnalyses && !admissionReason(settings, 'newAnalyses'),
    analysisSummaryGeneration: features.analysisSummaryGeneration === true && !admissionReason(settings, 'summaryGeneration'),
    analysisEvidenceCorrections: features.analysisEvidenceCorrections === true && !admissionReason(settings),
    analysisLimits: clampClientLimits(ANALYSIS_LIMITS, { ...features.analysisLimits, ...(settings ? { maxComparisons: settings.analyses.maxComparisons } : {}) }) }
}
