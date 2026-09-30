import { z } from 'zod'
import { REPORT_LIMITS } from '../../domain/analysis-reports'
import { normalizeDisplayName } from '../../domain/displayNames'
import { RUBRIC_EXPORT_SCHEMA_VERSION, type RubricExportPayload } from '../../domain/rubric-exports'
import { reportSettingsCaptureSchema } from './policy'

const id = z.string().min(1).max(1024).refine(value => value === value.trim(), 'Identity must not contain surrounding whitespace.')
const text = z.string().max(REPORT_LIMITS.maxTextCharacters)
const requiredText = text.refine(value => value.trim().length > 0, 'Saved text must not be empty.')
const displayName = z.string().refine((value) => {
  try { return normalizeDisplayName(value) === value }
  catch { return false }
}, 'Saved display names must be normalized, nonempty, single-line text of at most 160 characters.')
const timestamp = z.iso.datetime({ offset: true })
const version = z.number().int().min(1)

const citation = z.strictObject({ page: z.number().int().nonnegative(), heading: text, quote: requiredText })
const criterion = z.strictObject({
  label: requiredText, description: requiredText, weight: z.number().finite().gt(0).max(100), guidance: requiredText,
  requirementType: z.enum(['required', 'preferred']),
  citations: z.array(citation).min(1).max(REPORT_LIMITS.maxCitationsPerAssessment),
})

/** Exactly what the rubric-export route returns. Unknown fields fail closed. */
export const rubricExportPayloadSchema: z.ZodType<RubricExportPayload> = z.strictObject({
  schemaVersion: z.literal(RUBRIC_EXPORT_SCHEMA_VERSION),
  dataKind: z.literal('real'),
  workspaceId: id,
  generatedAt: timestamp,
  settings: reportSettingsCaptureSchema,
  job: z.strictObject({
    id, title: requiredText, displayName: displayName.optional(), organization: text, location: text, arrangement: text,
    employmentType: text, grade: text, series: text, sourceLabel: text,
    pagination: z.enum(['pdf-pages', 'html-sections', 'markdown-sections', 'captured-sections']),
  }),
  rubric: z.strictObject({
    id, version, latestVersion: version, name: requiredText, description: text, createdAt: timestamp,
    provenance: z.enum(['generated', 'edited']),
    criteria: z.array(criterion).min(1).max(REPORT_LIMITS.maxCriteriaPerTarget),
  }).refine(rubric => rubric.version <= rubric.latestVersion, 'The exported rubric version must not be newer than the latest version.'),
})
