import { createContext, useContext } from 'react'
import type { RealResumeDetail, RealResumeSummary, ResumeProcessingFeatures } from '../domain/real-resumes'
import type { RealResumeImportBatch, RealResumeImportSource } from '../features/resumes/resumeImportUi'
import type { RealLoadState } from './real-request-scope'

export interface RealResumesContextValue {
  workspaceId: string
  canWrite: boolean
  phase: 'loading' | 'ready' | 'unavailable' | 'error'
  features: ResumeProcessingFeatures | null
  error: string | null
  summaries: RealResumeSummary[]
  refresh: () => Promise<void>
  detail: (id: string) => RealLoadState<RealResumeDetail>
  ensureDetail: (id: string, force?: boolean) => Promise<void>
  pending: (id: string) => boolean
  retry: (id: string, etag: string) => Promise<RealResumeSummary>
  cancel: (id: string, etag: string) => Promise<RealResumeSummary>
  originalUrl: (id: string) => string
  batches: RealResumeImportBatch[]
  currentBatchId: string | null
  newBatch: () => string
  selectBatch: (id: string) => void
  stage: (inputs: RealResumeImportSource[]) => void
  removeItem: (key: string) => void
  submitBatch: (batchId: string, keys?: string[]) => Promise<void>
}

export const RealResumesContext = createContext<RealResumesContextValue | null>(null)
export function useRealResumes() { return useContext(RealResumesContext) }
