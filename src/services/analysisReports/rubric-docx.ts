import type { ReportFontData } from '../../domain/analysis-reports'
import { WordReportLayout, fontInputs } from './docx'
import { writeStandaloneRubric } from './rubric-document'
import { RUBRIC_EXPORT_SUBJECT, rubricExportDocumentTitle, type PreparedRubricExport } from './rubric-export'

export async function generateRubricDocx(prepared: PreparedRubricExport, fonts?: ReportFontData): Promise<Uint8Array> {
  const { document: rubric, limits, startedAt } = prepared
  const layout = new WordReportLayout({
    title: rubricExportDocumentTitle(rubric), subject: RUBRIC_EXPORT_SUBJECT, description: rubric.scoring.at(-1) ?? '',
  }, fontInputs({ fonts }), limits, startedAt)
  writeStandaloneRubric(layout, rubric, prepared.notice)
  return layout.finish()
}
