import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { processingSettingsSnapshotSchema, type ProcessingSettingsSnapshot } from '../../src/domain/admin-settings'
import {
  EDITABLE_PROMPT_FAMILIES, PROMPT_FAMILIES, PROMPT_REGISTRY_LIMITS, PROMPT_RENDERER_VERSION,
  promptActivationSchema, promptActorSchema, promptBundleSnapshotSchema, promptEvaluationReferenceSchema,
  promptGuidanceDraftSchema, promptHashSchema, promptIdentifierSchema,
  type CurrentPromptBundle, type PromptActivation, type PromptActor, type PromptBundleRevision, type PromptBundleSnapshot,
  type PromptFamily, type PromptGuidanceDraft, type PromptHistoryPage, type PromptRevision, type PublishedPromptBundle,
} from '../../src/domain/prompt-versions'
import { JOB_RUBRIC_COMPILED_PROMPT } from '../../worker/runtime'
import { GRADE_COMPILED_PROMPTS } from '../../worker/grades/model'
import { ANALYSIS_COMPILED_PROMPTS } from '../../worker/analyses/model'
import { pinnedPromptTemplate, type CompiledPromptTemplate } from '../../worker/prompts'
import { isApplicationAdmin, type AuthenticatedPrincipal } from '../auth'
import type { Config } from '../config'
import { conflict, forbidden, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
import { StoreConflictError } from '../store'
import {
  promptBundleContentHash, promptObjectHash, promptRevisionContentHash, promptRevisionReference, promptTextHash,
  validatePromptBundle, validatePromptRevision, validatePromptSnapshot,
} from './prompt-integrity'
import type { PromptPublicationGuard, PromptRegistryReader, PromptRegistryStore } from './prompt-store'

export { createAzurePromptStore, createAzurePromptReader, createPromptStoreFromContainer, createPromptReaderFromContainer } from './prompt-azure-store'
export type { PromptPublicationGuard, PromptRegistryReader, PromptRegistryStore } from './prompt-store'
export { promptObjectHash, promptTextHash, validatePromptBundle, validatePromptRevision, validatePromptSnapshot } from './prompt-integrity'
export type * from '../../src/domain/prompt-versions'

const templates: Record<PromptFamily, CompiledPromptTemplate> = {
  jobRubric: JOB_RUBRIC_COMPILED_PROMPT, ...GRADE_COMPILED_PROMPTS, ...ANALYSIS_COMPILED_PROMPTS,
}
const baselineGuidance = {
  jobRubric: 'Organize the actual posting into distinct professional work criteria. Preserve role-specific requirements and use concrete documentary evidence anchors rather than generic skill labels.',
  gradeCompetencies: 'Align a concise common competency structure to the frozen role and source context. Keep competency meanings stable across requested grades without assuming unsupported grade distinctions.',
  gradeDraft: 'Explain the work-level meaning of the cited sources clearly. Distinguish scope, responsibility and complexity under the requested grade while preserving all source limitations.',
  assessment: 'Apply each exact saved criterion and its documentary evidence anchors consistently. Explain the decisive evidence and any genuine borderline interpretation, without treating silence as personal inability.',
} as const

const draftInputSchema = z.strictObject({
  baseBundleId: promptIdentifierSchema, baseBundleSha256: promptHashSchema,
  guidance: promptGuidanceDraftSchema,
  /** An explicit review assertion, not automated copying of private review/source prose. */
  generalized: z.literal(true),
})
const activateInputSchema = z.strictObject({
  bundleId: promptIdentifierSchema, bundleSha256: promptHashSchema,
  reason: z.string().min(1).max(PROMPT_REGISTRY_LIMITS.reasonCharacters).regex(/\S/),
  evaluation: promptEvaluationReferenceSchema,
  /** Exact privately evaluated candidate, for read-only QC workers that cannot write global revisions. */
  candidate: promptBundleSnapshotSchema.optional(),
})
const restoreInputSchema = z.strictObject({
  bundleId: promptIdentifierSchema, requestId: promptIdentifierSchema,
  reason: z.string().min(1).max(PROMPT_REGISTRY_LIMITS.reasonCharacters).regex(/\S/),
})
export type CreatePromptDraftInput = z.infer<typeof draftInputSchema>
export type ActivatePromptBundleInput = z.infer<typeof activateInputSchema>
export interface PromptRegistryCapture { capture(bundleId?: string): Promise<PromptBundleSnapshot> }
export interface PromptRegistryServiceDeps {
  store: PromptRegistryStore
  config?: Pick<Config, 'tenantId'>
  /** Source-plan membership, exact evaluated plan pins and peer visibility remain the route's responsibility. */
  authorizeActivation?: (principal: AuthenticatedPrincipal) => boolean | Promise<boolean>
  now?: () => Date
  newId?: () => string
}

function assertExactEtag(ifMatch: string | undefined): asserts ifMatch is string {
  if (!ifMatch) throw preconditionRequired('An exact If-Match prompt pointer ETag is required.')
  if (ifMatch === '*' || ifMatch.startsWith('W/') || ifMatch.includes(',') || ifMatch.trim() !== ifMatch) {
    throw invalidRequest('Use one exact prompt pointer ETag, not a wildcard, weak ETag, or list.')
  }
}

function createRevision(
  family: PromptFamily, revisionId: string, createdAt: string, actor: PromptActor, guidance: string | null,
  parentRevisionId: string | null,
): PromptRevision {
  const template = pinnedPromptTemplate(family, templates[family])
  const content = {
    schemaVersion: 1 as const, family, revisionId, createdAt, actor, parentRevisionId, guidance,
    guidanceSha256: promptTextHash(guidance ?? ''), rendererVersion: PROMPT_RENDERER_VERSION,
    templateVersion: template.promptVersion, templateSha256: promptTextHash(template.system), outputSchemaVersion: template.schemaVersion,
  }
  return validatePromptRevision({ ...content, contentSha256: promptRevisionContentHash(content) })
}
function createBundle(
  bundleId: string, createdAt: string, actor: PromptActor, parentBundleId: string | null,
  revisions: Record<PromptFamily, PromptRevision>,
): PromptBundleRevision {
  const content = {
    schemaVersion: 1 as const, bundleId, createdAt, actor, parentBundleId,
    revisions: Object.fromEntries(PROMPT_FAMILIES.map(family => [family, promptRevisionReference(revisions[family])])) as PromptBundleRevision['revisions'],
  }
  return validatePromptBundle({ ...content, bundleSha256: promptBundleContentHash(content) })
}

/** Used only after a confirmed absent active pointer; deployment never repoints an existing registry. */
export function createCompiledPromptBaseline(createdAt = '2026-09-22T00:00:00.000Z'): PromptBundleSnapshot {
  const actor = { system: 'initialization' } as const
  const revisions = Object.fromEntries(PROMPT_FAMILIES.map(family => [family, createRevision(
    family, `pr-baseline-${family}-v1`, createdAt, actor,
    (EDITABLE_PROMPT_FAMILIES as readonly string[]).includes(family) ? baselineGuidance[family as keyof typeof baselineGuidance] : null,
    null,
  )])) as Record<PromptFamily, PromptRevision>
  return validatePromptSnapshot({
    schemaVersion: 1, revisions, bundle: createBundle('pb-baseline-v1', createdAt, actor, null, revisions),
  })
}
function assertSupported(snapshot: PromptBundleSnapshot): PromptBundleSnapshot {
  validatePromptSnapshot(snapshot)
  for (const family of PROMPT_FAMILIES) {
    const template = pinnedPromptTemplate(family, templates[family])
    const revision = snapshot.revisions[family]
    if (revision.templateVersion !== template.promptVersion || revision.templateSha256 !== promptTextHash(template.system) ||
      revision.outputSchemaVersion !== template.schemaVersion) throw unavailable('The selected immutable prompt renderer or schema is unsupported; no replacement was used.')
  }
  return snapshot
}

/** Pure deterministic construction for private QC checkpoints; no global write or activation. */
export function createPromptCandidate(
  baseline: PromptBundleSnapshot, guidance: PromptGuidanceDraft, actor: PromptActor, createdAt: string, bundleId: string,
): PromptBundleSnapshot {
  assertSupported(baseline)
  const changes = promptGuidanceDraftSchema.parse(guidance)
  promptActorSchema.parse(actor)
  promptIdentifierSchema.parse(bundleId)
  if ('system' in actor || bundleId === baseline.bundle.bundleId) {
    throw invalidRequest('A candidate needs an attributable principal and a new immutable bundle identity.')
  }
  const revisions = structuredClone(baseline.revisions)
  let changed = false
  for (const family of EDITABLE_PROMPT_FAMILIES) {
    const next = changes[family]
    if (next === undefined || next === revisions[family].guidance) continue
    const revisionId = `pr-${family}-${promptObjectHash({ bundleId, family, guidance: next })}`
    revisions[family] = createRevision(family, revisionId, createdAt, actor, next, revisions[family].revisionId)
    changed = true
  }
  if (!changed) throw invalidRequest('A candidate must change at least one editable task-guidance family.')
  return assertSupported(validatePromptSnapshot({
    schemaVersion: 1, revisions, bundle: createBundle(bundleId, createdAt, actor, baseline.bundle.bundleId, revisions),
  }))
}

/** Changes only prompt pins; evaluation retains the exact captured model and processing settings. */
export function createPromptCandidateSettings(
  baseline: ProcessingSettingsSnapshot, guidance: PromptGuidanceDraft, actor: PromptActor, createdAt: string, bundleId: string,
): ProcessingSettingsSnapshot {
  processingSettingsSnapshotSchema.parse(baseline)
  if (baseline.schemaVersion !== 2 || !baseline.promptBundle) {
    throw invalidRequest('Candidate evaluation requires a complete accepted baseline prompt capture.')
  }
  const candidate = {
    ...structuredClone(baseline),
    promptBundle: createPromptCandidate(baseline.promptBundle, guidance, actor, createdAt, bundleId),
  }
  processingSettingsSnapshotSchema.parse(candidate)
  return candidate
}

/** Read-only workers may resolve retained published/candidate revisions, but never initialize or activate. */
export async function readPromptBundleSnapshot(reader: PromptRegistryReader, bundleId?: string): Promise<PromptBundleSnapshot> {
  if (bundleId !== undefined) promptIdentifierSchema.parse(bundleId)
  const bundle = bundleId === undefined ? (await reader.getCurrent())?.bundle : await reader.getBundle(bundleId)
  if (!bundle) throw unavailable('The requested immutable prompt bundle is unavailable; a read-only reader cannot initialize it.')
  validatePromptBundle(bundle)
  if (bundleId !== undefined && bundle.bundleId !== bundleId) throw unavailable('The immutable prompt bundle has inconsistent identity.')
  const entries = await Promise.all(PROMPT_FAMILIES.map(async family => {
    const revision = await reader.getRevision(bundle.revisions[family].revisionId)
    if (!revision) throw unavailable('A referenced immutable prompt revision is unavailable. No current or legacy content was substituted.')
    return [family, revision] as const
  }))
  return assertSupported(validatePromptSnapshot({ schemaVersion: 1, bundle, revisions: Object.fromEntries(entries) }))
}

export class PromptRegistryService implements PromptRegistryCapture {
  private readonly clock: () => Date
  private readonly newId: () => string
  constructor(private readonly deps: PromptRegistryServiceDeps) {
    this.clock = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
  }
  private actor(principal: AuthenticatedPrincipal): PromptActor {
    return promptActorSchema.parse({ tenantId: principal.tenantId, oid: principal.oid })
  }
  private async authorize(principal: AuthenticatedPrincipal): Promise<void> {
    const config = this.deps.config
    const allowed = this.deps.authorizeActivation ? await this.deps.authorizeActivation(principal)
      : Boolean(config && isApplicationAdmin(principal, config))
    if (!allowed) throw forbidden('Only an application administrator can activate or restore a prompt bundle.')
  }
  private async findActivation(predicate: (activation: PromptActivation) => boolean): Promise<PromptActivation | undefined> {
    let before: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < 100; page++) {
      const history = await this.deps.store.history(100, before)
      for (const value of history.activations) {
        const activation = promptActivationSchema.parse(value)
        if (predicate(activation)) return activation
      }
      before = history.nextBefore
      if (!before) return undefined
      promptIdentifierSchema.parse(before)
      if (seen.has(before)) throw unavailable('Prompt activation history did not advance.')
      seen.add(before)
    }
    throw unavailable('Prompt activation history exceeded the bounded lookup; no release was substituted.')
  }
  private async publish(
    bundle: PromptBundleRevision, activation: PromptActivation, ifMatch: string, beforePublish?: PromptPublicationGuard,
  ): Promise<CurrentPromptBundle> {
    let guardFailed = false
    const guard = beforePublish === undefined ? undefined : async () => {
      try { await beforePublish() } catch (error) { guardFailed = true; throw error }
    }
    await guard?.()
    try { return await this.deps.store.activate(bundle, activation, ifMatch, guard) } catch (error) {
      if (guardFailed) throw error
      if (error instanceof StoreConflictError) throw conflict('The prompt pointer changed before activation. No release was selected.')
      let saved: CurrentPromptBundle | undefined
      try { saved = await this.deps.store.getCurrent() } catch { throw error }
      if (saved?.activation.activationId === activation.activationId &&
        promptObjectHash(saved.activation) === promptObjectHash(activation) &&
        promptObjectHash(saved.bundle) === promptObjectHash(bundle) && saved.etag && saved.etag !== '*') return saved
      throw error
    }
  }
  async current(): Promise<CurrentPromptBundle> {
    let current = await this.deps.store.getCurrent()
    if (!current) {
      const baseline = createCompiledPromptBaseline(this.clock().toISOString())
      const activation: PromptActivation = {
        schemaVersion: 1, activationId: 'pa-00000000000000000-baseline-v1', bundleId: baseline.bundle.bundleId,
        bundleSha256: baseline.bundle.bundleSha256, parentBundleId: null, parentBundleSha256: null,
        createdAt: baseline.bundle.createdAt, actor: { system: 'initialization' },
        reason: 'Initialize the code-owned compatible prompt baseline.', evaluation: null,
      }
      await this.deps.store.initialize(baseline.bundle, Object.values(baseline.revisions), activation)
      current = await this.deps.store.getCurrent()
      if (!current) throw unavailable('Prompt registry initialization could not be confirmed. No default was substituted.')
    }
    if (!current.etag || current.etag === '*' || current.etag.startsWith('W/') || current.etag.includes(',') || current.etag.trim() !== current.etag) {
      throw unavailable('The active prompt pointer has no exact concurrency version.')
    }
    validatePromptBundle(current.bundle)
    const activation = promptActivationSchema.parse(current.activation)
    if (activation.bundleId !== current.bundle.bundleId || activation.bundleSha256 !== current.bundle.bundleSha256) {
      throw unavailable('The prompt pointer and activation history have inconsistent bindings.')
    }
    await this.snapshot(current.bundle)
    return structuredClone(current)
  }
  async read(): Promise<CurrentPromptBundle & { snapshot: PromptBundleSnapshot }> {
    const current = await this.current()
    return { ...current, snapshot: await this.snapshot(current.bundle) }
  }
  async revision(revisionId: string): Promise<PromptRevision> {
    promptIdentifierSchema.parse(revisionId)
    const revision = await this.deps.store.getRevision(revisionId)
    if (!revision) throw notFound('The requested immutable prompt revision is unavailable.')
    const validated = validatePromptRevision(revision)
    if (validated.revisionId !== revisionId) throw unavailable('The immutable prompt revision has inconsistent identity.')
    return validated
  }
  async bundle(bundleId: string): Promise<PromptBundleRevision> {
    promptIdentifierSchema.parse(bundleId)
    const bundle = await this.deps.store.getBundle(bundleId)
    if (!bundle) throw notFound('The requested immutable prompt bundle is unavailable.')
    const validated = validatePromptBundle(bundle)
    if (validated.bundleId !== bundleId) throw unavailable('The immutable prompt bundle has inconsistent identity.')
    return validated
  }
  private async snapshot(bundle: PromptBundleRevision): Promise<PromptBundleSnapshot> {
    const entries = await Promise.all(PROMPT_FAMILIES.map(async family => [
      family, await this.revision(bundle.revisions[family].revisionId),
    ] as const))
    return assertSupported(validatePromptSnapshot({ schemaVersion: 1, bundle, revisions: Object.fromEntries(entries) }))
  }
  async capture(bundleId?: string): Promise<PromptBundleSnapshot> {
    return this.snapshot(bundleId === undefined ? (await this.current()).bundle : await this.bundle(bundleId))
  }
  async history(limit = 20, before?: string): Promise<PromptHistoryPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || before !== undefined && !promptIdentifierSchema.safeParse(before).success) {
      throw invalidRequest('Use a prompt history page size from 1 to 100 and a valid activation cursor.')
    }
    await this.current()
    return this.deps.store.history(limit, before)
  }
  /** Callers must verify access to the source evaluation before restoring a non-baseline release. */
  async published(bundleId: string): Promise<PublishedPromptBundle> {
    const snapshot = await this.capture(bundleId)
    const activation = await this.findActivation(value => value.bundleId === bundleId && value.restoration === undefined)
    if (!activation) throw notFound('Only a previously activated prompt release can be restored; an unevaluated draft cannot be selected.')
    if (activation.bundleSha256 !== snapshot.bundle.bundleSha256) throw unavailable('The published release and its immutable activation have inconsistent bindings.')
    return { snapshot, activation }
  }
  async createDraft(principal: AuthenticatedPrincipal, input: CreatePromptDraftInput): Promise<PromptBundleSnapshot> {
    const request = draftInputSchema.parse(input)
    const baseline = await this.capture(request.baseBundleId)
    if (baseline.bundle.bundleSha256 !== request.baseBundleSha256) throw conflict('The draft baseline does not match the captured prompt bundle.')
    const createdAt = this.clock().toISOString()
    const actor = this.actor(principal)
    const candidate = createPromptCandidate(baseline, request.guidance, actor, createdAt, `pb-${this.newId()}`)
    const { bundle, revisions } = candidate
    const changed = EDITABLE_PROMPT_FAMILIES.filter(family => revisions[family].revisionId !== baseline.revisions[family].revisionId)
      .map(family => revisions[family])
    try { await this.deps.store.createDraft(bundle, changed) } catch (error) {
      let saved: PromptBundleRevision | undefined
      try { saved = await this.deps.store.getBundle(bundle.bundleId) } catch { throw error }
      if (!saved || promptObjectHash(saved) !== promptObjectHash(bundle)) throw error
    }
    return this.capture(bundle.bundleId)
  }
  /** The supplied evaluator owns private outcomes. Global prompt records never retain feedback or evidence. */
  async evaluateDraft<T>(
    principal: AuthenticatedPrincipal, input: CreatePromptDraftInput,
    evaluate: (candidate: PromptBundleSnapshot) => Promise<T>,
  ): Promise<{ candidate: PromptBundleSnapshot; evaluation: T }> {
    const candidate = await this.createDraft(principal, input)
    const evaluation = await evaluate(structuredClone(candidate))
    return { candidate, evaluation }
  }
  async activate(
    principal: AuthenticatedPrincipal, input: ActivatePromptBundleInput, ifMatch: string | undefined, beforePublish?: PromptPublicationGuard,
  ): Promise<CurrentPromptBundle> {
    await this.authorize(principal)
    const request = activateInputSchema.parse(input)
    assertExactEtag(ifMatch)
    const current = await this.current()
    if (current.etag !== ifMatch) throw conflict('The active prompt bundle changed. Review the new baseline and reevaluate before activation.')
    const candidate = request.candidate ? assertSupported(validatePromptSnapshot(request.candidate)) : await this.capture(request.bundleId)
    const evaluation = request.evaluation
    if (candidate.bundle.bundleId !== request.bundleId || candidate.bundle.bundleSha256 !== request.bundleSha256 ||
      evaluation.evaluatedBundleId !== candidate.bundle.bundleId || evaluation.evaluatedBundleSha256 !== candidate.bundle.bundleSha256 ||
      evaluation.baselineBundleId !== current.bundle.bundleId || evaluation.baselineBundleSha256 !== current.bundle.bundleSha256) {
      throw conflict('Activation must select the exact evaluated candidate and unchanged active baseline.')
    }
    if (request.candidate) {
      if (candidate.bundle.parentBundleId !== current.bundle.bundleId) throw conflict('The evaluated candidate has a different immutable parent release.')
      const baseline = await this.capture(current.bundle.bundleId)
      for (const family of PROMPT_FAMILIES) {
        if (!(EDITABLE_PROMPT_FAMILIES as readonly string[]).includes(family) &&
          promptObjectHash(candidate.revisions[family]) !== promptObjectHash(baseline.revisions[family])) {
          throw invalidRequest('An evaluated candidate cannot replace a fixed review template or its retained revision.')
        }
      }
      const existing = await this.deps.store.getBundle(candidate.bundle.bundleId)
      if (existing) {
        if (promptObjectHash(existing) !== promptObjectHash(candidate.bundle)) throw conflict('The candidate bundle identity already contains different immutable content.')
      } else {
        const missing: PromptRevision[] = []
        for (const family of PROMPT_FAMILIES) {
          const revision = candidate.revisions[family]
          const saved = await this.deps.store.getRevision(revision.revisionId)
          if (saved) {
            if (promptObjectHash(saved) !== promptObjectHash(revision)) throw conflict('A candidate revision identity already contains different immutable content.')
          } else missing.push(revision)
        }
        try { await this.deps.store.createDraft(candidate.bundle, missing) } catch (error) {
          let saved: PromptBundleRevision | undefined
          try { saved = await this.deps.store.getBundle(candidate.bundle.bundleId) } catch { throw error }
          if (!saved || promptObjectHash(saved) !== promptObjectHash(candidate.bundle)) throw error
        }
      }
      const persisted = await this.capture(candidate.bundle.bundleId)
      if (promptObjectHash(persisted) !== promptObjectHash(candidate)) throw conflict('The registered candidate differs from the exact privately evaluated capture.')
    }
    const createdAt = this.clock().toISOString()
    const activation: PromptActivation = {
      schemaVersion: 1, activationId: `pa-${createdAt.replace(/[-:.TZ]/g, '')}-${this.newId()}`,
      bundleId: candidate.bundle.bundleId, bundleSha256: candidate.bundle.bundleSha256,
      parentBundleId: current.bundle.bundleId, parentBundleSha256: current.bundle.bundleSha256,
      createdAt, actor: this.actor(principal), reason: request.reason, evaluation,
    }
    return this.publish(candidate.bundle, activation, ifMatch, beforePublish)
  }
  async restore(
    principal: AuthenticatedPrincipal, bundleId: string, reason: string, ifMatch: string | undefined, requestId: string,
    beforePublish?: PromptPublicationGuard,
  ): Promise<CurrentPromptBundle> {
    await this.authorize(principal)
    const request = restoreInputSchema.parse({ bundleId, reason, requestId })
    assertExactEtag(ifMatch)
    const current = await this.current()
    const actor = this.actor(principal)
    const previous = await this.findActivation(value => value.restoration?.requestId === request.requestId)
    if (previous) {
      if (previous.bundleId !== request.bundleId || previous.reason !== request.reason ||
        promptObjectHash(previous.actor) !== promptObjectHash(actor) || previous.restoration?.expectedEtag !== ifMatch) {
        throw conflict('This restoration request identity was already used for a different immutable request.')
      }
      // Do not repeat an acknowledged restoration over a later administrator's release.
      return current
    }
    if (current.etag !== ifMatch) throw conflict('The active prompt bundle changed before restoration. Review the new pointer before trying again.')
    const { snapshot, activation: source } = await this.published(request.bundleId)
    const createdAt = this.clock().toISOString()
    const activation = promptActivationSchema.parse({
      schemaVersion: 1, activationId: `pa-${createdAt.replace(/[-:.TZ]/g, '')}-${this.newId()}`,
      bundleId: snapshot.bundle.bundleId, bundleSha256: snapshot.bundle.bundleSha256,
      parentBundleId: current.bundle.bundleId, parentBundleSha256: current.bundle.bundleSha256,
      createdAt, actor, reason: request.reason, evaluation: null,
      restoration: { requestId: request.requestId, sourceActivationId: source.activationId, expectedEtag: ifMatch },
    })
    return this.publish(snapshot.bundle, activation, ifMatch, beforePublish)
  }
}
export function createPromptRegistryService(deps: PromptRegistryServiceDeps): PromptRegistryService {
  return new PromptRegistryService(deps)
}
