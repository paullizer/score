import { createContext, useContext } from 'react'
import type {
  AnalysisProcessingFeatures, CreateRealAnalysisInput, RealAnalysisComparisonDetail, RealAnalysisComparisonSummary,
  RealAnalysisDocumentResponse, RealAnalysisRunDetail, RealAnalysisRunSummary, RealAnalysisTargetSummary, RetryRealAnalysisInput,
} from '../domain/real-analyses'
import type { RealAnalysisDiagnosticsPage } from '../domain/analysis-diagnostics'
import type { RealLoadState } from './real-request-scope'
import type {
  GenerateRealAnalysisSummariesInput, RealAnalysisSummariesMutationResponse, RealAnalysisSummariesResponse,
  RealAnalysisSummaryStatusResponse, RealAnalysisSummarySubjectResponse,
} from '../domain/analysis-narratives'
import type {
  AnalysisSummaryHistoryPage, AnalysisSummarySubject, PublishSummaryDraftInput,
} from '../domain/analysis-summary-history'

export interface RealAnalysesContextValue {
  workspaceId: string
  canWrite: boolean
  canReviewSummaries: boolean
  // Historical access comes from the owned analysis API, not the new-run feature flag.
  phase: 'loading' | 'ready' | 'unavailable' | 'error'
  features: AnalysisProcessingFeatures | null
  error: string | null
  creationError: string | null
  summaries: RealAnalysisRunSummary[]
  targets: RealLoadState<RealAnalysisTargetSummary[]>
  refresh: () => Promise<void>
  refreshTargets: () => Promise<void>
  subscribeTargets: () => () => void
  detail: (id: string) => RealLoadState<RealAnalysisRunDetail>
  ensureDetail: (id: string, force?: boolean) => Promise<void>
  comparisons: (id: string) => RealLoadState<RealAnalysisComparisonSummary[]>
  ensureComparisons: (id: string, force?: boolean) => Promise<void>
  comparison: (runId: string, comparisonId: string) => RealLoadState<RealAnalysisComparisonDetail>
  ensureComparison: (runId: string, comparisonId: string, force?: boolean) => Promise<void>
  subscribeAnalysis: (runId: string) => () => void
  subscribeComparison: (runId: string, comparisonId: string) => () => void
  narratives: (runId: string, targetId?: string) => RealLoadState<RealAnalysisSummariesResponse>
  ensureNarratives: (runId: string, targetId?: string, force?: boolean) => Promise<void>
  subscribeNarratives: (runId: string, targetId?: string) => () => void
  summarySubject: (runId: string, subject: AnalysisSummarySubject) => RealLoadState<RealAnalysisSummarySubjectResponse>
  ensureSummarySubject: (runId: string, subject: AnalysisSummarySubject, force?: boolean) => Promise<void>
  subscribeSummarySubject: (runId: string, subject: AnalysisSummarySubject) => () => void
  // Metadata-only summary progress. The history list reads counts; a subscribed analysis page also reads each comparison's state.
  summaryStatus: (runId: string) => RealLoadState<RealAnalysisSummaryStatusResponse>
  ensureSummaryStatus: (runId: string, force?: boolean) => Promise<void>
  subscribeSummaryStatus: (runId: string) => () => void
  generateSummaries: (runId: string, input: GenerateRealAnalysisSummariesInput, etag: string) => Promise<RealAnalysisSummariesMutationResponse>
  summaryHistory: (runId: string, subject: AnalysisSummarySubject, cursor?: string, signal?: AbortSignal) => Promise<AnalysisSummaryHistoryPage>
  publishSummaryDraft: (runId: string, subject: AnalysisSummarySubject, input: PublishSummaryDraftInput, etag: string) => Promise<RealAnalysisSummariesResponse>
  retrySummary: (runId: string, subject: AnalysisSummarySubject, etag: string) => Promise<RealAnalysisSummariesResponse>
  restartSummary: (runId: string, subject: AnalysisSummarySubject, etag: string) => Promise<RealAnalysisSummariesResponse>
  document: (runId: string, comparisonId: string, documentId: string, version: number, signal?: AbortSignal) => Promise<RealAnalysisDocumentResponse['document']>
  diagnostics: (runId: string, comparisonId: string, continuationToken?: string, signal?: AbortSignal) => Promise<RealAnalysisDiagnosticsPage>
  pending: (runId?: string) => boolean
  requestKey: (input: CreateRealAnalysisInput) => string
  create: (input: CreateRealAnalysisInput, key: string) => Promise<RealAnalysisRunSummary>
  hasRetainedCreation: (input: CreateRealAnalysisInput, key: string) => boolean
  recoverCreation: (input: CreateRealAnalysisInput, key: string) => Promise<RealAnalysisRunSummary>
  retry: (id: string, input: RetryRealAnalysisInput, etag: string) => Promise<RealAnalysisRunSummary>
  cancel: (id: string, etag: string) => Promise<RealAnalysisRunSummary>
  retryComparison: (runId: string, comparisonId: string, etag: string) => Promise<RealAnalysisComparisonSummary>
  cancelComparison: (runId: string, comparisonId: string, etag: string) => Promise<RealAnalysisComparisonSummary>
}

export const RealAnalysesContext = createContext<RealAnalysesContextValue | null>(null)
export function useRealAnalyses() { return useContext(RealAnalysesContext) }
