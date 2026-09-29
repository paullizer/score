import { PDFDocument } from 'pdf-lib'
import type { ReportFontData } from '../../domain/analysis-reports'
import { embedReportFonts } from './pdf'
import { PdfReportLayout } from './pdf-layout'
import { writeStandaloneRubric } from './rubric-document'
import { RUBRIC_EXPORT_SUBJECT, rubricExportDocumentTitle, type PreparedRubricExport } from './rubric-export'

export async function generateRubricPdf(prepared: PreparedRubricExport, fonts?: ReportFontData): Promise<Uint8Array> {
  const { document: rubric, limits, startedAt } = prepared
  const document = await PDFDocument.create()
  const embedded = await embedReportFonts(document, { fonts })
  document.setTitle(rubricExportDocumentTitle(rubric), { showInWindowTitleBar: true })
  document.setAuthor('Score')
  document.setSubject(RUBRIC_EXPORT_SUBJECT)
  document.setCreator('Score')
  document.setProducer('Score · pdf-lib')
  document.setCreationDate(new Date(prepared.generatedAt))
  document.setModificationDate(new Date(prepared.generatedAt))
  const layout = new PdfReportLayout(document, embedded, '', limits)
  writeStandaloneRubric(layout, rubric, prepared.notice)
  layout.finish()
  const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false })
  layout.checkTime()
  if (Date.now() - startedAt > limits.maxGenerationMilliseconds) {
    throw new Error('Rubric PDF generation exceeded its time limit. No file was downloaded.')
  }
  if (bytes.byteLength > limits.maxOutputBytes) {
    throw new Error(`This rubric PDF exceeds the ${limits.maxOutputBytes.toLocaleString('en-US')}-byte export size limit. No file was downloaded.`)
  }
  return bytes
}
