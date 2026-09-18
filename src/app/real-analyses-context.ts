import { createContext, useContext } from 'react'
import type {
  AnalysisProcessingFeatures, CreateRealAnalysisInput, RealAnalysisComparisonDetail, RealAnalysisComparisonSummary,
  RealAnalysisDocumentResponse, RealAnalysisRunDetail, RealAnalysisRunSummary, RealAnalysisTargetSummary, RetryRealAnalysisInput,
} from '../domain/real-analyses'
import type { RealLoadState } from './real-request-scope'

export interface RealAnalysesContextValue {
  workspaceId: string
  canWrite: boolean
  // Historical access comes from the owned analysis API, not the new-run feature flag.
  phase: 'loading' | 'ready' | 'unavailable' | 'error'
  features: AnalysisProcessingFeatures | null
  error: string | null
  creationError: string | null
  summaries: RealAnalysisRunSummary[]
  targets: RealLoadState<RealAnalysisTargetSummary[]>
  refresh: () => Promise<void>
  refreshTargets: () => Promise<void>
  detail: (id: string) => RealLoadState<RealAnalysisRunDetail>
  ensureDetail: (id: string, force?: boolean) => Promise<void>
  comparisons: (id: string) => RealLoadState<RealAnalysisComparisonSummary[]>
  ensureComparisons: (id: string, force?: boolean) => Promise<void>
  comparison: (runId: string, comparisonId: string) => RealLoadState<RealAnalysisComparisonDetail>
  ensureComparison: (runId: string, comparisonId: string, force?: boolean) => Promise<void>
  document: (runId: string, comparisonId: string, documentId: string, version: number, signal?: AbortSignal) => Promise<RealAnalysisDocumentResponse['document']>
  pending: (runId?: string) => boolean
  requestKey: (input: CreateRealAnalysisInput) => string
  create: (input: CreateRealAnalysisInput, key: string) => Promise<RealAnalysisRunSummary>
  retry: (id: string, input: RetryRealAnalysisInput, etag: string) => Promise<RealAnalysisRunSummary>
  cancel: (id: string, etag: string) => Promise<RealAnalysisRunSummary>
  retryComparison: (runId: string, comparisonId: string, etag: string) => Promise<RealAnalysisComparisonSummary>
  cancelComparison: (runId: string, comparisonId: string, etag: string) => Promise<RealAnalysisComparisonSummary>
}

export const RealAnalysesContext = createContext<RealAnalysesContextValue | null>(null)
export function useRealAnalyses() { return useContext(RealAnalysesContext) }
