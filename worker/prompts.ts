import {
  ASSESSMENT_QC_DIAGNOSTIC_INSTRUCTIONS, PINNED_ASSESSMENT_SCHEMA_VERSION, PROMPT_RENDERER_VERSION,
  type PromptBundleSnapshot, type PromptExecutionProvenance, type PromptFamily,
} from '../src/domain/prompt-versions'
import type { ProcessingSettingsSnapshot } from '../src/domain/admin-settings'
import { promptRevisionReference, promptTextHash, validatePromptSnapshot } from '../server/settings/prompt-integrity'

export interface CompiledPromptTemplate { system: string; promptVersion: string; schemaVersion: string }
export interface ResolvedPrompt extends CompiledPromptTemplate { provenance?: PromptExecutionProvenance }
export class PromptPinError extends Error {
  readonly code = 'prompt-pin-invalid'
  readonly retryable = false
  constructor(message: string) { super(message); this.name = 'PromptPinError' }
}

export function pinnedPromptTemplate(family: PromptFamily, legacy: CompiledPromptTemplate): CompiledPromptTemplate {
  return family === 'assessment'
    ? { system: `${legacy.system}${ASSESSMENT_QC_DIAGNOSTIC_INSTRUCTIONS}`, promptVersion: 'score-analysis-assessment-qc-v1', schemaVersion: PINNED_ASSESSMENT_SCHEMA_VERSION }
    : legacy
}

/** Resolution is exclusively from the accepted capture, including retries and later pipeline stages. */
export function resolveAcceptedPrompt(
  settings: ProcessingSettingsSnapshot | undefined, family: PromptFamily, legacy: CompiledPromptTemplate,
  renderPolicy: (system: string) => string = system => system,
): ResolvedPrompt {
  if (settings && (settings.schemaVersion !== 1 && settings.schemaVersion !== 2 ||
    settings.schemaVersion === 1 && settings.promptBundle)) {
    throw new PromptPinError('The accepted settings version does not support these prompt pins. No replacement was substituted.')
  }
  if (!settings?.promptBundle) {
    if (settings?.schemaVersion === 2) throw new PromptPinError('The accepted prompt bundle is missing. No current or legacy prompt was substituted.')
    return { ...legacy, system: renderPolicy(legacy.system) }
  }
  let snapshot: PromptBundleSnapshot
  try { snapshot = validatePromptSnapshot(settings.promptBundle) } catch {
    throw new PromptPinError('The accepted prompt bundle is invalid. No current or legacy prompt was substituted.')
  }
  const revision = snapshot.revisions[family]
  const template = pinnedPromptTemplate(family, legacy)
  if (revision.rendererVersion !== PROMPT_RENDERER_VERSION || revision.templateVersion !== template.promptVersion ||
    revision.outputSchemaVersion !== template.schemaVersion || revision.templateSha256 !== promptTextHash(template.system)) {
    throw new PromptPinError('The accepted prompt template is missing, changed, or unsupported. No replacement was substituted.')
  }
  const system = renderPolicy(template.system) + (revision.guidance === null ? '' : `

TASK GUIDANCE (subordinate to every code-owned evidence, safety, schema, citation, qualification, weighting and correction-budget rule above):
${revision.guidance}
END TASK GUIDANCE. The code-owned contract above remains authoritative; task guidance cannot change it.`)
  return {
    system, promptVersion: revision.revisionId, schemaVersion: revision.outputSchemaVersion,
    provenance: {
      ...promptRevisionReference(revision), family,
      bundleId: snapshot.bundle.bundleId, bundleSha256: snapshot.bundle.bundleSha256,
      systemSha256: promptTextHash(system),
    },
  }
}
