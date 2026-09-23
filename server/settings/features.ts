import { projectPublicSettings, runtimeSettingsReadiness } from '../../src/domain/admin-settings'
import type { ProcessingSettingsSnapshot, PublicFeaturesResponse, SettingsDeploymentCapabilities } from '../../src/domain/admin-settings'
import { JOB_IMPORT_LIMITS } from '../../src/domain/real-jobs'
import { RESUME_IMPORT_LIMITS } from '../../src/domain/real-resumes'
import { GRADE_LADDER_LIMITS } from '../../src/domain/real-grades'
import { ANALYSIS_LIMITS } from '../../src/domain/real-analyses'

export type { SettingsDeploymentCapabilities } from '../../src/domain/admin-settings'

export function effectiveFeatures(
  capabilities: SettingsDeploymentCapabilities, snapshot: ProcessingSettingsSnapshot, runtimeEnabled: boolean,
  settingsConfigured = runtimeEnabled,
): PublicFeaturesResponse {
  const settings = snapshot.settings
  const runtimeReadiness = runtimeSettingsReadiness(runtimeEnabled, settingsConfigured)
  const admitting = runtimeReadiness.newProcessingAllowed && !settings.maintenance.pauseNewWork
  const jobPolicy = settings.imports.jobs
  const resumePolicy = settings.imports.resumes
  const canUseFormat = (format: string) => (format !== 'doc' && format !== 'docx') || capabilities.wordDocumentImports
  const realJobImports = capabilities.realJobImports && admitting && settings.features.jobImports &&
    (jobPolicy.allowUrls || jobPolicy.allowedFormats.some(canUseFormat))
  const realResumeImports = capabilities.realResumeImports && admitting && settings.features.resumeImports &&
    (resumePolicy.allowUrls || resumePolicy.allowedFormats.some(canUseFormat))
  const realGradeLadders = capabilities.realGradeLadders && admitting && settings.features.gradeLadders
  const realAnalyses = capabilities.realAnalyses && admitting && settings.features.newAnalyses
  const analysisSummaryGeneration = capabilities.analysisSummaryGeneration && admitting && settings.features.summaryGeneration
  const reference = settings.grades.references
  const publicSettings = projectPublicSettings(snapshot, runtimeEnabled, settingsConfigured)
  publicSettings.features = {
    ...publicSettings.features, jobImports: realJobImports, resumeImports: realResumeImports,
    gradeLadders: realGradeLadders, newAnalyses: realAnalyses, summaryGeneration: analysisSummaryGeneration,
  }
  for (const [kind, available] of [['jobs', realJobImports], ['resumes', realResumeImports]] as const) {
    publicSettings.imports[kind].allowedFormats = available
      ? publicSettings.imports[kind].allowedFormats.filter(canUseFormat)
      : []
    publicSettings.imports[kind].allowUrls &&= available
  }
  return {
    realJobImports, markdownJobImports: realJobImports && jobPolicy.allowedFormats.includes('markdown'),
    realGradeLadders,
    realResumeImports, markdownResumeImports: realResumeImports && resumePolicy.allowedFormats.includes('markdown'),
    realAnalyses,
    analysisSummaryGeneration,
    analysisEvidenceCorrections: capabilities.analysisEvidenceCorrections === true && admitting,
    rubricAssistant: capabilities.rubricAssistant === true && admitting,
    wordDocumentImports: capabilities.wordDocumentImports && (
      (realJobImports && jobPolicy.allowedFormats.some(format => format === 'doc' || format === 'docx')) ||
      (realResumeImports && resumePolicy.allowedFormats.some(format => format === 'doc' || format === 'docx'))
    ),
    limits: {
      ...JOB_IMPORT_LIMITS, maxFileBytes: jobPolicy.maxFileBytes, maxPdfBytes: jobPolicy.maxFileBytes, maxMarkdownBytes: jobPolicy.maxFileBytes,
      maxPdfPages: jobPolicy.maxPdfPages, maxSourceCharacters: jobPolicy.maxSourceCharacters,
      maxBatchFiles: jobPolicy.maxBatchItems, maxCriteria: settings.rubrics.jobs.maxCriteria,
    },
    resumeLimits: {
      ...RESUME_IMPORT_LIMITS, maxFileBytes: resumePolicy.maxFileBytes, maxPdfBytes: resumePolicy.maxFileBytes, maxMarkdownBytes: resumePolicy.maxFileBytes,
      maxPdfPages: resumePolicy.maxPdfPages, maxSourceCharacters: resumePolicy.maxSourceCharacters,
      maxBatchItems: resumePolicy.maxBatchItems, maxAutomaticAttempts: settings.processing.resumes.maxAutomaticAttempts,
    },
    gradeLimits: {
      ...GRADE_LADDER_LIMITS, maxSources: reference.maxSources, maxPdfBytes: reference.maxPdfBytes,
      maxPdfPages: reference.maxSelectedPages, maxTotalPdfPages: reference.maxTotalSelectedPages,
      pdfChunkPages: reference.pdfChunkPages, maxSourceCharacters: reference.maxSourceCharacters,
      maxModelCharacters: Math.min(...(['gradeCompetencies', 'gradeDraft', 'gradeReview'] as const).map(task => settings.ai.tasks[task].inputBudget.maxInput)),
      maxCriteria: settings.grades.maxCriteria, maxDiscoveryHops: settings.grades.discovery.maxHops, maxReferenceLinks: reference.maxLinks,
    },
    analysisLimits: { ...ANALYSIS_LIMITS, maxComparisons: settings.analyses.maxComparisons, maxOutputCorrections: settings.analyses.maxOutputCorrections },
    settingsRevision: snapshot.revision, runtimeSettingsEnabled: runtimeEnabled,
    runtimeReadiness,
    publicSettings,
    // Keep historical reader/service readiness distinct from new-operation admission.
    deploymentCapabilities: { ...capabilities },
  }
}
