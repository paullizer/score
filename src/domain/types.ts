import type { WorkspaceLifecycle } from './lifecycle'
import type { UploadFormat } from './document-formats'

export type SourceKind = UploadFormat | 'url' | 'website'
export type CriterionKey = 'technical' | 'delivery' | 'analysis' | 'communication' | 'leadership' | 'policy' | 'custom'
export type JobStatus = 'queued' | 'parsing' | 'generating' | 'ready' | 'error' | 'cancelled'

export interface DocumentParagraph {
  id: string
  page: number
  heading: string
  text: string
}

export interface SourceDocument {
  id: string
  title: string
  kind: 'job' | 'resume'
  version: number
  paragraphs: DocumentParagraph[]
  /** Persisted compatibility marker required by server validation and workers; always false. */
  sample: false
}

export interface Criterion {
  id: string
  key: CriterionKey
  label: string
  description: string
  weight: number
  guidance: string
  sourceParagraphId?: string
  requirementType?: 'required' | 'preferred'
  sourceCitations?: Citation[]
}

export interface Rubric {
  id: string
  groupId: string
  kind: 'job' | 'grade'
  jobId?: string
  ladder?: string
  grade?: string
  name: string
  description: string
  version: number
  criteria: Criterion[]
  createdAt: string
  dataKind?: 'real'
  provenance?: { kind: 'generated' | 'edited'; model: string; promptVersion: string; prompt?: PromptExecutionProvenance }
}

export interface Job {
  id: string
  title: string
  displayName?: string
  organization: string
  location: string
  arrangement: string
  employmentType: string
  grade: string
  series: string
  source: SourceKind
  sourceLabel: string
  batchId?: string
  documentId: string
  rubricId: string | null
  rubricDeletedAt?: string
  status: JobStatus
  errorStage?: 'download' | 'parsing' | 'rubric'
  error?: string
  createdAt: string
  dataKind?: 'real'
}

export interface Citation {
  documentId: string
  documentVersion: number
  paragraphId: string
  page: number
  heading: string
  quote: string
}

/** In-memory projection that the real feature bridges fill from server records. */
export interface Workspace {
  lifecycle?: WorkspaceLifecycle
  jobs: Job[]
  documents: SourceDocument[]
  rubrics: Rubric[]
}
import type { PromptExecutionProvenance } from './prompt-versions'
