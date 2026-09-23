import { MODEL_TASK_IDS } from './admin-settings-tasks'
import type { SettingsFieldMetadata, SettingsSection } from './admin-settings'
import { createDefaultAdminSettings, TASK_MODEL_LIMITS } from './admin-settings-defaults'
import { ADMIN_SETTINGS_STORAGE_LIMITS } from './admin-settings-limits'

const defaults = createDefaultAdminSettings()
const fields: SettingsFieldMetadata[] = []
const MIB = 1024 * 1024
const storageBounds = `All settings combined must fit ${ADMIN_SETTINGS_STORAGE_LIMITS.maxSettingsBytes} serialized UTF-8 bytes; each complete resolved snapshot must fit ${ADMIN_SETTINGS_STORAGE_LIMITS.maxSnapshotBytes} bytes. Oversized drafts are rejected, not truncated.`
function defaultValue(path: string): unknown {
  let value: unknown = defaults
  for (const part of path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
  return structuredClone(value)
}
function field(
  path: string, label: string, section: SettingsSection,
  control: SettingsFieldMetadata['control'], description: string,
  options: Partial<SettingsFieldMetadata> = {},
) {
  fields.push({
    path, label, section, control, description, classification: 'recommended',
    activation: 'new-operation', prerequisites: [], defaultValue: defaultValue(path),
    defaultSource: 'compiled-default', source: 'application-revision', scope: 'application', ...options,
  })
}
function number(path: string, label: string, section: SettingsSection, max: number, units: string, advanced = true, min = 1, description = '') {
  field(path, label, section, 'number', description || `Operating limit in ${units}; bounded by Score's compiled safety ceiling. Existing accepted work keeps its captured policy.`, {
    min, max, units, classification: advanced ? 'advanced' : 'recommended',
  })
}
function select(path: string, label: string, section: SettingsSection, options: string[], description: string) {
  field(path, label, section, 'select', description, { options })
}

field('ai.deployments', 'Azure deployments', 'ai', 'deployments', `Actual deployments in the one configured Azure resource. Discovery and compatibility metadata are read-only; this catalog never provisions a model. ${storageBounds}`)
field('ai.defaultDeploymentId', 'Application default deployment', 'ai', 'select', 'An enabled compatible Azure deployment; task overrides inherit this choice only when explicitly blank.')
for (const task of MODEL_TASK_IDS) {
  const prefix = `ai.tasks.${task}`
  field(`${prefix}.deploymentId`, `${task}: deployment`, 'ai', 'select', 'Blank inherits the application default. The resolved deployment is frozen when new work is accepted.')
  field(`${prefix}.reasoningEffort`, `${task}: reasoning effort`, 'ai', 'select', 'Blank omits the parameter. Select only an effort supported by this deployment.')
  number(`${prefix}.completionTokenLimit`, `${task}: completion budget`, 'ai', TASK_MODEL_LIMITS[task].completionTokenLimit, 'tokens')
  field(`${prefix}.inputBudget.unit`, `${task}: input unit`, 'ai', 'select', 'Task adapter-owned units; bytes, characters and tokens are not interchangeable.', { classification: 'read-only' })
  number(`${prefix}.inputBudget.maxInput`, `${task}: context allowance`, 'ai', TASK_MODEL_LIMITS[task].inputBudget.maxInput, TASK_MODEL_LIMITS[task].inputBudget.unit)
  number(`${prefix}.inputBudget.maxRequest`, `${task}: full request allowance`, 'ai', TASK_MODEL_LIMITS[task].inputBudget.maxRequest, TASK_MODEL_LIMITS[task].inputBudget.unit, true, 1,
    'Includes complete prompt and schema, with separate completion/token reserve. Oversized complete evidence fails rather than being silently truncated.')
  number(`${prefix}.inputBudget.reservedTokens`, `${task}: token reserve`, 'ai', 16_384, 'tokens', true, 2048)
  number(`${prefix}.temperature`, `${task}: temperature`, 'ai', 2, 'sampling parameter', true, 0, 'Blank omits the parameter. Unsupported models reject it; do not combine with top-p.')
  number(`${prefix}.topP`, `${task}: top-p`, 'ai', 1, 'sampling probability (exclusive minimum 0)', true, 0, 'Blank omits the parameter. Must be greater than zero; do not combine with temperature.')
}
// features.samplesVisible is retired: it stays in the strict schema so stored revisions still parse, but has no form field.
for (const key of ['jobImports', 'resumeImports', 'gradeLadders', 'newAnalyses', 'summaryGeneration']) {
  field(`features.${key}`, key.replace(/([A-Z])/g, ' $1'), 'intake', 'boolean', 'Policy does not enable unprovisioned services or bypass rollout verification; disabling new work never hides historical evidence.')
}
field('maintenance.pauseNewWork', 'Pause new work', 'intake', 'boolean', 'Stops new imports, ladder generations, analyses and summaries, not accepted work, reads, cleanup or cancellation.')
field('maintenance.explanation', 'Maintenance explanation', 'intake', 'text', 'Optional plain-text explanation.', { max: 1000 })
for (const kind of ['jobs', 'resumes'] as const) {
  const prefix = `imports.${kind}`
  field(`${prefix}.allowedFormats`, `${kind}: file formats`, 'intake', 'multiselect', 'Intersected with verified PDF/Markdown/Word deployment capabilities. Empty disables new file intake.', { options: ['pdf', 'markdown', 'docx', 'doc'] })
  field(`${prefix}.allowUrls`, `${kind}: public URLs`, 'intake', 'boolean', 'Public HTML/PDF only; does not enable crawling, credentials or private-network access.')
  number(`${prefix}.maxFileBytes`, `${kind}: maximum file size`, 'intake', 10 * MIB, 'bytes (display MiB)', false)
  number(`${prefix}.maxBatchItems`, `${kind}: batch size`, 'intake', 10, 'items', false)
  number(`${prefix}.maxPdfPages`, `${kind}: PDF pages`, 'intake', 50, 'physical PDF pages', false)
  number(`${prefix}.maxSourceCharacters`, `${kind}: source text`, 'intake', 180_000, 'normalized characters')
}
field('imports.urls.requireHttps', 'Require HTTPS imports', 'intake', 'boolean', 'Adds an HTTPS-only policy. Public-address, standard-port and redirect checks always remain required.', { classification: 'advanced' })
for (const scope of ['jobs', 'resumes', 'agencyReferences']) for (const list of ['allowedHosts', 'blockedHosts']) {
  field(`imports.urls.${scope}.${list}`, `${scope}: ${list}`, 'intake', 'host-rules', `Hostname plus explicit subdomain matching. Block wins; an empty allowlist adds no restriction. Applies to redirects and rendered subresources. ${storageBounds}`, { classification: 'advanced' })
}
number('imports.urls.timeoutMilliseconds', 'URL deadline', 'intake', 30_000, 'milliseconds', true, 1000)
number('imports.urls.maxResponseBytes', 'General URL response budget', 'intake', 12 * MIB, 'bytes', true, 1,
  'Per-response budget for job/resume URLs and rendered subresources. Reference originals use the separate Reference PDF size limit; shared host, HTTPS, deadline and redirect policies still apply.')
number('imports.urls.maxRedirects', 'URL redirect bound', 'intake', 5, 'redirects', true, 0)
field('documents.formattedDocxPreviewEnabled', 'Formatted DOCX previews', 'intake', 'boolean', 'Independent of new Word admissions; extracted text remains available. Requires permission to access original bytes.')
for (const [key, label, max, units, advanced] of [
  ['maxSources', 'Supporting references', 15, 'sources', false],
  ['maxPdfBytes', 'Reference PDF size', 20 * MIB, 'bytes', false],
  ['maxSelectedPages', 'Selected pages per PDF', 250, 'PDF pages', false],
  ['maxTotalSelectedPages', 'Total selected pages', 500, 'PDF pages', false],
  ['maxSourceCharacters', 'Reference source text', 2_000_000, 'normalized characters', true],
  ['pdfChunkPages', 'PDF extraction chunk', 50, 'PDF pages', true],
  ['maxLinks', 'Reference links', 2000, 'links', true],
] as const) number(`grades.references.${key}`, label, 'grades', max, units, advanced)
for (const key of ['allowAgencyUploads', 'allowAgencyUrls']) field(`grades.references.${key}`, key, 'grades', 'boolean', 'Controls new supplemental agency evidence; never makes agency evidence an OPM authority.')
number('grades.maxCriteria', 'Criteria per grade', 'grades', 20, 'criteria', false)
field('grades.allowedLevels', 'Allowed GS levels', 'grades', 'levels', 'Nonempty subset of GS-1 through GS-15 for new generation; historical grades remain readable.')
field('grades.defaults.levels', 'Initially selected GS levels', 'grades', 'levels', 'Empty or a subset of allowed levels; creators review every request.')
field('grades.defaults.agency', 'Default agency', 'grades', 'text', 'Does not override captured source facts or confirm context.', { max: 300 })
field('grades.defaults.specialty', 'Default specialty', 'grades', 'text', 'Does not override captured source facts or confirm context.', { max: 1000 })
select('grades.defaults.agencyType', 'Default agency type', 'grades', ['dod', 'other-federal', 'non-federal', 'unknown'], 'A form default, never source confirmation.')
select('grades.defaults.supervision', 'Default supervision', 'grades', ['nonsupervisory', 'supervisor', 'leader', 'unknown'], 'A form default, never source confirmation.')
field('grades.defaults.functions', 'Default functions', 'grades', 'multiselect', 'A form default, never source confirmation.', { options: ['research', 'development', 'test-evaluation'] })
number('grades.discovery.maxHops', 'Discovery hops', 'grades', 2, 'hops', true, 0)
number('grades.discovery.maxRequests', 'Discovery requests', 'grades', 80, 'requests')
number('grades.discovery.maxDocuments', 'Discovery documents', 'grades', 35, 'documents')
number('grades.discovery.maxBytes', 'Discovery aggregate size', 'grades', 64 * MIB, 'bytes')
number('rubrics.jobs.maxCriteria', 'Job rubric criteria', 'processing', 20, 'criteria', false)
number('analyses.maxComparisons', 'Analysis comparisons', 'processing', 500, 'resume/target pairs', false)
number('analyses.maxOutputCorrections', 'Shared assessment correction budget', 'processing', 2, 'corrections', true, 0, 'Shared across assessment, review-format correction and reassessment. A stage transition never resets the budget.')
for (const kind of ['jobRubric', 'resumeProfile', 'grades']) number(`ai.${kind}.maxOutputCorrections`, `${kind}: output repairs`, 'processing', 1, 'corrections', true, 0)
for (const kind of ['jobs', 'grades', 'resumes', 'analyses', 'qc'] as const) {
  number(`processing.${kind}.maxAutomaticAttempts`, `${kind}: automatic attempts`, 'processing', 3, 'total attempts, including the initial attempt')
  number(`processing.${kind}.retryBackoff.baseMilliseconds`, `${kind}: retry base`, 'processing', defaults.processing[kind].retryBackoff.baseMilliseconds, 'milliseconds', true, 1000)
  number(`processing.${kind}.retryBackoff.maxMilliseconds`, `${kind}: retry cap`, 'processing', defaults.processing[kind].retryBackoff.maxMilliseconds, 'milliseconds', true, 1000)
  number(`workers.${kind}.maxItemsPerExecution`, `${kind}: execution items`, 'operations', kind === 'analyses' ? 100 : kind === 'qc' ? 10 : 20, 'work items')
  number(`workers.${kind}.budgetMilliseconds`, `${kind}: execution budget`, 'operations', 660_000, 'milliseconds', true, 1000)
  field(`workers.${kind}.pauseClaiming`, `${kind}: pause claiming`, 'operations', 'boolean', 'Stops new claims at execution/claim boundaries; does not cancel accepted or already claimed work.', { classification: 'advanced', activation: 'next-execution' })
}
select('summaries.generationMode', 'Summary generation mode', 'processing', ['automatic', 'on-demand'], 'On-demand retains explicit Manage summaries actions. Importing never starts scoring.')
number('summaries.maxRounds', 'Summary generate/review rounds', 'processing', 3, 'total rounds')
field('summaries.allowManualPublication', 'Allow manual summary publication', 'access', 'boolean', 'Only exact saved drafts with required disclosure; does not remove historical published text.')
for (const key of ['manualPublicationRoles', 'historyRoles']) select(`summaries.${key}`, `Summary ${key}`, 'access', ['owner', 'owner-and-editor'], 'Effective workspace roles; application administrators have Owner-equivalent access. Readers cannot view private summary history or unpublished drafts.')
number('summaries.historyPageSize', 'Summary history page size', 'processing', 12, 'attempts per page')
number('summaries.operationTimeoutMilliseconds', 'Summary operation deadline', 'processing', 600_000, 'milliseconds', true, 1000)
number('ai.transport.maxAttempts', 'Model transport attempts', 'processing', 2, 'total transport attempts')
number('ai.requestTimeoutMilliseconds', 'Model request timeout', 'processing', 60_000, 'milliseconds', true, 1000)
number('extraction.transport.maxAttempts', 'Extraction submission attempts', 'processing', 3, 'total attempts')
number('extraction.pollTimeoutMilliseconds', 'Extraction polling deadline', 'processing', 240_000, 'milliseconds', true, 1000)
for (const [key, max, units, min] of [
  ['timeoutMilliseconds', 30_000, 'milliseconds', 1000], ['settleMilliseconds', 2000, 'milliseconds', 0],
  ['maxRequests', 80, 'requests', 1], ['maxAggregateBytes', 8 * MIB, 'bytes', 1], ['maxDomBytes', 2 * MIB, 'bytes', 1],
] as const) number(`rendering.${key}`, `Hosted renderer ${key}`, 'operations', max, units, true, min)
for (const key of ['jobsMilliseconds', 'otherProcessingMilliseconds']) number(`ui.polling.${key}`, `UI polling ${key}`, 'presentation', 60_000, 'milliseconds', true, 1000, 'UI refresh only; does not schedule or stop worker processing.')
field('reports.enabledFormats', 'Report formats', 'presentation', 'multiselect', 'Empty disables official exports; does not prevent authorized readers copying information.', { options: ['csv', 'pdf', 'docx', 'pptx'] })
select('reports.defaultFormat', 'Default report format', 'presentation', ['csv', 'pdf', 'docx', 'pptx'], 'One enabled format, or blank when all formats are disabled.')
number('reports.highlightCount', 'Report highlight count', 'presentation', 10, 'comparisons per exact target', false)
number('reports.maxHighlights', 'Report maximum highlights', 'presentation', 10, 'comparisons including cutoff ties', false)
field('reports.title', 'Report title', 'presentation', 'text', 'Additive presentation only; captured identity and human-review disclosures remain.', { max: 200 })
field('reports.additionalFooter', 'Additional report footer', 'presentation', 'text', 'Optional plain text; cannot replace mandatory disclosures.', { max: 2000 })
for (const [key, max, units, min] of [
  ['maxComparisons', 500, 'comparisons', 1], ['batchComparisons', 25, 'comparisons per read', 1],
  ['maxConcurrentBatches', 3, 'read batches', 1], ['maxInputBytes', 32 * MIB, 'bytes', 1],
  ['maxOutputBytes', 64 * MIB, 'bytes', 1], ['maxGenerationMilliseconds', 180_000, 'milliseconds', 1000],
  ['maxPages', 10_000, 'pages', 1], ['maxSlides', 10_000, 'slides', 1],
] as const) number(`reports.${key}`, `Report ${key}`, 'presentation', max, units, true, min)
for (const path of ['reports.allowedRoles', 'documents.originalDownloadRoles']) field(path, path === 'reports.allowedRoles' ? 'Official export roles' : 'Original download roles', 'access', 'multiselect', 'Restricts existing authorized workspace readers only. Empty disables the action; never grants workspace access.', { options: ['owner', 'editor', 'viewer', 'reviewer'] })
field('appearance.applicationTitle', 'Application title', 'presentation', 'text', 'Navigation/browser title; does not rename saved records.', { max: 80 })
select('appearance.defaultTheme', 'Default theme', 'presentation', ['system', 'light', 'dark'], 'Only for users without a saved preference. Host and personal preferences retain precedence.')
select('navigation.defaultPage', 'Workspace start page', 'presentation', ['jobs', 'resumes', 'rubrics', 'analyses'], 'Opened after choosing a workspace. App entry shows workspace home; explicit deep links win.')
field('appearance.announcement.enabled', 'Show announcement', 'presentation', 'boolean', 'Informational, independent of pausing work.')
field('appearance.announcement.text', 'Announcement text', 'presentation', 'text', 'Plain text, not HTML.', { max: 2000 })
select('appearance.announcement.tone', 'Announcement tone', 'presentation', ['info', 'warning'], 'Accessible informational or warning presentation.')
for (const path of ['help.supportUrl', 'help.documentationUrl']) field(path, path === 'help.supportUrl' ? 'Support URL' : 'Documentation URL', 'presentation', 'text', 'Optional HTTPS link without credentials. Blank hides the link.', { max: 2048 })
field('workspaces.allowCreation', 'Allow workspace creation', 'access', 'boolean', 'Applies to explicit creation and first-session bootstrap; existing workspaces and administrator access remain.')
field('diagnostics.capturePrivateFailures', 'Capture private failure diagnostics', 'access', 'boolean', 'New diagnostic artifacts only. Existing history remains; routine error metadata is retained.', { classification: 'advanced' })
select('logging.detail', 'Operational logging detail', 'operations', ['normal', 'diagnostic-metadata'], 'Allowlisted safe metadata only. Never source text, quotations, model output, personal URLs or secrets.')
for (const item of fields) {
  if (item.path.startsWith('workers.')) item.activation = 'next-execution'
  if (['appearance.', 'navigation.', 'help.', 'ui.'].some(prefix => item.path.startsWith(prefix))) item.activation = 'next-refresh'
  if (item.path === 'logging.detail') item.classification = 'advanced'
  if (item.path.startsWith('ai.tasks.') || item.path === 'ai.defaultDeploymentId') {
    item.prerequisites = ['Enabled deployment in the fixed Azure resource', 'Supported strict structured output and complete-request capacity']
    if (item.path.endsWith('.reasoningEffort')) item.prerequisites.push('The selected deployment supports the chosen reasoning effort')
    if (item.path.endsWith('.temperature')) item.prerequisites.push('The selected deployment supports temperature; top-p is unset')
    if (item.path.endsWith('.topP')) item.prerequisites.push('The selected deployment supports top-p; temperature is unset')
  }
  if (item.path.startsWith('features.')) item.prerequisites = ['Corresponding deployed services are available', 'New-work admission is not paused']
  if (item.path.endsWith('.allowedFormats')) item.prerequisites = ['Corresponding import services are available', 'DOCX/DOC require verified Word rollout capability']
  if (item.path === 'documents.formattedDocxPreviewEnabled') item.prerequisites = ['The reader has an allowed original-download workspace role']
  if (item.path === 'summaries.allowManualPublication') item.prerequisites = ['Exact saved draft and required disclosure', 'Authorized source-workspace role']
  if (item.path.startsWith('workers.') || item.path.startsWith('rendering.')) item.prerequisites = ['Compatible deployed policy-consuming worker/renderer', 'Runtime settings activation is enabled']
}
export const ADMIN_SETTINGS_FIELDS: SettingsFieldMetadata[] = fields
