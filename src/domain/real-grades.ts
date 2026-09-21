import type { Citation, Criterion, DocumentParagraph, Job, Rubric, SourceDocument } from './types'
import type { RealJobSource } from './real-jobs'
import type { LifecycleMetadata, LifecycleOperation } from './lifecycle'
import type { OriginalContentType } from './document-formats'
import type { ProcessingSettingsSnapshot } from './admin-settings'

export const GRADE_LADDER_LIMITS = {
  maxSources: 15,
  maxPdfBytes: 20 * 1024 * 1024,
  maxPdfPages: 250,
  maxTotalPdfPages: 500,
  pdfChunkPages: 50,
  maxSourceCharacters: 2_000_000,
  maxModelCharacters: 180_000,
  maxUrlLength: 4096,
  maxCriteria: 20,
  maxDiscoveryHops: 2,
  maxReferenceLinks: 2_000,
  maxGrades: 15,
} as const

export type GradeSupervision = 'nonsupervisory' | 'supervisor' | 'leader' | 'unknown'
export type GradeFunction = 'research' | 'development' | 'test-evaluation'
export type GradeAgencyType = 'dod' | 'other-federal' | 'non-federal' | 'unknown'

export interface GradeContext {
  series: string
  agency: string
  agencyType: GradeAgencyType
  supervision: GradeSupervision
  functions: GradeFunction[]
  specialty: string
  confirmed: boolean
  answers: Record<string, string>
}

export interface GradeIssue {
  id: string
  code: string
  severity: 'blocker' | 'warning'
  scope: 'context' | 'source' | 'grade' | 'criterion' | 'qualification'
  message: string
  sourceId?: string
  grade?: number
  criterionId?: string
  citations?: Citation[]
}

export interface GradeProcessingError {
  code: string
  message: string
  retryable: boolean
}

export interface ReferenceIssueResolution {
  issue: GradeIssue
  reason: 'complete-source-extraction' | 'captured-named-section' | 'captured-reference-target'
  evidence: {
    sourceId: string
    documentId: string
    documentVersion: number
    sha256: string
    targetUrl?: string
    intendedSection?: string
  }
}

export interface GradeEntityBase {
  id: string
  workspaceId: string
  createdAt: string
  updatedAt: string
  processingSettings?: ProcessingSettingsSnapshot
}

export type LadderStatus = 'draft' | 'discovering' | 'sources-ready' | 'generating' | 'review' | 'incomplete' | 'approved' | 'error' | 'cancelled'
export type GradeLevelStatus = 'draft' | 'queued' | 'processing' | 'needs-sources' | 'ready-for-review' | 'approved' | 'error' | 'cancelled'

export interface GradeLadderRecord extends GradeEntityBase {
  recordType: 'grade-ladder'
  lifecycle?: LifecycleMetadata
  name: string
  context: GradeContext
  grades: number[]
  seedJobId: string
  seedRubricId: string
  seedRubricVersion: number
  seedJobTitle: string
  seedBlobName: string
  sourceIds: string[]
  sourceRevision: number
  sourceSetId?: string
  generationId?: string
  discovery?: {
    seriesTitle?: string
    seriesStatus: OpmDiscoveryResult['seriesStatus']
    catalogVersion: string
    capturedAt: string
    artifactBlobName: string
  }
  status: LadderStatus
  issues: GradeIssue[]
  createdBy: string
  inputFingerprint: string
}

export interface GradeSeedSnapshot {
  job: Job & { dataKind: 'real' }
  rubric: Rubric
  document: SourceDocument
  source: RealJobSource
  capturedAt: string
}

export type ReferencePurpose = 'grading' | 'classification' | 'qualification' | 'agency' | 'job-context' | 'background' | 'issuance'
export type ReferenceOrigin = 'opm' | 'upload' | 'url' | 'seed-job'
export type ReferenceRelation = 'grading' | 'qualification' | 'exclusion' | 'supersession' | 'background'

export interface ReferenceLink {
  url: string
  label: string
  relation: ReferenceRelation
  page?: number
}

export interface ReferenceCoverage {
  series: string[]
  grades: number[]
  functions: string[]
  state: 'confirmed' | 'conditional' | 'unknown' | 'conflicting'
  explanation: string
}

export interface OpmSourceCandidate {
  url: string
  title: string
  purpose: ReferencePurpose
  intendedSection?: string
  publisher: string
  coverage: ReferenceCoverage
  discoveryPath: string[]
  revision?: string
  authorityStatus: 'current' | 'superseded' | 'unknown' | 'conflicting'
  relatedLinks: ReferenceLink[]
  issues: GradeIssue[]
}

export interface OpmDiscoveryResult {
  series: string
  seriesTitle?: string
  seriesStatus: 'listed' | 'retired' | 'unknown' | 'conflicting'
  catalogVersion: string
  candidates: OpmSourceCandidate[]
  issues: GradeIssue[]
}

export interface ReferenceSourceRecord extends GradeEntityBase {
  recordType: 'grade-source'
  ladderId: string
  origin: ReferenceOrigin
  purpose: ReferencePurpose
  title: string
  publisher: string
  requestedUrl?: string
  finalUrl?: string
  intendedSection?: string
  redirects: string[]
  discoveryPath: string[]
  coverage: ReferenceCoverage
  revision?: string
  authorityStatus: 'current' | 'superseded' | 'unknown' | 'conflicting' | 'supplied'
  relatedLinks: ReferenceLink[]
  status: 'queued' | 'extracting' | 'ready' | 'error' | 'cancelled'
  documentId: string
  documentVersion: number
  originalBlobName?: string
  originalContentType?: OriginalContentType
  documentBlobName?: string
  sha256?: string
  bytes?: number
  capturedAt?: string
  extractionMethod?: 'document-intelligence' | 'html' | 'browser' | 'seed-snapshot'
  extractionVersion?: string
  completeness: 'pending' | 'complete' | 'selected-pages' | 'incomplete'
  pageCount?: number
  selectedPages: number[]
  issues: GradeIssue[]
  error?: GradeProcessingError
  inputFingerprint: string
  issueResolutions?: ReferenceIssueResolution[]
}

export interface ReferenceParagraph extends DocumentParagraph {
  sectionId?: string
  table?: { headers: string[]; row: number }
}

export interface ReferenceDocument {
  id: string
  version: number
  kind: 'reference'
  title: string
  sample: false
  paragraphs: ReferenceParagraph[]
  pageCount: number
  selectedPages: number[]
  completeness: 'complete' | 'selected-pages' | 'incomplete'
}

export interface SourceDecision {
  sourceId: string
  selected: boolean
  applicability: 'applicable' | 'background' | 'excluded' | 'uncertain'
  reason: string
}

export interface FrozenReferenceSource {
  sourceId: string
  title: string
  origin: ReferenceOrigin
  purpose: ReferencePurpose
  publisher: string
  documentId: string
  documentVersion: number
  documentBlobName: string
  originalBlobName: string
  originalContentType?: OriginalContentType
  sha256: string
  url?: string
  intendedSection?: string
  revision?: string
  authorityStatus: ReferenceSourceRecord['authorityStatus']
  coverage: ReferenceCoverage
  pageCount: number
  selectedPages: number[]
  completeness: ReferenceDocument['completeness']
  issues: GradeIssue[]
  issueResolutions?: ReferenceIssueResolution[]
  processingSettingsRevision?: string
  // Retained for previously frozen references; new references store revision-only provenance.
  processingSettings?: ProcessingSettingsSnapshot
}

export interface GradeSourceSetRecord extends GradeEntityBase {
  recordType: 'grade-source-set'
  ladderId: string
  revision: number
  context: GradeContext
  grades: number[]
  seedBlobName: string
  sources: FrozenReferenceSource[]
  decisions: SourceDecision[]
  issues: GradeIssue[]
  contentHash: string
  confirmedBy: string
}

export interface GradeCompetency {
  id: string
  label: string
  description: string
  seedCriterionIds: string[]
  citations: Citation[]
}

export interface GradeCompetencyPlanRecord extends GradeEntityBase {
  recordType: 'grade-competency-plan'
  ladderId: string
  generationId: string
  sourceSetId: string
  competencies: GradeCompetency[]
  issues: GradeIssue[]
  model: string
  promptVersion: string
}

export interface GradeCriterion extends Criterion {
  competencyId: string
  support: 'direct' | 'derived' | 'gap' | 'not-applicable'
  gradeBasis: Citation[]
  interpretation: string
}

export interface GradeRubric extends Rubric {
  kind: 'grade'
  dataKind: 'real'
  ladder: string
  grade: string
  criteria: GradeCriterion[]
}

export interface GradeQualification {
  id: string
  text: string
  citations: Citation[]
  interpretation: string
  support: 'direct' | 'derived' | 'gap'
}

export interface GradeRubricVersionRecord extends GradeEntityBase {
  recordType: 'grade-version'
  ladderId: string
  grade: number
  version: number
  generationId: string
  sourceSetId: string
  rubric: GradeRubric
  qualifications: GradeQualification[]
  issues: GradeIssue[]
  createdBy: string
  contentHash: string
}

export interface GradeReviewRecord extends GradeEntityBase {
  recordType: 'grade-review'
  ladderId: string
  grade: number
  versionId: string
  versionHash: string
  sourceSetId: string
  outcome: 'supported' | 'needs-sources'
  issues: GradeIssue[]
  model: string
  promptVersion: string
}

export interface GradeApprovalRecord extends GradeEntityBase {
  recordType: 'grade-approval'
  ladderId: string
  grade: number
  versionId: string
  versionHash: string
  reviewId: string
  sourceSetId: string
  approvedBy: string
}

export interface GradeHeadRecord extends GradeEntityBase {
  recordType: 'grade-head'
  lifecycle?: LifecycleMetadata
  ladderId: string
  grade: number
  status: GradeLevelStatus
  generationId?: string
  sourceSetId?: string
  latestVersionId?: string
  latestReviewId?: string
  approvedVersionId?: string
  approvalId?: string
  issues: GradeIssue[]
  error?: GradeProcessingError
}

export type GradeWorkInput =
  | { kind: 'discover' }
  | { kind: 'extract-source'; sourceId: string; documentVersion?: number }
  | { kind: 'plan-competencies'; sourceSetId: string; generationId: string }
  | { kind: 'generate-grade'; sourceSetId: string; generationId: string; competencyPlanId: string; grade: number }
  | { kind: 'review-grade'; sourceSetId: string; generationId: string; versionId: string; grade: number }

export interface GradeWorkRecord extends GradeEntityBase {
  recordType: 'grade-work'
  ladderId: string
  input: GradeWorkInput
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  attempts: number
  requestFingerprint?: string
  nextAttemptAt?: string
  lease?: { owner: string; expiresAt: string }
  error?: GradeProcessingError
}

export type GradeEntity = GradeLadderRecord | ReferenceSourceRecord | GradeSourceSetRecord |
  GradeCompetencyPlanRecord | GradeRubricVersionRecord | GradeReviewRecord |
  GradeApprovalRecord | GradeHeadRecord | GradeWorkRecord

export interface VersionedGradeEntity<T extends GradeEntity = GradeEntity> {
  record: T
  etag: string
}

export interface GradeLevelSummary {
  head: GradeHeadRecord
  etag: string
}

export interface GradeLevelDetail extends GradeLevelSummary {
  version: GradeRubricVersionRecord | null
  review: GradeReviewRecord | null
  approval: GradeApprovalRecord | null
}

export interface GradeLadderSummary {
  ladder: GradeLadderRecord
  etag: string
  levels: GradeLevelSummary[]
  pending?: true
  operation?: LifecycleOperation
}

export interface GradeLadderDetail extends GradeLadderSummary {
  levels: GradeLevelDetail[]
  sources: ReferenceSourceRecord[]
  sourceSet: GradeSourceSetRecord | null
  workItems: GradeWorkRecord[]
}

export interface GradeLaddersPage {
  ladders: GradeLadderSummary[]
  continuationToken?: string
}

export interface GradeProcessingFeatures {
  realGradeLadders: boolean
  gradeLimits: { [K in keyof typeof GRADE_LADDER_LIMITS]: number }
}

export interface CreateGradeLadderInput {
  name: string
  jobId: string
  rubricId: string
  rubricVersion: number
  context: GradeContext
  grades: number[]
}

export interface EditGradeDraftInput {
  rubric: GradeRubric
  qualifications: GradeQualification[]
}

export interface UpdateGradeLadderInput {
  name?: string
  context?: GradeContext
  grades?: number[]
}

export interface ConfirmGradeSourcesInput {
  decisions: SourceDecision[]
}

export interface AddGradeSourceUrlInput {
  url: string
  selectedPages?: number[]
}

export interface UpdateGradeSourceInput {
  selectedPages: number[]
}

export interface GradeActionInput {
  workId?: string
  grade?: number
}

export interface ApproveGradeInput {
  versionId: string
  reviewId: string
}

export interface GradeMutationResponse {
  ladder: GradeLadderDetail
}

export interface GradeVersionsPage {
  versions: GradeRubricVersionRecord[]
  continuationToken?: string
}

export function gradeLabel(grade: number): string {
  return `GS-${grade}`
}

export function gradeHeadId(ladderId: string, grade: number): string {
  return `grade-head-${ladderId.replace(/^ladder-/, '')}-${grade}`
}

export function gradeRecordIs<K extends GradeEntity['recordType']>(
  value: GradeEntity,
  recordType: K,
): value is Extract<GradeEntity, { recordType: K }> {
  return value.recordType === recordType
}
