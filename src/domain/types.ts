import type { WorkspaceLifecycle } from './lifecycle'
import type { UploadFormat } from './document-formats'

export type SourceKind = UploadFormat | 'url' | 'website'
export type CriterionKey = 'technical' | 'delivery' | 'analysis' | 'communication' | 'leadership' | 'policy' | 'custom'
export type JobStatus = 'queued' | 'parsing' | 'generating' | 'ready' | 'error' | 'cancelled'
export type ComparisonStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'

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
  sample: boolean
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
  provenance?: { kind: 'generated' | 'edited'; model: string; promptVersion: string }
}

export interface Job {
  id: string
  title: string
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

export interface Resume {
  id: string
  name: string
  role: string
  location: string
  initials: string
  experience: string
  documentId: string
  sourceLabel: string
  createdAt: string
  sample: true
  evidence: Partial<Record<CriterionKey, { score: number; paragraphId: string }>>
}

export interface Citation {
  documentId: string
  documentVersion: number
  paragraphId: string
  page: number
  heading: string
  quote: string
}

export interface CriterionResult {
  criterionId: string
  score: number | null
  evidenceStatus: 'supported' | 'partial' | 'missing' | 'not-assessed'
  rationale: string
  citations: Citation[]
}

export interface AnalysisTarget {
  id: string
  kind: 'job' | 'grade'
  label: string
  sublabel: string
  rubric: Rubric
  job?: Job
  document?: SourceDocument
}

export interface ResumeSnapshot {
  resume: Resume
  document: SourceDocument
}

export interface Comparison {
  id: string
  resumeId: string
  targetId: string
  status: ComparisonStatus
  score: number | null
  criteria: CriterionResult[]
  summary: string
  error?: string
}

export interface AnalysisRun {
  id: string
  name: string
  createdAt: string
  targets: AnalysisTarget[]
  resumes: ResumeSnapshot[]
  comparisons: Comparison[]
}

export interface Workspace {
  schemaVersion: 1
  lifecycle?: WorkspaceLifecycle
  jobs: Job[]
  resumes: Resume[]
  documents: SourceDocument[]
  rubrics: Rubric[]
  runs: AnalysisRun[]
}

export interface ImportCandidate {
  key: string
  label: string
  title: string
  fixtureIndex: number
}
