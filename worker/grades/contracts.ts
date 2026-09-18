import type {
  GradeCompetency, GradeIssue, GradeLadderRecord, GradeQualification, GradeRubric,
  GradeRubricVersionRecord, GradeSeedSnapshot, GradeSourceSetRecord, ReferenceDocument,
} from '../../src/domain/real-grades'

export interface GradeModelRequest {
  name: string
  schema: Record<string, unknown>
  system: string
  user: string
  maxCompletionTokens?: number
}

export type GradeModelInvoker = (
  request: GradeModelRequest,
  signal?: AbortSignal,
) => Promise<{ content: string; model: string }>

export interface CompetencyModelInput {
  seed: GradeSeedSnapshot
  sourceSet: GradeSourceSetRecord
  documents: ReferenceDocument[]
}

export interface CompetencyModelResult {
  competencies: GradeCompetency[]
  issues: GradeIssue[]
  model: string
  promptVersion: string
}

export interface GradeDraftModelInput {
  ladder: GradeLadderRecord
  sourceSet: GradeSourceSetRecord
  documents: ReferenceDocument[]
  competencies: GradeCompetency[]
  grade: number
  versionId: string
  version: number
  createdAt: string
}

export interface GradeDraftModelResult {
  rubric: GradeRubric
  qualifications: GradeQualification[]
  issues: GradeIssue[]
  model: string
  promptVersion: string
}

export interface GradeReviewModelInput {
  version: GradeRubricVersionRecord
  sourceSet: GradeSourceSetRecord
  documents: ReferenceDocument[]
}

export interface GradeReviewModelResult {
  outcome: 'supported' | 'needs-sources'
  issues: GradeIssue[]
  model: string
  promptVersion: string
}

export type PlanGradeCompetencies = (
  input: CompetencyModelInput, invoke: GradeModelInvoker, signal?: AbortSignal,
) => Promise<CompetencyModelResult>
export type DraftGradeRubric = (
  input: GradeDraftModelInput, invoke: GradeModelInvoker, signal?: AbortSignal,
) => Promise<GradeDraftModelResult>
export type ReviewGradeRubric = (
  input: GradeReviewModelInput, invoke: GradeModelInvoker, signal?: AbortSignal,
) => Promise<GradeReviewModelResult>
