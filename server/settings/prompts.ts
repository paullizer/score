import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { processingSettingsSnapshotSchema, type ProcessingSettingsSnapshot } from '../../src/domain/admin-settings'
import {
  EDITABLE_PROMPT_FAMILIES, PROMPT_FAMILIES, PROMPT_REGISTRY_LIMITS, PROMPT_RENDERER_VERSION, PROMPT_TEMPLATE_GENERATION,
  promptActivationSchema, promptActorSchema, promptBundleSnapshotSchema, promptEvaluationReferenceSchema, promptTemplateReleaseSchema,
  promptGuidanceDraftSchema, promptHashSchema, promptIdentifierSchema, promptDeploymentReleaseSchema,
  type CurrentPromptBundle, type PromptActivation, type PromptActor, type PromptBundleRevision, type PromptBundleSnapshot,
  type PromptFamily, type PromptGuidanceDraft, type PromptHistoryPage, type PromptRevision, type PublishedPromptBundle, type PromptDeploymentRelease,
} from '../../src/domain/prompt-versions'
import { JOB_RUBRIC_COMPILED_PROMPT } from '../../worker/runtime'
import { GRADE_COMPILED_PROMPTS } from '../../worker/grades/model'
import { ANALYSIS_COMPILED_PROMPTS } from '../../worker/analyses/model'
import { pinnedPromptTemplate, type CompiledPromptTemplate } from '../../worker/prompts'
import { isApplicationAdmin, type AuthenticatedPrincipal } from '../auth'
import type { Config } from '../config'
import { HttpError, conflict, forbidden, invalidRequest, notFound, preconditionRequired, unavailable } from '../errors'
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

export const DEFAULT_PROMPT_TEMPLATES: Record<PromptFamily, CompiledPromptTemplate> = {
  jobRubric: JOB_RUBRIC_COMPILED_PROMPT, ...GRADE_COMPILED_PROMPTS, ...ANALYSIS_COMPILED_PROMPTS,
}
export function compiledPromptContractHash(templates = DEFAULT_PROMPT_TEMPLATES): string {
  return promptObjectHash({ templates: PROMPT_FAMILIES.map(family => ({ family, ...pinnedPromptTemplate(family, templates[family]) })),
    guidance: baselineGuidance })
}
const baselineGuidance = {
  jobRubric: 'Organize the substantive single-role description into distinct professional work criteria, including fictional or synthetic fixtures and internal or non-live descriptions. Preserve role-specific requirements and use concrete documentary evidence anchors rather than generic skill labels.',
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
const templateReleaseInputSchema = z.strictObject({
  reason: z.string().min(1).max(PROMPT_REGISTRY_LIMITS.reasonCharacters).regex(/\S/),
  gateReportSha256: promptHashSchema,
  targetsVersion: promptIdentifierSchema,
})
export type CreatePromptDraftInput = z.infer<typeof draftInputSchema>
export type ActivatePromptBundleInput = z.infer<typeof activateInputSchema>
export type ReleasePromptTemplatesInput = z.infer<typeof templateReleaseInputSchema>
export interface PromptTemplateReleaseStatus {
  activeBundleId: string | null
  activeBundleSha256: string | null
  etag: string | null
  supported: boolean
  generation: string
  pending: boolean
  retryAllowed: boolean
  message: string
  deploymentVerified?: boolean
}
export interface PromptRegistryCapture {
  capture(bundleId?: string): Promise<PromptBundleSnapshot>
  releaseStatus?(): Promise<PromptTemplateReleaseStatus>
}
export interface PromptRegistryServiceDeps {
  store: PromptRegistryStore
  config?: Pick<Config, 'tenantId'>
  /** Source-plan membership, exact evaluated plan pins and peer visibility remain the route's responsibility. */
  authorizeActivation?: (principal: AuthenticatedPrincipal) => boolean | Promise<boolean>
  now?: () => Date
  newId?: () => string
  templates?: Record<PromptFamily, CompiledPromptTemplate>
  generation?: string
  build?: { releaseId: string; contractSha256: string }
  deployment?: PromptDeploymentRelease
}

function assertExactEtag(ifMatch: string | undefined): asserts ifMatch is string {
  if (!ifMatch) throw preconditionRequired('An exact If-Match prompt pointer ETag is required.')
  if (ifMatch === '*' || ifMatch.startsWith('W/') || ifMatch.includes(',') || ifMatch.trim() !== ifMatch) {
    throw invalidRequest('Use one exact prompt pointer ETag, not a wildcard, weak ETag, or list.')
  }
}

function createRevision(
  family: PromptFamily, revisionId: string, createdAt: string, actor: PromptActor, guidance: string | null,
  parentRevisionId: string | null, templateSet: Record<PromptFamily, CompiledPromptTemplate> = DEFAULT_PROMPT_TEMPLATES,
  guidanceSource?: 'code' | 'qc',
): PromptRevision {
  const template = pinnedPromptTemplate(family, templateSet[family])
  const content = {
    schemaVersion: 1 as const, family, revisionId, createdAt, actor, parentRevisionId, guidance,
    guidanceSha256: promptTextHash(guidance ?? ''), rendererVersion: PROMPT_RENDERER_VERSION,
    templateVersion: template.promptVersion, templateSha256: promptTextHash(template.system), outputSchemaVersion: template.schemaVersion,
    ...(guidanceSource === undefined ? {} : { guidanceSource }),
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
export function createCompiledPromptBaseline(
  createdAt = '2026-09-22T00:00:00.000Z', templateSet: Record<PromptFamily, CompiledPromptTemplate> = DEFAULT_PROMPT_TEMPLATES,
): PromptBundleSnapshot {
  const actor = { system: 'initialization' } as const
  const revisions = Object.fromEntries(PROMPT_FAMILIES.map(family => [family, createRevision(
    family, `pr-baseline-${family}-v1`, createdAt, actor,
    (EDITABLE_PROMPT_FAMILIES as readonly string[]).includes(family) ? baselineGuidance[family as keyof typeof baselineGuidance] : null,
    null, templateSet,
  )])) as Record<PromptFamily, PromptRevision>
  return validatePromptSnapshot({
    schemaVersion: 1, revisions, bundle: createBundle('pb-baseline-v1', createdAt, actor, null, revisions),
  })
}
const unsupportedTemplateMessage = 'The selected immutable prompt renderer or schema is unsupported; no replacement was used.'
const pendingTemplateReleaseMessage = 'AI processing is paused while a software update finishes. An operator must complete the deployment; no Quality Control approval is needed.'
class UnsupportedPromptTemplateError extends HttpError {
  constructor(message: string) { super(503, 'unavailable', message) }
}
function isUnsupportedTemplateError(error: unknown): boolean {
  return error instanceof UnsupportedPromptTemplateError
}
function assertSupported(
  snapshot: PromptBundleSnapshot,
  templateSet: Record<PromptFamily, CompiledPromptTemplate> = DEFAULT_PROMPT_TEMPLATES,
  message = unsupportedTemplateMessage,
): PromptBundleSnapshot {
  validatePromptSnapshot(snapshot)
  for (const family of PROMPT_FAMILIES) {
    const template = pinnedPromptTemplate(family, templateSet[family])
    const revision = snapshot.revisions[family]
    if (revision.templateVersion !== template.promptVersion || revision.templateSha256 !== promptTextHash(template.system) ||
      revision.outputSchemaVersion !== template.schemaVersion) throw new UnsupportedPromptTemplateError(message)
  }
  return snapshot
}

/** Pure deterministic construction for private QC checkpoints; no global write or activation. */
export function createPromptCandidate(
  baseline: PromptBundleSnapshot, guidance: PromptGuidanceDraft, actor: PromptActor, createdAt: string, bundleId: string,
  templateSet: Record<PromptFamily, CompiledPromptTemplate> = DEFAULT_PROMPT_TEMPLATES,
): PromptBundleSnapshot {
  assertSupported(baseline, templateSet)
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
    revisions[family] = createRevision(family, revisionId, createdAt, actor, next, revisions[family].revisionId, templateSet, 'qc')
    changed = true
  }
  if (!changed) throw invalidRequest('A candidate must change at least one editable task-guidance family.')
  return assertSupported(validatePromptSnapshot({
    schemaVersion: 1, revisions, bundle: createBundle(bundleId, createdAt, actor, baseline.bundle.bundleId, revisions),
  }), templateSet)
}

/** Changes only prompt pins; evaluation retains the exact captured model and processing settings. */

export function createTemplateReleaseSnapshot(
  parent: PromptBundleRevision, generation: string, createdAt: string, actor: PromptActor,
  templateSet: Record<PromptFamily, CompiledPromptTemplate> = DEFAULT_PROMPT_TEMPLATES,
): PromptBundleSnapshot {
  const parsedParent = validatePromptBundle(parent)
  const parsedGeneration = promptIdentifierSchema.parse(generation)
  const parsedActor = promptActorSchema.parse(actor)
  if ('system' in parsedActor) throw invalidRequest('A template release needs an attributable application administrator.')
  const suffix = parsedParent.bundleSha256.slice(0, 16)
  const revisions = Object.fromEntries(PROMPT_FAMILIES.map(family => [family, createRevision(
    family, `pr-${parsedGeneration}-${family}-${suffix}`, createdAt, parsedActor,
    (EDITABLE_PROMPT_FAMILIES as readonly string[]).includes(family) ? baselineGuidance[family as keyof typeof baselineGuidance] : null,
    parsedParent.revisions[family].revisionId, templateSet,
  )])) as Record<PromptFamily, PromptRevision>
  return assertSupported(validatePromptSnapshot({
    schemaVersion: 1,
    revisions,
    bundle: createBundle(`pb-${parsedGeneration}-${suffix}`, createdAt, parsedActor, parsedParent.bundleId, revisions),
  }), templateSet)
}

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
  private readonly templates: Record<PromptFamily, CompiledPromptTemplate>
  private readonly generation: string
  constructor(private readonly deps: PromptRegistryServiceDeps) {
    this.clock = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? randomUUID
    this.templates = deps.templates ?? DEFAULT_PROMPT_TEMPLATES
    this.generation = promptIdentifierSchema.parse(deps.generation ?? PROMPT_TEMPLATE_GENERATION)
  }
  private actor(principal: AuthenticatedPrincipal): PromptActor {
    return promptActorSchema.parse({ tenantId: principal.tenantId, oid: principal.oid })
  }
  private async authorize(principal: AuthenticatedPrincipal): Promise<void> {
    const config = this.deps.config
    const allowed = this.deps.authorizeActivation ? await this.deps.authorizeActivation(principal)
      : Boolean(config && isApplicationAdmin(principal, config))
    if (!allowed) throw forbidden('Only an application administrator can activate, release, or restore a prompt bundle.')
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
      const baseline = createCompiledPromptBaseline(this.clock().toISOString(), this.templates)
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
    const pointer = this.validatePointer(current)
    if (!await this.bundleSupported(pointer.bundle)) throw new UnsupportedPromptTemplateError(pendingTemplateReleaseMessage)
    return structuredClone(pointer)
  }
  private validatePointer(current: CurrentPromptBundle): CurrentPromptBundle {
    if (!current.etag || current.etag === '*' || current.etag.startsWith('W/') || current.etag.includes(',') || current.etag.trim() !== current.etag) {
      throw unavailable('The active prompt pointer has no exact concurrency version.')
    }
    validatePromptBundle(current.bundle)
    const activation = promptActivationSchema.parse(current.activation)
    if (activation.bundleId !== current.bundle.bundleId || activation.bundleSha256 !== current.bundle.bundleSha256) {
      throw unavailable('The prompt pointer and activation history have inconsistent bindings.')
    }
    return { ...current, activation }
  }
  private async bundleSupported(bundle: PromptBundleRevision): Promise<boolean> {
    try {
      const snapshot = await this.snapshot(bundle)
      for (const family of EDITABLE_PROMPT_FAMILIES) {
        const revision = snapshot.revisions[family]
        if (revision.guidance !== baselineGuidance[family] && revision.guidanceSource !== 'qc' &&
          (revision.guidanceSource === 'code' || !await this.wasQcRevision(family, revision.revisionId))) return false
      }
      return true
    } catch (error) {
      if (isUnsupportedTemplateError(error)) return false
      throw error
    }
  }
  private verifiedDeployment(): PromptDeploymentRelease | undefined {
    const { build, deployment } = this.deps
    if (!build || !deployment) return undefined
    const proof = promptDeploymentReleaseSchema.parse(deployment)
    if (proof.releaseId !== build.releaseId || proof.contractSha256 !== build.contractSha256 ||
      proof.contractSha256 !== compiledPromptContractHash(this.templates)) return undefined
    return proof
  }
  async releaseStatus(): Promise<PromptTemplateReleaseStatus> {
    const current = await this.deps.store.getCurrent()
    const retryAllowed = Boolean(this.verifiedDeployment())
    const deploymentStatus = this.deps.build ? { deploymentVerified: retryAllowed } : {}
    if (!current) return { activeBundleId: null, activeBundleSha256: null, etag: null, supported: false, generation: this.generation, pending: true,
      ...deploymentStatus, retryAllowed, message: retryAllowed ? 'The verified update is ready to finish.' : 'An operator must finish deploying and verifying the API and all five workers.' }
    const pointer = this.validatePointer(current)
    const supported = await this.bundleSupported(pointer.bundle)
    return {
      activeBundleId: pointer.bundle.bundleId, activeBundleSha256: pointer.bundle.bundleSha256, etag: pointer.etag,
      supported, generation: this.generation, pending: !supported,
      ...deploymentStatus,
      retryAllowed: !supported && retryAllowed,
      message: this.deps.build && !retryAllowed ? 'The matching API and all five workers have not been verified. An operator must finish the deployment; no approval or policy change is needed.'
        : supported ? 'AI instructions are up to date. Quality Control changes use their own evaluation and approval workflow.'
        : retryAllowed ? 'The verified update has not finished. Retry finishing it; no Quality Control approval is needed.'
          : 'AI processing is paused while the update finishes. An operator must deploy and verify the matching API and all five workers. No approval or policy change is needed.',
    }
  }
  async finishDeployment(ifMatch?: string): Promise<CurrentPromptBundle> {
    const proof = this.verifiedDeployment()
    if (!proof) throw unavailable('This update has no matching verified deployment. An operator must finish the deployment; administrator approval cannot bypass verification.')
    const saved = await this.deps.store.getCurrent()
    if (!saved) return this.current()
    const current = this.validatePointer(saved)
    if (await this.bundleSupported(current.bundle)) return current
    if (ifMatch !== undefined) {
      assertExactEtag(ifMatch)
      if (current.etag !== ifMatch) throw conflict('The active AI instructions changed. Refresh application status before retrying.')
    }
    const parent = await this.loadSnapshot(current.bundle)
    const actor = { system: 'deployment' } as const
    const identity = promptObjectHash({ releaseId: proof.releaseId, parent: parent.bundle.bundleSha256 })
    const revisions = { ...parent.revisions }
    for (const family of PROMPT_FAMILIES) {
      const previous = parent.revisions[family]
      let qc = previous.guidanceSource === 'qc'
      if (previous.guidanceSource === undefined && previous.guidance !== null) {
        // Older captures predate guidanceSource. Inspect the immutable revision's authoring bundle,
        // not its text: identical text may still be an explicitly approved QC choice.
        qc = await this.wasQcRevision(family, previous.revisionId)
      }
      const guidance = previous.guidance === null ? null : qc ? previous.guidance
        : baselineGuidance[family as keyof typeof baselineGuidance]
      revisions[family] = createRevision(family, `pr-deploy-${family}-${identity}`, proof.verifiedAt, actor,
        guidance, previous.revisionId, this.templates, qc ? 'qc' : 'code')
    }
    let candidate = assertSupported(validatePromptSnapshot({ schemaVersion: 1, revisions,
      bundle: createBundle(`pb-deploy-${identity}`, proof.verifiedAt, actor, parent.bundle.bundleId, revisions) }), this.templates)
    try { await this.deps.store.createDraft(candidate.bundle, Object.values(revisions)) } catch (error) {
      const existing = await this.deps.store.getBundle(candidate.bundle.bundleId)
      if (!existing) throw error
      const retained = assertSupported(await this.loadSnapshot(existing), this.templates)
      if (retained.bundle.parentBundleId !== candidate.bundle.parentBundleId || PROMPT_FAMILIES.some(family =>
        retained.revisions[family].revisionId !== candidate.revisions[family].revisionId ||
        retained.revisions[family].contentSha256 !== candidate.revisions[family].contentSha256 ||
        retained.revisions[family].parentRevisionId !== candidate.revisions[family].parentRevisionId)) throw error
      candidate = retained
    }
    const activation = promptActivationSchema.parse({
      schemaVersion: 1, activationId: `pa-${proof.verifiedAt.replace(/[-:.TZ]/g, '')}-${identity}`, bundleId: candidate.bundle.bundleId,
      bundleSha256: candidate.bundle.bundleSha256, parentBundleId: current.bundle.bundleId, parentBundleSha256: current.bundle.bundleSha256,
      createdAt: proof.verifiedAt, actor, reason: 'Complete the verified software deployment; retain approved Quality Control guidance.',
      evaluation: null, deploymentRelease: proof,
    })
    try { return await this.publish(candidate.bundle, activation, current.etag) } catch (error) {
      const latest = await this.deps.store.getCurrent()
      if (latest?.activation.activationId === activation.activationId &&
        promptObjectHash(latest.activation) === promptObjectHash(activation)) return this.validatePointer(latest)
      throw error
    }
  }
  private async wasQcRevision(family: PromptFamily, revisionId: string): Promise<boolean> {
    const check = async (activation: PromptActivation) => {
      if (!activation.evaluation || !activation.parentBundleId) return false
      const [bundle, parent] = await Promise.all([this.bundle(activation.bundleId), this.bundle(activation.parentBundleId)])
      return bundle.revisions[family].revisionId === revisionId && parent.revisions[family].revisionId !== revisionId
    }
    let before: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < 100; page++) {
      const history = await this.deps.store.history(100, before)
      for (const activation of history.activations) if (await check(promptActivationSchema.parse(activation))) return true
      if (!history.nextBefore) return false
      if (seen.has(history.nextBefore)) throw unavailable('Prompt activation history did not advance.')
      seen.add(history.nextBefore); before = history.nextBefore
    }
    throw unavailable('Prompt history is too large to verify approved guidance automatically.')
  }
  async releaseTemplates(
    principal: AuthenticatedPrincipal, input: ReleasePromptTemplatesInput, ifMatch: string | undefined, beforePublish?: PromptPublicationGuard,
  ): Promise<CurrentPromptBundle> {
    await this.authorize(principal)
    const request = templateReleaseInputSchema.parse(input)
    assertExactEtag(ifMatch)
    const saved = await this.deps.store.getCurrent()
    if (!saved) throw unavailable('Initialize the prompt registry first.')
    const current = this.validatePointer(saved)
    if (current.etag !== ifMatch) throw conflict('The active prompt bundle changed. Reload the prompt release status before activation.')
    if (await this.bundleSupported(current.bundle)) throw conflict('The active prompt release already uses this template generation.')
    const createdAt = this.clock().toISOString()
    const actor = this.actor(principal)
    const fresh = createTemplateReleaseSnapshot(current.bundle, this.generation, createdAt, actor, this.templates)
    // An earlier attempt may have registered this release without activating it. Its ID is deterministic, but its
    // timestamp and actor are not, so reuse the exact saved content when it is the same release of the same parent.
    const registered = await this.deps.store.getBundle(fresh.bundle.bundleId)
    let candidate = fresh
    if (registered) {
      const existing = await this.snapshot(validatePromptBundle(registered))
      const sameRelease = existing.bundle.parentBundleId === current.bundle.bundleId && PROMPT_FAMILIES.every(family => {
        const [a, b] = [existing.revisions[family], fresh.revisions[family]]
        return a.revisionId === b.revisionId && a.parentRevisionId === b.parentRevisionId && a.guidanceSha256 === b.guidanceSha256 &&
          a.templateVersion === b.templateVersion && a.templateSha256 === b.templateSha256 && a.outputSchemaVersion === b.outputSchemaVersion
      })
      if (!sameRelease) throw conflict('The template-release bundle identity already contains different immutable content.')
      candidate = existing
    } else {
      try { await this.deps.store.createDraft(fresh.bundle, Object.values(fresh.revisions)) } catch (error) {
        const saved = await this.deps.store.getBundle(fresh.bundle.bundleId).catch(() => undefined)
        if (!saved || promptObjectHash(saved) !== promptObjectHash(fresh.bundle)) throw error instanceof StoreConflictError
          ? conflict('The template-release bundle identity already contains different immutable content.') : error
        for (const revision of Object.values(fresh.revisions)) {
          const existing = await this.deps.store.getRevision(revision.revisionId)
          if (!existing || promptObjectHash(existing) !== promptObjectHash(revision)) {
            throw conflict('The template-release revision identity already contains different immutable content.')
          }
        }
      }
      const persisted = await this.capture(fresh.bundle.bundleId)
      if (promptObjectHash(persisted) !== promptObjectHash(fresh)) throw conflict('The registered template release differs from the compiled release snapshot.')
    }
    const activation = promptActivationSchema.parse({
      schemaVersion: 1, activationId: `pa-${createdAt.replace(/[-:.TZ]/g, '')}-${this.newId()}`,
      bundleId: candidate.bundle.bundleId, bundleSha256: candidate.bundle.bundleSha256,
      parentBundleId: current.bundle.bundleId, parentBundleSha256: current.bundle.bundleSha256,
      createdAt, actor, reason: request.reason, evaluation: null,
      templateRelease: promptTemplateReleaseSchema.parse({ generation: this.generation, gateReportSha256: request.gateReportSha256, targetsVersion: request.targetsVersion }),
    })
    return this.publish(candidate.bundle, activation, ifMatch, beforePublish)
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
  private async loadSnapshot(bundle: PromptBundleRevision): Promise<PromptBundleSnapshot> {
    const entries = await Promise.all(PROMPT_FAMILIES.map(async family => [
      family, await this.revision(bundle.revisions[family].revisionId),
    ] as const))
    return validatePromptSnapshot({ schemaVersion: 1, bundle, revisions: Object.fromEntries(entries) })
  }
  private async snapshot(bundle: PromptBundleRevision, unsupportedMessage = unsupportedTemplateMessage): Promise<PromptBundleSnapshot> {
    return assertSupported(await this.loadSnapshot(bundle), this.templates, unsupportedMessage)
  }
  async capture(bundleId?: string): Promise<PromptBundleSnapshot> {
    if (bundleId === undefined && this.deps.build && !this.verifiedDeployment()) {
      throw unavailable('AI processing is paused until the matching API and all five workers are verified. An operator must finish the deployment.')
    }
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
    if (activation.deploymentRelease && EDITABLE_PROMPT_FAMILIES.some(family => snapshot.revisions[family].guidanceSource === 'qc')) {
      throw conflict('This software deployment retained QC guidance but is not a QC evaluation. Evaluate the desired guidance in Quality Control before restoring it.')
    }
    if (activation.bundleSha256 !== snapshot.bundle.bundleSha256) throw unavailable('The published release and its immutable activation have inconsistent bindings.')
    return { snapshot, activation }
  }
  async createDraft(principal: AuthenticatedPrincipal, input: CreatePromptDraftInput): Promise<PromptBundleSnapshot> {
    const request = draftInputSchema.parse(input)
    const baseline = await this.capture(request.baseBundleId)
    if (baseline.bundle.bundleSha256 !== request.baseBundleSha256) throw conflict('The draft baseline does not match the captured prompt bundle.')
    const createdAt = this.clock().toISOString()
    const actor = this.actor(principal)
    const candidate = createPromptCandidate(baseline, request.guidance, actor, createdAt, `pb-${this.newId()}`, this.templates)
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
    const candidate = request.candidate ? assertSupported(validatePromptSnapshot(request.candidate), this.templates) : await this.capture(request.bundleId)
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
