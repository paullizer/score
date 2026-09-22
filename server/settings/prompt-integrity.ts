import { createHash } from 'node:crypto'
import {
  PROMPT_FAMILIES, promptBundleRevisionSchema, promptBundleSnapshotSchema, promptRevisionReferenceSchema, promptRevisionSchema,
  promptExecutionProvenanceSchema,
  type PromptBundleRevision, type PromptBundleSnapshot, type PromptExecutionProvenance, type PromptFamily,
  type PromptRevision, type PromptRevisionReference,
} from '../../src/domain/prompt-versions'

export function promptTextHash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
export function promptObjectHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]))
      : item
  return promptTextHash(JSON.stringify(canonical(value)))
}
export function promptRevisionReference(revision: PromptRevision): PromptRevisionReference {
  const { revisionId, contentSha256, templateVersion, templateSha256, outputSchemaVersion, rendererVersion } = revision
  return promptRevisionReferenceSchema.parse({ revisionId, contentSha256, templateVersion, templateSha256, outputSchemaVersion, rendererVersion })
}
export function promptRevisionContentHash(revision: Omit<PromptRevision, 'contentSha256'> | PromptRevision): string {
  const { family, templateVersion, templateSha256, outputSchemaVersion, rendererVersion, guidance, guidanceSha256 } = revision
  return promptObjectHash({ family, templateVersion, templateSha256, outputSchemaVersion, rendererVersion, guidance, guidanceSha256 })
}
export function promptBundleContentHash(bundle: Pick<PromptBundleRevision, 'revisions'>): string {
  return promptObjectHash({ schemaVersion: 1, revisions: bundle.revisions })
}
export function validatePromptRevision(value: unknown): PromptRevision {
  const revision = promptRevisionSchema.parse(value)
  if (revision.guidanceSha256 !== promptTextHash(revision.guidance ?? '') ||
    revision.contentSha256 !== promptRevisionContentHash(revision)) throw new Error('The immutable prompt revision failed content integrity validation.')
  return revision
}
export function validatePromptBundle(value: unknown): PromptBundleRevision {
  const bundle = promptBundleRevisionSchema.parse(value)
  if (bundle.bundleSha256 !== promptBundleContentHash(bundle) ||
    new Set(PROMPT_FAMILIES.map(family => bundle.revisions[family].revisionId)).size !== PROMPT_FAMILIES.length) {
    throw new Error('The immutable prompt bundle failed content integrity validation.')
  }
  return bundle
}
export function validatePromptSnapshot(value: unknown): PromptBundleSnapshot {
  const snapshot = promptBundleSnapshotSchema.parse(value)
  validatePromptBundle(snapshot.bundle)
  for (const family of PROMPT_FAMILIES) validatePromptRevision(snapshot.revisions[family])
  return snapshot
}

export function assertAcceptedPromptBinding(
  provenance: PromptExecutionProvenance | undefined, capture: PromptBundleSnapshot | undefined, family: PromptFamily,
): void {
  if (!capture) {
    if (provenance) throw new Error('Legacy work cannot claim an uncaptured prompt selection.')
    return
  }
  validatePromptSnapshot(capture)
  const pin = promptExecutionProvenanceSchema.parse(provenance)
  const expected = capture.bundle.revisions[family]
  if (pin.family !== family || pin.bundleId !== capture.bundle.bundleId || pin.bundleSha256 !== capture.bundle.bundleSha256 ||
    Object.keys(expected).some(key => expected[key as keyof PromptRevisionReference] !== pin[key as keyof PromptRevisionReference])) {
    throw new Error('Model prompt provenance differs from the exact accepted work selection.')
  }
}
