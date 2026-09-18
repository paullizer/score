import { createContext, useContext } from 'react'
import type {
  AddGradeSourceUrlInput, ApproveGradeInput, ConfirmGradeSourcesInput, EditGradeDraftInput,
  GradeActionInput, GradeLadderDetail, GradeLadderSummary, GradeProcessingFeatures, GradeRubricVersionRecord,
  GradeSourceSetRecord, ReferenceDocument, UpdateGradeLadderInput, UpdateGradeSourceInput,
} from '../domain/real-grades'
import type { GradeLadderCreationRequest } from '../services/gradeLadders'

export type GradeLoadState<T> =
  | { state: 'idle' | 'loading' }
  | { state: 'ready'; value: T; error?: string }
  | { state: 'error'; error: string }

export interface GradeLaddersContextValue {
  workspaceId: string
  canWrite: boolean
  phase: 'loading' | 'ready' | 'unavailable' | 'error'
  features: GradeProcessingFeatures | null
  error: string | null
  summaries: GradeLadderSummary[]
  mutationPending: boolean
  detail: (id: string) => GradeLoadState<GradeLadderDetail>
  ensureDetail: (id: string, force?: boolean) => Promise<void>
  refresh: () => Promise<void>
  create: (input: GradeLadderCreationRequest, key: string) => Promise<GradeLadderDetail>
  update: (id: string, input: UpdateGradeLadderInput, etag: string) => Promise<GradeLadderDetail>
  discover: (id: string, etag: string, key: string) => Promise<GradeLadderDetail>
  uploadPdf: (id: string, file: File, key: string, pages?: number[]) => Promise<GradeLadderDetail>
  addUrl: (id: string, input: AddGradeSourceUrlInput, key: string) => Promise<GradeLadderDetail>
  updateSource: (id: string, sourceId: string, input: UpdateGradeSourceInput, etag: string) => Promise<GradeLadderDetail>
  confirmSources: (id: string, input: ConfirmGradeSourcesInput, etag: string, key: string) => Promise<GradeLadderDetail>
  generate: (id: string, etag: string, key: string) => Promise<GradeLadderDetail>
  retry: (id: string, input: GradeActionInput, etag: string) => Promise<GradeLadderDetail>
  cancel: (id: string, input: GradeActionInput, etag: string) => Promise<GradeLadderDetail>
  saveDraft: (id: string, grade: number, input: EditGradeDraftInput, headEtag: string) => Promise<GradeLadderDetail>
  approve: (id: string, grade: number, input: ApproveGradeInput, headEtag: string) => Promise<GradeLadderDetail>
  versions: (id: string, grade: number, signal?: AbortSignal) => Promise<GradeRubricVersionRecord[]>
  sourceSet: (id: string, sourceSetId: string, signal?: AbortSignal) => Promise<GradeSourceSetRecord>
  document: (id: string, sourceId: string, sourceSetId?: string, signal?: AbortSignal) => Promise<ReferenceDocument>
  originalUrl: (id: string, sourceId: string, sourceSetId?: string) => string
  locateRubric: (rubricId: string) => GradeRubricVersionRecord | undefined
}

export const GradeLaddersContext = createContext<GradeLaddersContextValue | null>(null)

export function useGradeLadders(): GradeLaddersContextValue | null {
  return useContext(GradeLaddersContext)
}
