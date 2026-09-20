import {
  AlignmentType, Bookmark, BorderStyle, Document, Footer, Header, HeadingLevel,
  InternalHyperlink, Packer, PageNumber, Paragraph, SectionType, ShadingType, Tab, Table,
  TableCell, TableLayoutType, TableRow, TabStopType, TextRun, VerticalAlign, WidthType,
} from 'docx'
import type { IBaseParagraphStyleOptions, IParagraphOptions, IRunOptions, IStylesOptions } from 'docx'
import { REPORT_LIMITS } from '../../domain/analysis-reports'
import type {
  AnalysisReport, RankedReportComparison, ReportCitation, ReportCriterionAssessment,
  ReportFact, ReportGenerationOptions, ReportGroup, ReportLimitation, ReportTarget,
} from '../../domain/analysis-reports'
import {
  assertReportXmlText, candidateName, comparisonStatusLabel, criterionScoreLabel,
  evidenceStatusLabel, formatReportWeight, highlightNotice, overallScoreLabel, REPORT_CAPTURE_NOTICE,
  REPORT_HUMAN_REVIEW_NOTICE, REPORT_PALETTE, REPORT_SAMPLE_NOTICE, reportStatusNotice,
  reportTitle, summaryExcerpt, targetName,
} from './presentation'

const PAGE_WIDTH = 12240
const PAGE_HEIGHT = 15840
const PAGE_MARGIN = 1440
const CONTENT_WIDTH = PAGE_WIDTH - 2 * PAGE_MARGIN
const FONT = 'Arial'
const palette = REPORT_PALETTE
type Content = Paragraph | Table

function headingStyle(level: number, size: number, color: string): IBaseParagraphStyleOptions {
  return {
    basedOn: 'Normal', next: 'Normal', quickFormat: true,
    run: { font: FONT, size, bold: true, color },
    paragraph: {
      spacing: { before: level === 3 ? 180 : 240, after: level === 1 ? 180 : 120 },
      outlineLevel: level - 1, keepNext: true, keepLines: false,
    },
  }
}

const styles: IStylesOptions = {
  default: {
    document: {
      run: { font: FONT, size: 22, color: palette.text },
      paragraph: { spacing: { after: 120, line: 276 }, keepLines: false },
    },
    title: {
      basedOn: 'Normal', next: 'Normal', quickFormat: true,
      run: { font: FONT, size: 48, bold: true, color: palette.text },
      paragraph: { spacing: { before: 160, after: 240 }, keepNext: true, keepLines: false },
    },
    heading1: headingStyle(1, 36, palette.text),
    heading2: headingStyle(2, 28, palette.accent),
    heading3: headingStyle(3, 24, palette.text),
  },
  paragraphStyles: [
    {
      id: 'ReportMetadata', name: 'Report metadata', basedOn: 'Normal', next: 'Normal',
      run: { size: 20, color: palette.muted },
      paragraph: { spacing: { after: 80, line: 252 }, keepLines: false },
    },
    {
      id: 'ReportProvenance', name: 'Compact saved provenance', basedOn: 'ReportMetadata', next: 'Normal',
      paragraph: { spacing: { before: 0, after: 40, line: 240 }, keepNext: false, keepLines: false },
    },
    {
      id: 'ReportLabel', name: 'Report field label', basedOn: 'Normal', next: 'Normal',
      run: { size: 22, bold: true, color: palette.text },
      paragraph: { spacing: { before: 100, after: 60 }, keepNext: true, keepLines: false },
    },
    {
      id: 'ReportQuotation', name: 'Exact saved quotation', basedOn: 'Normal', next: 'Normal',
      run: { size: 22, color: palette.text },
      paragraph: {
        spacing: { after: 80, line: 276 }, indent: { left: 240, right: 120 }, keepLines: false,
        border: { left: { style: BorderStyle.SINGLE, color: palette.border, size: 12, space: 8 } },
      },
    },
    {
      id: 'ReportLocator', name: 'Saved citation locator', basedOn: 'ReportMetadata', next: 'Normal',
      paragraph: { indent: { left: 240 }, spacing: { after: 160, line: 252 }, keepLines: false },
    },
    {
      id: 'ReportTableText', name: 'Report table text', basedOn: 'Normal', next: 'Normal',
      run: { size: 21 },
      paragraph: { spacing: { after: 40, line: 252 }, keepNext: false, keepLines: false },
    },
  ],
}

function runs(value: string, options: IRunOptions = {}): TextRun[] {
  return value.split(/(\r\n|\r|\n|\t)/).map(part => {
    if (part === '\t') return new TextRun({ ...options, children: [new Tab()] })
    if (/^[\r\n]+$/.test(part)) return new TextRun({ ...options, break: 1 })
    return new TextRun({ ...options, text: part })
  })
}

function paragraph(value: string, options: IParagraphOptions = {}, run: IRunOptions = {}): Paragraph {
  return new Paragraph({ widowControl: true, ...options, children: runs(value, run) })
}

function text(value: string, options: IParagraphOptions = {}): Paragraph[] {
  return value.split(/\r\n|\r|\n/).map(line => paragraph(line, options))
}

function heading(value: string, level: 1 | 2 | 3, pageBreakBefore = false): Paragraph {
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3]
  return paragraph(value, { heading: levels[level - 1], pageBreakBefore })
}

function field(label: string, value: string, metadata = false, options: IParagraphOptions = {}): Paragraph {
  return new Paragraph({
    widowControl: true,
    ...(metadata ? { style: 'ReportMetadata' } : {}),
    ...options,
    children: [...runs(`${label}: `, { bold: true }), ...runs(value)],
  })
}

function labelledText(label: string, value: string): Paragraph[] {
  return [paragraph(label, { style: 'ReportLabel' }), ...text(value)]
}

function callout(value: string): Paragraph[] {
  return text(value, {
    shading: { fill: palette.background, type: ShadingType.CLEAR },
    border: { left: { style: BorderStyle.SINGLE, size: 16, color: palette.accent, space: 10 } },
    indent: { left: 200, right: 120 }, spacing: { before: 100, after: 140, line: 276 },
  })
}

function facts(values: ReportFact[]): Paragraph[] {
  return values.map(fact => field(fact.label, fact.value, true, { style: 'ReportProvenance' }))
}

function limitation(value: ReportLimitation): Paragraph[] {
  return [
    ...labelledText(`Saved limitation (${value.code})`, value.message),
    ...(value.criterionId ? [field('Criterion', value.criterionId, true)] : []),
    ...(value.qualificationId ? [field('Qualification', value.qualificationId, true)] : []),
  ]
}

function citations(label: string, values: ReportCitation[]): Paragraph[] {
  if (!values.length) return [paragraph(`${label}: No citations were saved for this assessment.`, { style: 'ReportMetadata' })]
  return values.flatMap((citation, index) => {
    const quotation = text(citation.quote, { style: 'ReportQuotation' })
    return [
      paragraph(`${label} ${index + 1} — exact quotation`, { style: 'ReportLabel' }),
      ...quotation,
      ...text(citation.locator, { style: 'ReportLocator' }),
    ]
  })
}

function table(headers: string[], widths: number[], rows: Paragraph[][][]): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: palette.border }
  const cells = (values: Paragraph[][], header: boolean, index = 0) => values.map((children, column) => new TableCell({
    width: { size: widths[column], type: WidthType.DXA },
    margins: { top: 120, bottom: 120, left: 140, right: 140 },
    borders: { top: border, bottom: border, left: border, right: border },
    verticalAlign: VerticalAlign.TOP,
    shading: { type: ShadingType.CLEAR, fill: header ? palette.accent : index % 2 ? palette.background : palette.paper },
    children,
  }))
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths, layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        tableHeader: true, cantSplit: true,
        children: cells(headers.map(label => [paragraph(label, { style: 'ReportTableText' }, { bold: true, color: palette.paper })]), true),
      }),
      ...rows.map((row, index) => new TableRow({ cantSplit: false, children: cells(row, false, index) })),
    ],
  })
}

function tableText(value: string, options: IRunOptions = {}): Paragraph[] {
  return [paragraph(value, { style: 'ReportTableText' }, options)]
}

function bookmarkId(comparison: RankedReportComparison): string {
  return `review_${comparison.index}`
}

function overview(report: AnalysisReport): Content[] {
  const notices = new Set([
    ...(report.dataKind === 'sample' ? [REPORT_SAMPLE_NOTICE] : []),
    REPORT_HUMAN_REVIEW_NOTICE,
    reportStatusNotice(report.counts),
    REPORT_CAPTURE_NOTICE,
    ...report.notices,
  ])
  return [
    paragraph('SCORE', { spacing: { after: 120 } }, { bold: true, color: palette.accent, size: 28 }),
    paragraph(reportTitle(report), { heading: HeadingLevel.TITLE }),
    paragraph(
      `${report.dataKind === 'sample' ? 'FICTIONAL SAMPLE' : 'REAL SAVED ANALYSIS'}${report.partial ? '  |  PARTIAL REPORT' : ''}`,
      { spacing: { after: 200 } }, { bold: true, color: palette.accent },
    ),
    paragraph(
      `${report.candidateCount} candidate${report.candidateCount === 1 ? '' : 's'} · ${report.counts.total} comparison${report.counts.total === 1 ? '' : 's'} · ${report.groups.length} exact target${report.groups.length === 1 ? '' : 's'}`,
      {}, { size: 26, bold: true },
    ),
    ...callout(REPORT_HUMAN_REVIEW_NOTICE),
    heading('Run and capture context', 2),
    field('Run', `${report.run.name} · ${report.run.id}`, true),
    field('Run created', report.run.createdAt, true),
    field('Capture started', report.capture.startedAt, true),
    field('Capture completed', report.capture.completedAt, true),
    field('Report generated', report.generatedAt, true),
    field('Scope', report.scope.targetId ?? 'All exact saved job/grade targets in the captured run', true),
    ...(report.workspaceId ? [field('Workspace', report.workspaceId, true)] : []),
    field('Report schema', String(report.schemaVersion), true),
    heading('Reading this report', 2),
    ...[...notices].filter(notice => notice !== REPORT_HUMAN_REVIEW_NOTICE).flatMap(notice => text(notice)),
    paragraph('Target summaries show saved evidence-match ranks and labelled assessment excerpts. Every included candidate/target pair has a full review below; source quotations and assessment text are not shortened in those reviews.'),
  ]
}

function targetSummary(group: ReportGroup): Content[] {
  const { target } = group
  const highlightedIds = new Set(group.highlightedComparisonIds)
  const highlighted = group.comparisons.filter(comparison => comparison.highlighted && highlightedIds.has(comparison.id))
  const content: Content[] = [
    heading(`Highest evidence matches — ${targetName(target)}`, 1, true),
    field(target.kind === 'grade' ? 'Grade' : 'Job', target.sublabel || targetName(target), true),
    ...(target.displayName ? [field('Source target title', target.label, true)] : []),
    field('Saved target version', target.versionLabel, true),
    field('Exact target', target.id, true),
    field('Rubric', `${target.rubricId} · version ${target.rubricVersion}`, true),
    ...text(reportStatusNotice(group.counts)),
    ...text(highlightNotice(group)),
  ]
  if (group.cutoffScore !== null) content.push(field('Highlighted cutoff', `${group.cutoffScore} / 100`, true))
  if (highlighted.length) {
    content.push(table(['Rank', 'Candidate / full review', 'Saved overall score'], [840, 6360, 2160], highlighted.map(comparison => [
      tableText(comparison.rank === null ? 'Not ranked' : String(comparison.rank), { bold: true }),
      [
        new Paragraph({
          style: 'ReportTableText',
          children: [new InternalHyperlink({
            anchor: bookmarkId(comparison),
            children: runs(candidateName(comparison.candidate), { bold: true, color: palette.accent }),
          })],
        }),
        ...tableText(comparison.candidate.role ?? 'Role not recorded'),
        ...tableText(`Candidate ID: ${comparison.candidate.id}`),
      ],
      tableText(overallScoreLabel(comparison.overall), { bold: true }),
    ])))
    content.push(heading('Saved assessment excerpts', 2))
    for (const comparison of highlighted) {
      content.push(
        heading(`${comparison.rank === null ? 'Not ranked' : `Rank ${comparison.rank}`} — ${candidateName(comparison.candidate)}`, 3),
        field('Saved overall score', overallScoreLabel(comparison.overall), true),
        field('Saved assessment excerpt', summaryExcerpt(comparison.summary ?? '').text),
        field('Full review', comparison.id, true),
      )
    }
  }
  content.push(...text(REPORT_HUMAN_REVIEW_NOTICE, { style: 'ReportMetadata' }))
  return content
}

function savedAssessment(target: ReportTarget, comparison: RankedReportComparison, criterionId: string): ReportCriterionAssessment {
  const assessment = comparison.criteria.find(criterion => criterion.criterionId === criterionId)
  if (!assessment) throw new Error(`Missing saved assessment for criterion ${criterionId} in ${target.id}. The Word report was not generated.`)
  return assessment
}

function criterionReview(target: ReportTarget, comparison: RankedReportComparison): Content[] {
  const content: Content[] = [
    heading('Criterion scores', 2),
    table(['Saved criterion', 'Weight', 'Score (0–5)', 'Evidence status'], [3720, 1320, 1800, 2520], target.criteria.map(definition => {
      const assessment = savedAssessment(target, comparison, definition.id)
      return [
        [...tableText(definition.label, { bold: true }), ...tableText(`ID: ${definition.id}`)],
        tableText(formatReportWeight(assessment.weight)),
        tableText(criterionScoreLabel(assessment)),
        tableText(evidenceStatusLabel(assessment.evidenceStatus)),
      ]
    })),
  ]
  if (target.criteria.some(definition => /^[~<]/.test(formatReportWeight(definition.weight)))) {
    content.push(paragraph(
      '~ marks display-rounded criterion weights; <0.01% denotes a smaller nonzero weight. Saved scores and weight totals are unchanged.',
      { style: 'ReportMetadata' },
    ))
  }
  content.push(heading('Criterion evidence review', 2))
  for (const definition of target.criteria) {
    const assessment = savedAssessment(target, comparison, definition.id)
    content.push(
      heading(definition.label, 3),
      field('Criterion ID', definition.id, true),
      field('Weight / requirement', `${formatReportWeight(definition.weight)} · ${definition.requirementType ?? 'Not specified'}`, true),
      field('Saved score / evidence status', `${criterionScoreLabel(assessment)} · ${evidenceStatusLabel(assessment.evidenceStatus)}`),
      ...labelledText('Saved criterion wording', definition.description),
      ...labelledText('Saved guidance', definition.guidance),
      ...labelledText('Saved rationale', assessment.rationale),
      ...(assessment.limitation ? limitation(assessment.limitation) : []),
      ...citations('Resume evidence', assessment.citations),
      ...citations('Requirement evidence', assessment.requirementCitations),
    )
  }
  return content
}

function qualificationReview(target: ReportTarget, comparison: RankedReportComparison): Content[] {
  if (target.kind !== 'grade' && !comparison.qualifications.length) return []
  const content: Content[] = [
    heading('GS qualifications — separate, unscored human review', 2),
    ...callout('These qualification findings are separate from criterion and overall scores. They are not an official GS eligibility determination. A qualified reviewer must inspect the saved interpretation and evidence.'),
  ]
  if (!comparison.qualifications.length) content.push(paragraph('No separate qualification assessments were saved.'))
  for (const qualification of comparison.qualifications) {
    content.push(
      heading(`Qualification — ${qualification.qualificationId}`, 3),
      ...labelledText('Saved qualification wording', qualification.text),
      field('Evidence status', evidenceStatusLabel(qualification.evidenceStatus)),
      field('Source support', qualification.support, true),
      ...labelledText('Saved interpretation', qualification.interpretation),
      ...labelledText('Saved rationale', qualification.rationale),
      ...(qualification.limitation ? limitation(qualification.limitation) : []),
      ...citations('Resume evidence', qualification.citations),
      ...citations('Requirement evidence', qualification.requirementCitations),
    )
  }
  return content
}

function provenance(target: ReportTarget, comparison: RankedReportComparison): Content[] {
  const recorded = [...target.facts, ...comparison.provenance]
  const identities: ReportFact[] = []
  const add = (label: string, value: string) => {
    if (!recorded.some(fact => fact.label === label && fact.value === value)) identities.push({ label, value })
  }
  if (target.snapshot) {
    add('Target snapshot', `${target.snapshot.snapshotId} · SHA-256 ${target.snapshot.sha256}`)
  }
  const selection = target.selection
  if (selection?.kind === 'job') {
    add('Job ID', selection.jobId)
    add('Requirement document', `${selection.documentId} · version ${selection.documentVersion}`)
    add('Rubric SHA-256', selection.rubricHash)
    add('Requirement document SHA-256', selection.documentSha256)
  } else if (selection?.kind === 'grade') {
    add('GS ladder / grade', `${selection.ladderId} · GS-${selection.grade}`)
    add('Grade version ID', selection.versionId)
    add('Grade version SHA-256', selection.versionHash)
    add('Approval ID', selection.approvalId)
    add('Grade grounding review ID', selection.reviewId)
    add('Frozen source set ID', selection.sourceSetId)
    add('Frozen source set SHA-256', selection.sourceSetHash)
  }
  if (comparison.candidate.snapshot) {
    add('Resume snapshot', `${comparison.candidate.snapshot.snapshotId} · SHA-256 ${comparison.candidate.snapshot.sha256}`)
  }
  if (comparison.candidate.documentSha256) add('Resume document SHA-256', comparison.candidate.documentSha256)
  if (comparison.resultSha256) add('Saved result SHA-256', comparison.resultSha256)
  const values = [...identities, ...recorded]
  return [
    heading('Provenance and saved identities', 2),
    ...(values.length ? facts(values) : [paragraph('No additional provenance was recorded in this saved sample.')]),
  ]
}

function comparisonReview(group: ReportGroup, comparison: RankedReportComparison): Content[] {
  const { target } = group
  const content: Content[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1, widowControl: true,
      children: [new Bookmark({
        id: bookmarkId(comparison),
        children: runs(`${candidateName(comparison.candidate)} — ${targetName(target)}`),
      })],
    }),
    field('Candidate ID', comparison.candidate.id, true),
    ...(comparison.candidate.displayName ? [field('Source-stated name', comparison.candidate.name ?? 'Not stated', true)] : []),
    ...(target.displayName ? [field('Source target title', target.label, true)] : []),
    field('Role', comparison.candidate.role ?? 'Not recorded', true),
    field('Comparison ID', comparison.id, true),
    field('Exact target', `${target.id} · ${target.kind === 'grade' ? 'Grade' : 'Job'} · ${target.sublabel}`, true),
    field('Saved target version', target.versionLabel, true),
    field('Rubric', `${target.rubricId} · version ${target.rubricVersion}`, true),
    field('Resume source', comparison.candidate.sourceLabel, true),
    field('Resume document', `${comparison.candidate.documentId} · version ${comparison.candidate.documentVersion}`, true),
    field('Status', comparisonStatusLabel(comparison.status)),
    ...callout(`Overall score: ${overallScoreLabel(comparison.overall)}`),
  ]
  if (comparison.overall.status !== 'available') content.push(field('Score availability reason', comparison.overall.reason, true))
  content.push(field(
    'Evidence-match rank within exact target',
    comparison.rank === null ? 'Not ranked — no available saved overall score' : String(comparison.rank),
    true,
  ))
  content.push(field('Highlighted evidence match', comparison.highlighted ? 'Yes' : 'No', true))
  if (comparison.error) {
    content.push(
      ...labelledText(`Processing error (${comparison.error.code})`, comparison.error.message),
      field('Processing stage', comparison.error.stage ?? 'Not recorded', true),
      field('Retryable', comparison.error.retryable === null ? 'Not recorded' : comparison.error.retryable ? 'Yes' : 'No', true),
    )
  }
  if (comparison.status === 'complete') {
    if (comparison.summary === null) throw new Error(`Missing saved assessment for comparison ${comparison.id}. The Word report was not generated.`)
    content.push(
      field('Completion', comparison.completion ?? 'Not recorded', true),
      field('Analyzed', comparison.analyzedAt ?? 'Timestamp not recorded in saved sample', true),
      heading('Full saved overall assessment', 2),
      ...text(comparison.summary),
    )
    if (comparison.coverage) {
      const coverage = comparison.coverage
      content.push(
        heading('Evidence coverage', 2),
        paragraph(`${coverage.totalCriteria} criteria; ${coverage.supported} supported; ${coverage.partial} partial; ${coverage.missing} missing; ${coverage.notAssessed} not assessed; ${coverage.notApplicable} not applicable.`),
        field('Assessed weight / total weight', `${coverage.assessedWeight} / ${coverage.totalWeight}`),
      )
    }
    content.push(...criterionReview(target, comparison), ...qualificationReview(target, comparison))
    if (comparison.limitations.length) {
      content.push(heading('Saved assessment limitations', 2), ...comparison.limitations.flatMap(limitation))
    }
  } else {
    content.push(paragraph('No completed assessment was captured for this pair. No criterion scores, qualification findings, or overall assessment have been invented.'))
  }
  content.push(...provenance(target, comparison))
  return content
}

function header(report: AnalysisReport, context?: { target: ReportTarget; comparison: RankedReportComparison }): Header {
  const designation = `${report.dataKind === 'sample' ? 'FICTIONAL SAMPLE' : 'SAVED ANALYSIS'}${report.partial ? ' | PARTIAL REPORT' : ''}`
  const border = { bottom: { style: BorderStyle.SINGLE, color: palette.border, size: 6, space: 6 } }
  const contextParagraphs = context ? [
    paragraph(
      `Review ${context.comparison.index + 1}: ${summaryExcerpt(candidateName(context.comparison.candidate).replace(/\s+/g, ' '), 36).text}`,
      { style: 'ReportMetadata', spacing: { after: 20, line: 240 } },
    ),
    paragraph(
      `Target: ${summaryExcerpt(targetName(context.target).replace(/\s+/g, ' '), 40).text}`,
      { style: 'ReportMetadata', spacing: { after: 40, line: 240 }, border },
    ),
  ] : []
  return new Header({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }],
      spacing: { after: context ? 40 : 120, line: 240 },
      ...(!context ? { border } : {}),
      children: [
        ...runs('SCORE  /  EVIDENCE REPORT', { size: 20, bold: true, color: palette.accent }),
        new TextRun({ children: [new Tab()] }),
        ...runs(designation, { size: 20, color: palette.muted }),
      ],
    }), ...contextParagraphs],
  })
}

function footer(): Footer {
  return new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.LEFT,
      tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }],
      border: { top: { style: BorderStyle.SINGLE, color: palette.border, size: 6, space: 6 } },
      children: [
        ...runs('Human review required', { size: 20, color: palette.muted }),
        new TextRun({ children: [new Tab(), 'Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 20, color: palette.muted }),
      ],
    })],
  })
}

export async function generateDocxReport(report: AnalysisReport, options?: ReportGenerationOptions): Promise<Uint8Array> {
  void options
  assertReportXmlText(report)
  const page = {
    size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
    margin: { top: PAGE_MARGIN, right: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, header: 480, footer: 600 },
  }
  const document = new Document({
    creator: 'Score', lastModifiedBy: 'Score', title: reportTitle(report),
    subject: 'Saved analysis evidence for qualified human review',
    description: REPORT_HUMAN_REVIEW_NOTICE,
    styles, features: { updateFields: true },
    sections: [
      {
        properties: { page },
        headers: { default: header(report) }, footers: { default: footer() },
        children: [...overview(report), ...report.groups.flatMap(targetSummary)],
      },
      ...report.groups.flatMap(group => group.comparisons.map(comparison => ({
        properties: { page, type: SectionType.NEXT_PAGE },
        headers: { default: header(report, { target: group.target, comparison }) },
        children: comparisonReview(group, comparison),
      }))),
    ],
  })
  const blob = await Packer.toBlob(document)
  if (blob.size > REPORT_LIMITS.maxOutputBytes) {
    throw new Error('The Word report exceeds the output size limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.')
  }
  return new Uint8Array(await blob.arrayBuffer())
}
