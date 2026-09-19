import fontkit from '@pdf-lib/fontkit'
import { PDFDocument } from 'pdf-lib'
import { REPORT_LIMITS } from '../../domain/analysis-reports'
import type { AnalysisReport, ReportGenerationOptions } from '../../domain/analysis-reports'
import { REPORT_FONT_FAMILY, REPORT_TITLE } from './presentation'
import { assertReportResourceLimits } from './model'
import { requireReportNarratives } from './narratives'
import { writeDocumentReport } from './document-content'
import { PdfReportLayout } from './pdf-layout'
import type { PdfReportFonts } from './pdf-layout'

async function embedReportFonts(document: PDFDocument, options?: ReportGenerationOptions): Promise<PdfReportFonts> {
  if (!options?.fonts?.regular?.byteLength || !options.fonts.bold?.byteLength) {
    throw new Error('PDF generation requires the locally bundled Noto Sans regular and bold font bytes. Reload the application and retry; no report was generated.')
  }
  document.registerFontkit(fontkit)
  const embed = async (weight: 'regular' | 'bold') => {
    try {
      return await document.embedFont(options.fonts![weight], { subset: true, features: { liga: false, clig: false } })
    } catch {
      throw new Error(`The local PDF ${weight} font could not be read. Reload the application to load the bundled ${REPORT_FONT_FAMILY} fonts, then retry.`)
    }
  }
  const [regular, bold] = await Promise.all([embed('regular'), embed('bold')])
  return { regular, bold }
}

export async function generatePdfReport(report: AnalysisReport, options?: ReportGenerationOptions): Promise<Uint8Array> {
  assertReportResourceLimits(report)
  requireReportNarratives(report)
  const document = await PDFDocument.create()
  const fonts = await embedReportFonts(document, options)
  document.setTitle(REPORT_TITLE, { showInWindowTitleBar: true })
  document.setAuthor('Score')
  document.setSubject('Analysis evidence for human review')
  document.setCreator('Score')
  document.setProducer('Score · pdf-lib')
  document.setCreationDate(new Date(report.generatedAt))
  document.setModificationDate(new Date(report.generatedAt))
  const layout = new PdfReportLayout(document, fonts, report.dataKind === 'sample' ? 'FICTIONAL SAMPLE' : '')
  writeDocumentReport(layout, report, options)
  layout.finish()
  const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false })
  layout.checkTime()
  if (bytes.byteLength > REPORT_LIMITS.maxOutputBytes) {
    throw new Error(`PDF exceeds the ${Math.floor(REPORT_LIMITS.maxOutputBytes / 1024 / 1024)} MiB output resource limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.`)
  }
  return bytes
}
