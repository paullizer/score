import JSZip from 'jszip'
import { REPORT_CSV_BUNDLE_FILES, type AnalysisReport, type ReportGenerationOptions } from '../../domain/analysis-reports'
import { generateCsvReport } from './csv'
import { reportGenerationPolicy, reportLimits, snapshotReportPolicy } from './policy'
import { generateRubricCsv } from './rubric-csv'
import { rubricDocumentFromReportGroup } from './rubric-model'

// ZIP timestamps can't precede 1980.
const EARLIEST_ZIP_DATE = Date.UTC(1980, 0, 1)

/**
 * The CSV export with job & rubric details: analyses.csv is exactly the plain CSV report, and rubrics.csv
 * describes every criterion of the same targets. The two files join on "Job/grade" and the criterion numbers.
 */
export async function generateCsvBundle(report: AnalysisReport, options?: ReportGenerationOptions): Promise<Uint8Array> {
  const startedAt = Date.now()
  const analyses = generateCsvReport(report, options)
  const snapshot = snapshotReportPolicy(report)
  const policy = reportGenerationPolicy(snapshot, 'csv')
  const limits = reportLimits(policy)
  const documents = snapshot.groups
    .filter(group => group.comparisons.some(comparison => comparison.status === 'complete'))
    .map(group => rubricDocumentFromReportGroup(snapshot, group, options))
  const rubrics = generateRubricCsv(documents, { notice: policy.additionalFooter, limits, startedAt })
  const generated = Date.parse(snapshot.generatedAt)
  const date = new Date(Number.isFinite(generated) && generated >= EARLIEST_ZIP_DATE ? generated : EARLIEST_ZIP_DATE)
  const zip = new JSZip()
  zip.file(REPORT_CSV_BUNDLE_FILES.analyses, analyses, { binary: true, date })
  zip.file(REPORT_CSV_BUNDLE_FILES.rubrics, rubrics, { binary: true, date })
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  if (Date.now() - startedAt > limits.maxGenerationMilliseconds) {
    throw new Error('CSV generation exceeded its time limit. Export one job or grade at a time; no file was downloaded.')
  }
  if (bytes.byteLength > limits.maxOutputBytes) {
    throw new Error('This CSV bundle exceeds the report download size limit. Export one job or grade at a time; no rows were omitted.')
  }
  return bytes
}
