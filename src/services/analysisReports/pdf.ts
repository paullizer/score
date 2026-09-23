import fontkit from '@pdf-lib/fontkit'
import { PDFDocument } from 'pdf-lib'
import type { AnalysisReport, ReportGenerationOptions } from '../../domain/analysis-reports'
import { REPORT_FONT_FAMILY, reportTitle } from './presentation'
import { assertReportResourceLimits } from './model'
import { requireReportNarratives } from './narratives'
import { writeDocumentReport } from './document-content'
import { PdfReportLayout } from './pdf-layout'
import type { PdfReportFonts } from './pdf-layout'
import { reportGenerationPolicy, reportLimits, snapshotReportPolicy } from './policy'

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
  const startedAt = Date.now()
  report = snapshotReportPolicy(report)
  const limits = reportLimits(reportGenerationPolicy(report, 'pdf'))
  assertReportResourceLimits(report, limits.maxInputBytes)
  requireReportNarratives(report)
  const document = await PDFDocument.create()
  const fonts = await embedReportFonts(document, options)
  document.setTitle(reportTitle(report), { showInWindowTitleBar: true })
  document.setAuthor('Score')
  document.setSubject('Analysis evidence for human review')
  document.setCreator('Score')
  document.setProducer('Score · pdf-lib')
  document.setCreationDate(new Date(report.generatedAt))
  document.setModificationDate(new Date(report.generatedAt))
  const layout = new PdfReportLayout(document, fonts, '', limits)
  writeDocumentReport(layout, report, options)
  layout.finish()
  const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false })
  layout.checkTime()
  if (Date.now() - startedAt > limits.maxGenerationMilliseconds) {
    throw new Error('PDF generation exceeded the report time limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.')
  }
  if (bytes.byteLength > limits.maxOutputBytes) {
    throw new Error(`PDF exceeds the ${limits.maxOutputBytes.toLocaleString('en-US')}-byte output resource limit. Narrow the export to one exact job/grade target; no comparisons or evidence have been omitted.`)
  }
  return bytes
}
