import { createHash } from 'node:crypto'
import {
  GRADE_LADDER_LIMITS,
  type FrozenReferenceSource,
  type GradeIssue,
  type GradeSourceSetRecord,
  type ReferenceDocument,
  type ReferenceParagraph,
  type SourceDecision,
} from '../../src/domain/real-grades'
import type { Citation } from '../../src/domain/types'
import type { GradeModelRequest } from './contracts'
import { GradeModelError } from './model-errors'

export const REPAIR_CONTEXT_RESERVE = 16_384

interface Binding {
  source: FrozenReferenceSource
  decision: SourceDecision | undefined
  selected: boolean
  applicable: boolean
  document: ReferenceDocument | undefined
}

export interface ModelEvidence {
  sourceSet: GradeSourceSetRecord
  bindings: Map<string, Binding>
  issues: GradeIssue[]
  grade: number | undefined
}

export function issue(
  code: string,
  message: string,
  fields: Partial<Omit<GradeIssue, 'id' | 'code' | 'message'>> = {},
): GradeIssue {
  const value = { code, severity: 'blocker' as const, scope: 'source' as const, message, ...fields }
  const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)
  return { id: `grade-model-${hash}`, ...value }
}

export function issuesForGrade(issues: readonly GradeIssue[], grade?: number): GradeIssue[] {
  return issues.filter(value => grade === undefined || value.grade === undefined || value.grade === grade)
}

export function mergeIssues(...groups: readonly GradeIssue[][]): GradeIssue[] {
  const unique = new Map<string, GradeIssue>()
  for (const value of groups.flat()) unique.set(JSON.stringify(value), value)
  return [...unique.values()]
}

function failIntegrity(message: string): never {
  throw new GradeModelError('source-integrity', message)
}

function selectedGrades(source: FrozenReferenceSource, evidence: Pick<ModelEvidence, 'sourceSet' | 'grade'>): number[] {
  const grades = evidence.grade === undefined ? evidence.sourceSet.grades : [evidence.grade]
  return grades.filter(grade => source.coverage.grades.length === 0 || source.coverage.grades.includes(grade))
}

function sourceIssues(
  evidence: Pick<ModelEvidence, 'sourceSet' | 'grade'>,
  source: FrozenReferenceSource,
  code: string,
  message: string,
  severity: GradeIssue['severity'] = 'blocker',
): GradeIssue[] {
  const fields = { sourceId: source.sourceId, severity }
  if (evidence.grade === undefined && source.coverage.grades.length === 0) return [issue(code, message, fields)]
  return selectedGrades(source, evidence).map(grade => issue(code, message, { ...fields, grade }))
}

function functionMatches(source: FrozenReferenceSource, sourceSet: GradeSourceSetRecord): boolean {
  if (source.coverage.functions.length === 0) return true
  const { functions, supervision } = sourceSet.context
  const confirmed = new Set<string>(functions)
  if (supervision !== 'unknown') confirmed.add(supervision)
  const aliases: Record<string, string> = { supervisory: 'supervisor', leadership: 'leader', 'non-supervisory': 'nonsupervisory' }
  return source.coverage.functions.some(value => confirmed.has(aliases[value] ?? value))
}

function coverageMatches(source: FrozenReferenceSource, sourceSet: GradeSourceSetRecord, grade?: number): boolean {
  return source.coverage.state === 'confirmed' &&
    (source.coverage.series.length === 0 || source.coverage.series.includes(sourceSet.context.series)) &&
    (grade === undefined || source.coverage.grades.length === 0 || source.coverage.grades.includes(grade)) &&
    functionMatches(source, sourceSet)
}

function currentAuthority(source: FrozenReferenceSource): boolean {
  return (source.origin !== 'seed-job' && source.authorityStatus === 'current') ||
    (source.purpose === 'agency' && source.origin !== 'seed-job' &&
      (source.authorityStatus === 'supplied' || source.authorityStatus === 'current'))
}

function gradingBinding(binding: Binding, sourceSet: GradeSourceSetRecord, grade?: number): boolean {
  return binding.selected && binding.applicable && binding.document !== undefined &&
    sourceSet.context.confirmed && binding.source.completeness !== 'incomplete' &&
    ['grading', 'classification', 'agency'].includes(binding.source.purpose) &&
    currentAuthority(binding.source) && coverageMatches(binding.source, sourceSet, grade)
}

export function isGradeEvidence(citation: Citation, evidence: ModelEvidence, grade: number): boolean {
  const binding = evidence.bindings.get(citation.documentId)
  return binding !== undefined && gradingBinding(binding, evidence.sourceSet, grade) &&
    citationGradeMatches(citation, { ...evidence, grade })
}

export function gradingDocumentIds(evidence: ModelEvidence): string[] {
  return [...evidence.bindings.values()].filter(binding => gradingBinding(binding, evidence.sourceSet, evidence.grade))
    .map(binding => binding.source.documentId)
}

export function citationParagraph(citation: Citation, evidence: ModelEvidence): ReferenceParagraph | undefined {
  return evidence.bindings.get(citation.documentId)?.document?.paragraphs.find(value => value.id === citation.paragraphId)
}

function tableGradeHeading(paragraph: ReferenceParagraph): string {
  if (!paragraph.table) return ''
  const firstCell = paragraph.text.split(/[\n|]/)[0].trim()
  const label = /^(?:Grade(?: level)?\s*[:=]?\s*)?(GS[-\s]*\d{1,2}(?:\s*(?:through|to|[-\u2013])\s*(?:GS[-\s]*)?\d{1,2})?\+?)$/i.exec(firstCell)
  if (label) return label[1]
  const number = /^(?:Grade\s*[:=]?\s*)?(\d{1,2})$/.exec(firstCell)
  return number ? `GS-${number[1]}` : ''
}

function paragraphGradeMatches(paragraph: ReferenceParagraph, source: FrozenReferenceSource, evidence: ModelEvidence): boolean {
  return !otherGrade(paragraph.heading, source, evidence) &&
    !otherGrade(tableGradeHeading(paragraph), source, evidence)
}

function citationGradeMatches(citation: Citation, evidence: ModelEvidence): boolean {
  const binding = evidence.bindings.get(citation.documentId)
  const paragraph = citationParagraph(citation, evidence)
  return binding !== undefined && paragraph !== undefined && paragraphGradeMatches(paragraph, binding.source, evidence)
}

function sectionKey(paragraph: ReferenceParagraph): string {
  return paragraph.sectionId ? `section:${paragraph.sectionId}` : `heading:${paragraph.heading.replace(/\s*-\s*table$/i, '')}`
}

export function citationSection(citation: Citation, evidence: ModelEvidence): ReferenceParagraph[] {
  const binding = evidence.bindings.get(citation.documentId)
  const paragraph = citationParagraph(citation, evidence)
  if (!binding?.document || !paragraph) return []
  return binding.document.paragraphs.filter(value => sectionKey(value) === sectionKey(paragraph) &&
    paragraphGradeMatches(value, binding.source, evidence))
}

export function citationKey(citation: Pick<Citation, 'documentId' | 'documentVersion' | 'paragraphId'>): string {
  return JSON.stringify([citation.documentId, citation.documentVersion, citation.paragraphId])
}

export function citationErrors(
  citation: Citation,
  evidence: ModelEvidence,
  use: 'context' | 'work' | 'basis' | 'qualification' | 'issue' = 'context',
  included?: ReadonlySet<string>,
): string[] {
  if (!citation || typeof citation.documentId !== 'string' || typeof citation.paragraphId !== 'string' ||
    !Number.isInteger(citation.documentVersion) || !Number.isInteger(citation.page) ||
    typeof citation.heading !== 'string' || typeof citation.quote !== 'string' || !citation.quote.trim()) {
    return ['Citation must contain a document ID/version, paragraph ID, page, heading, and nonempty exact quote.']
  }
  const binding = evidence.bindings.get(citation.documentId)
  if (!binding) return [`Citation document ${citation.documentId} is foreign to the frozen source set.`]
  if (!binding.selected) return [`Citation document ${citation.documentId} is unselected.`]
  if (binding.source.documentVersion !== citation.documentVersion) {
    return [`Citation document ${citation.documentId} has a mismatched frozen version.`]
  }
  const paragraph = binding.document?.paragraphs.find(value => value.id === citation.paragraphId)
  if (!paragraph) return [`Citation paragraph ${citation.paragraphId} is absent from the frozen selected document.`]
  const errors: string[] = []
  if (citation.page !== paragraph.page) errors.push(`Citation ${citation.paragraphId} has a mismatched page.`)
  if (citation.heading !== paragraph.heading) errors.push(`Citation ${citation.paragraphId} has a mismatched heading.`)
  if (!paragraph.text.includes(citation.quote)) errors.push(`Citation ${citation.paragraphId} quote is not an exact substring.`)
  if (included && !included.has(citationKey(citation))) errors.push(`Citation ${citation.paragraphId} was not included in model context.`)
  if (use !== 'context' && use !== 'issue') {
    if (!binding.applicable || binding.source.purpose === 'background') {
      errors.push(`Citation ${citation.paragraphId} uses background, excluded, or uncertain material as authority.`)
    }
    if (binding.source.purpose !== 'job-context' && !coverageMatches(binding.source, evidence.sourceSet, evidence.grade)) {
      errors.push(`Citation ${citation.paragraphId} has unresolved or mismatched series, grade, or functional coverage.`)
    }
    if (!citationGradeMatches(citation, evidence)) {
      errors.push(`Citation ${citation.paragraphId} uses another grade's section or table row as evidence for this grade.`)
    }
    if (['superseded', 'unknown', 'conflicting'].includes(binding.source.authorityStatus)) {
      errors.push(`Citation ${citation.paragraphId} has unresolved source authority or revision.`)
    }
    if (use === 'work' && ['qualification', 'issuance'].includes(binding.source.purpose)) {
      errors.push(`Citation ${citation.paragraphId} cannot turn qualifications or issuance metadata into scored work expectations.`)
    }
    if (use === 'qualification' && !['qualification', 'agency', 'job-context'].includes(binding.source.purpose)) {
      errors.push(`Citation ${citation.paragraphId} is not qualification, agency, or role-prerequisite evidence.`)
    }
  }
  return errors
}

function validateDocument(document: ReferenceDocument, source: FrozenReferenceSource): void {
  if (document.kind !== 'reference' || document.sample !== false ||
    document.version !== source.documentVersion || document.pageCount !== source.pageCount ||
    !Number.isInteger(document.pageCount) || document.pageCount < 1 || document.completeness !== source.completeness) {
    failIntegrity(`Frozen document metadata does not match source ${source.sourceId}.`)
  }
  const pages = [...document.selectedPages].sort((a, b) => a - b)
  if (new Set(pages).size !== pages.length || pages.some(page => !Number.isInteger(page) || page < 1 || page > document.pageCount) ||
    JSON.stringify(pages) !== JSON.stringify([...source.selectedPages].sort((a, b) => a - b)) ||
    (document.completeness === 'selected-pages' && pages.length === 0)) {
    failIntegrity(`Frozen page selection does not match source ${source.sourceId}.`)
  }
  const ids = new Set<string>()
  let characters = 0
  for (const paragraph of document.paragraphs) {
    if (!paragraph.id || ids.has(paragraph.id) || typeof paragraph.heading !== 'string' ||
      typeof paragraph.text !== 'string' || !paragraph.text.trim() || !Number.isInteger(paragraph.page) ||
      paragraph.page < 1 || paragraph.page > document.pageCount || (pages.length > 0 && !pages.includes(paragraph.page)) ||
      (paragraph.table && (!Array.isArray(paragraph.table.headers) || paragraph.table.headers.some(header => typeof header !== 'string') ||
        !Number.isInteger(paragraph.table.row) || paragraph.table.row < 0))) {
      failIntegrity(`Invalid, duplicate, or unselected paragraph in source ${source.sourceId}.`)
    }
    ids.add(paragraph.id)
    characters += paragraph.text.length
  }
  if (characters > GRADE_LADDER_LIMITS.maxSourceCharacters) failIntegrity(`Source ${source.sourceId} exceeds the extracted-character limit.`)
}

export function prepareEvidence(
  sourceSet: GradeSourceSetRecord,
  documents: ReferenceDocument[],
  inherited: GradeIssue[] = [],
  grade?: number,
): ModelEvidence {
  if (sourceSet.recordType !== 'grade-source-set' || !sourceSet.id || !sourceSet.workspaceId || !sourceSet.ladderId ||
    !/^\d{4}$/.test(sourceSet.context.series) || !sourceSet.grades.length ||
    sourceSet.grades.length > GRADE_LADDER_LIMITS.maxGrades || new Set(sourceSet.grades).size !== sourceSet.grades.length ||
    sourceSet.grades.some(value => !Number.isInteger(value) || value < 1 || value > 15)) {
    throw new GradeModelError('invalid-input', 'A frozen source set with an explicit GS series and requested grades is required.')
  }
  if (grade !== undefined && !sourceSet.grades.includes(grade)) {
    throw new GradeModelError('invalid-input', 'The requested grade is not in the frozen source set.')
  }
  if (sourceSet.sources.filter(value => value.origin !== 'seed-job').length > GRADE_LADDER_LIMITS.maxSources) {
    failIntegrity('The frozen source set exceeds the supporting-reference limit.')
  }
  const bindings = new Map<string, Binding>()
  const decisions = new Map<string, SourceDecision>()
  for (const decision of sourceSet.decisions) {
    if (decisions.has(decision.sourceId)) failIntegrity(`Duplicate source decision ${decision.sourceId}.`)
    decisions.set(decision.sourceId, decision)
  }
  const sourceIds = new Set<string>()
  for (const source of sourceSet.sources) {
    if (!source.sourceId || sourceIds.has(source.sourceId) || bindings.has(source.documentId) ||
      !source.documentId || !Number.isInteger(source.documentVersion) || source.documentVersion < 1) {
      failIntegrity('Frozen source IDs and document bindings must be unique and versioned.')
    }
    sourceIds.add(source.sourceId)
    const decision = decisions.get(source.sourceId)
    // The API captures seed context automatically; an explicit deselection still wins.
    const implicitSeed = source.origin === 'seed-job' && source.purpose === 'job-context'
    bindings.set(source.documentId, {
      source, decision,
      selected: decision?.selected ?? implicitSeed,
      applicable: decision ? decision.applicability === 'applicable' : implicitSeed,
      document: undefined,
    })
  }
  for (const document of documents) {
    const binding = bindings.get(document.id)
    if (!binding || binding.source.documentVersion !== document.version) failIntegrity('A supplied document is foreign or has a mismatched frozen version.')
    if (binding.document) failIntegrity(`Duplicate supplied document ${document.id}.`)
    validateDocument(document, binding.source)
    binding.document = document
  }
  if (sourceSet.decisions.some(value => value.selected && !sourceIds.has(value.sourceId))) {
    failIntegrity('A selected source decision has no frozen source binding.')
  }
  const evidence: ModelEvidence = { sourceSet, bindings, issues: [], grade }
  const foundIssues = [...sourceSet.issues, ...inherited]
  if (!sourceSet.context.confirmed || !sourceSet.confirmedBy) {
    foundIssues.push(issue('context-unconfirmed', 'Confirm the series, grades, and required applicability context before this draft can be supported.', { scope: 'context' }))
  }
  for (const binding of bindings.values()) {
    const { source } = binding
    if (!binding.selected) continue
    foundIssues.push(...source.issues)
    if (!binding.document || binding.document.paragraphs.length === 0) {
      foundIssues.push(...sourceIssues(evidence, source, 'source-document-missing', 'The selected frozen source has no extracted passages available for this model operation.'))
    }
    if (source.completeness === 'incomplete') {
      foundIssues.push(...sourceIssues(evidence, source, 'source-extraction-incomplete', 'The selected source extraction is incomplete; missing source context cannot be assumed.'))
    } else if (source.completeness === 'selected-pages') {
      foundIssues.push(...sourceIssues(evidence, source, 'source-selected-pages', 'Only the explicitly selected original pages were captured. Unselected pages were not examined and cannot be used as evidence.', 'warning'))
    }
    if (!binding.applicable && binding.decision?.applicability !== 'background') {
      foundIssues.push(...sourceIssues(evidence, source, 'source-applicability-unresolved', 'The selected source is excluded or has unresolved applicability; a selection decision cannot establish a grading rule.'))
    }
    if (binding.applicable && !['background', 'job-context'].includes(source.purpose)) {
      if (!coverageMatches(source, sourceSet)) {
        foundIssues.push(...sourceIssues(evidence, source, 'source-coverage-unresolved', 'Selected authority has unconfirmed or mismatched series or functional coverage. Resolve it with applicable source evidence.'))
      }
      if (['superseded', 'unknown', 'conflicting'].includes(source.authorityStatus)) {
        foundIssues.push(...sourceIssues(evidence, source, 'source-revision-unresolved', 'Selected authority has an unresolved, conflicting, or superseded revision.'))
      }
      if (['grading', 'classification', 'agency'].includes(source.purpose) && !currentAuthority(source)) {
        foundIssues.push(...sourceIssues(evidence, source, 'source-authority-unverified', 'Grading requires current OPM authority or explicitly scoped agency evidence, not an unverified authority label.'))
      }
      if (source.purpose === 'agency' && (!sourceSet.context.agency.trim() || sourceSet.context.agencyType === 'unknown')) {
        foundIssues.push(...sourceIssues(evidence, source, 'agency-context-required', 'Confirm agency context before using agency-specific requirements as grading evidence.'))
      }
    }
  }
  for (const requestedGrade of grade === undefined ? sourceSet.grades : [grade]) {
    if (![...bindings.values()].some(binding => gradingBinding(binding, sourceSet, requestedGrade))) {
      foundIssues.push(issue('grading-evidence-missing', 'No applicable grading, classification, or agency work-level evidence is available for this grade. The seed job and minimum qualifications are not grade proof.', { scope: 'grade', grade: requestedGrade }))
    }
  }
  const sanitized: GradeIssue[] = []
  for (const value of issuesForGrade(foundIssues, grade)) {
    if (!value.citations?.length) {
      sanitized.push(value)
      continue
    }
    const valid = value.citations.filter(citation => citationErrors(citation, evidence, 'issue').length === 0)
    sanitized.push({ ...value, citations: valid })
    if (valid.length !== value.citations.length) {
      sanitized.push(issue('inherited-citation-invalid', `Issue ${value.id} contains citation locators or quotes that cannot be verified in the frozen selected sources. Those citations were not retained as evidence.`, {
        scope: value.scope, sourceId: value.sourceId, grade: value.grade, criterionId: value.criterionId,
      }))
    }
  }
  evidence.issues = mergeIssues(sanitized)
  return evidence
}

interface Section {
  key: string
  heading: string
  pages: number[]
  paragraphIds: string[]
  relevance: 'relevant' | 'other-grade'
  included: boolean
  paragraphs: ReferenceParagraph[]
}

interface Passage {
  binding: Binding
  section: Section
  paragraphs: ReferenceParagraph[]
  required: boolean
  priority: number
}

export interface BoundedModelContext {
  user: string
  issues: GradeIssue[]
  included: ReadonlySet<string>
}

function otherGrade(heading: string, source: FrozenReferenceSource, evidence: ModelEvidence): boolean {
  if (source.purpose === 'job-context') return false
  const grades = evidence.grade === undefined ? evidence.sourceSet.grades : [evidence.grade]
  if (source.coverage.grades.length > 0 && !grades.some(grade => source.coverage.grades.includes(grade))) return true
  const mentioned = [...heading.matchAll(/\bGS[-\s]*(\d{1,2})\b/gi)].map(match => Number(match[1]))
  const range = /\bGS[-\s]*(\d{1,2})\s*(?:through|to|[-\u2013])\s*(?:GS[-\s]*)?(\d{1,2})\b/i.exec(heading)
  if (range) return !grades.some(grade => grade >= Number(range[1]) && grade <= Number(range[2]))
  const minimum = /\bGS[-\s]*(\d{1,2})\s*(?:\+|and (?:above|higher)|or (?:above|higher))/i.exec(heading)
  if (minimum) return !grades.some(grade => grade >= Number(minimum[1]))
  // Ranges, cross-grade rules, and ambiguous sections stay relevant, not guessed away.
  return mentioned.length > 0 && !/through|\bto\b|\+|\d\s*[-\u2013]\s*(?:GS[-\s]*)?\d|scope|applicab|footnote|exclu|compar|conversion/i.test(heading) &&
    !grades.some(grade => mentioned.includes(grade))
}

export function boundModelContext(
  request: Pick<GradeModelRequest, 'name' | 'system' | 'schema'>,
  evidence: ModelEvidence,
  input: Record<string, unknown>,
  requiredCitations: Citation[] = [],
): BoundedModelContext {
  const pinned = new Set([...requiredCitations, ...evidence.issues.flatMap(value => value.citations ?? [])].map(citationKey))
  const passages: Passage[] = []
  const sources = [...evidence.bindings.values()].filter(binding => binding.selected).map(binding => {
    const { source, document } = binding
    const groups = new Map<string, ReferenceParagraph[]>()
    for (const paragraph of document?.paragraphs ?? []) {
      const key = sectionKey(paragraph)
      const group = groups.get(key) ?? []
      group.push(paragraph)
      groups.set(key, group)
    }
    const sections: Section[] = [...groups.entries()].map(([key, paragraphs]) => {
      const heading = paragraphs[0].heading
      const safety = /scope|applicab|coverage|exclu|supersed|revision|issuance|introduction|footnote|\bnotes?\b|conversion|how to use/i.test(heading) ||
        paragraphs.some(paragraph => /^\s*(?:footnote|\*|\[\d+\])/i.test(paragraph.text))
      const relevance = !safety && otherGrade(heading, source, evidence) ? 'other-grade' : 'relevant'
      const section: Section = {
        key, heading, pages: [...new Set(paragraphs.map(value => value.page))],
        paragraphIds: paragraphs.map(value => value.id), relevance, included: true, paragraphs,
      }
      const hasPinned = paragraphs.some(paragraph => pinned.has(citationKey({ documentId: source.documentId, documentVersion: source.documentVersion, paragraphId: paragraph.id })))
      const requested = evidence.grade === undefined ? evidence.sourceSet.grades : [evidence.grade]
      const explicitGrade = requested.some(grade => new RegExp(`\\bGS[-\\s]*0?${grade}\\b`, 'i').test(heading))
      passages.push({
        binding, section, paragraphs, required: hasPinned || (safety && relevance === 'relevant'),
        priority: hasPinned ? 0 : safety ? 1 : relevance === 'other-grade' ? 8 : explicitGrade ? 2 :
          ['grading', 'classification', 'agency'].includes(source.purpose) ? 3 : source.purpose === 'qualification' ? 4 :
            source.purpose === 'job-context' ? 5 : 7,
      })
      return section
    })
    return {
      sourceId: source.sourceId, title: source.title, origin: source.origin, purpose: source.purpose,
      publisher: source.publisher, authorityStatus: source.authorityStatus, coverage: source.coverage,
      revision: source.revision ?? null, intendedSection: source.intendedSection ?? null,
      decision: binding.decision ?? { sourceId: source.sourceId, selected: true, applicability: 'applicable', reason: 'Frozen seed role context only.' },
      documentId: source.documentId, documentVersion: source.documentVersion,
      pageCount: source.pageCount, selectedPages: source.selectedPages, completeness: source.completeness,
      sections,
    }
  })
  const limit = GRADE_LADDER_LIMITS.maxModelCharacters - request.name.length - request.system.length -
    JSON.stringify(request.schema).length - REPAIR_CONTEXT_RESERVE
  const serialize = (issues: GradeIssue[]) => JSON.stringify({
    input,
    frozenSourceSet: {
      id: evidence.sourceSet.id, revision: evidence.sourceSet.revision, contentHash: evidence.sourceSet.contentHash,
      context: evidence.sourceSet.context, grades: evidence.sourceSet.grades,
    },
    evidencePolicy: 'Only included complete sections were supplied. Selected pages are not a claim of full-document extraction. Omitted relevant sections remain unresolved; never use omitted text or outside knowledge.',
    sources,
    unresolvedIssues: issues,
  })
  const result = (issues: GradeIssue[]): BoundedModelContext => {
    const included = new Set<string>()
    for (const passage of passages.filter(value => value.section.included)) {
      for (const paragraph of passage.paragraphs) included.add(citationKey({
        documentId: passage.binding.source.documentId, documentVersion: passage.binding.source.documentVersion, paragraphId: paragraph.id,
      }))
    }
    return { user: serialize(issues), issues, included }
  }
  if (serialize(evidence.issues).length <= limit) return result(evidence.issues)

  const contextIssues = (potential = false): GradeIssue[] => sources.flatMap(value => {
    const omitted = value.sections.filter(section => potential || !section.included)
    if (omitted.length === 0) return []
    const insufficient = omitted.some(section => section.relevance === 'relevant')
    const source = evidence.bindings.get(value.documentId)!.source
    const message = `${omitted.length} complete section(s) of ${source.title} were omitted from model context. ` +
      (insufficient ? 'Relevant context could not fit; add narrower complete page/section selections or supporting sources before treating this grade as supported.' : 'Only explicitly other-grade sections were omitted; they were not reviewed.')
    if (!insufficient) return [issue('model-context-omitted', message, { severity: 'warning', sourceId: source.sourceId, grade: evidence.grade })]
    return sourceIssues(evidence, source, 'model-context-incomplete', message)
  })
  const possibleIssues = mergeIssues(evidence.issues, contextIssues(true))
  for (const passage of passages) {
    passage.section.included = false
    passage.section.paragraphs = []
  }
  let used = serialize(possibleIssues).length
  const failBudget = (): never => {
    const blocker = issue('model-context-limit', 'The model budget cannot hold the input and required complete source sections, including selected citation locators, table context, and footnotes. Narrow the source selection or input explicitly.', {
      scope: 'context', grade: evidence.grade,
    })
    throw new GradeModelError('model-context-limit', blocker.message, { issues: mergeIssues(evidence.issues, [blocker]) })
  }
  if (used > limit) failBudget()
  const ordered = [...passages].sort((a, b) => Number(b.required) - Number(a.required) || a.priority - b.priority)
  for (const passage of ordered) {
    const cost = JSON.stringify(passage.paragraphs).length - 3
    if (used + cost > limit) {
      if (passage.required) failBudget()
      continue
    }
    passage.section.included = true
    passage.section.paragraphs = passage.paragraphs
    used += cost
  }
  const bounded = result(mergeIssues(evidence.issues, contextIssues()))
  if (bounded.user.length > limit) failBudget()
  return bounded
}
