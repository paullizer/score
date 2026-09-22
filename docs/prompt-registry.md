# Immutable prompts and original assessment diagnostics

## Public contracts and persistence

`src\domain\prompt-versions.ts` defines the seven prompt families, strict immutable revision/bundle/capture schemas, execution provenance, and activation references. Only `jobRubric`, `gradeCompetencies`, `gradeDraft`, and `assessment` have editable **task guidance**. Grade review, assessment grounding, and scoped evidence-gap review are fixed, versioned code-owned templates. Schema, evidence/citation, protected-trait, qualification, weighting, and correction-budget rules remain outside editable guidance.

`server\settings\prompts.ts` exports:

- `PromptRegistryService` and `createPromptRegistryService({ store, config?, authorizeActivation?, now?, newId? })`.
- `createPromptStoreFromContainer(container)` and `createAzurePromptStore(settingsConfig, credential)`.
- Read-only `createPromptReaderFromContainer`, `createAzurePromptReader`, and `readPromptBundleSnapshot(reader, bundleId?)`.
- `createCompiledPromptBaseline`, `createPromptCandidate`, `createPromptCandidateSettings`, validation/hash helpers, and the service/store contract types.

The Azure constructors take the existing application-settings configuration (`cosmosEndpoint`, `database`, `container`, `applicationId: 'score'`). No new prompt container or private feedback storage is involved. Distinct records use:

| ID | Record type | Mutation |
| --- | --- | --- |
| `prompt:revision:{revisionId}` | `prompt-revision` | Create only |
| `prompt:bundle:{bundleId}` | `prompt-bundle` | Create only |
| `prompt:current` | `prompt-current` | Exact pointer ETag CAS |
| `prompt:activation:{activationId}` | `prompt-activation` | Create only |

Baseline initialization atomically creates all seven revisions, a bundle, an activation audit and the active pointer **only after a confirmed absent pointer**. Failed reads, corrupt pointers, missing history, and immutable-record collisions are errors, not permission to reset saved choices.

Reader-first rollout uses the independent shared `PROMPT_RUNTIME_VERSION = 'score-prompt-runtime-v1'`, re-exported by the job, grade, resume, analysis, and QC runtime entry bundles. The existing settings capability alone does not prove prompt-pin awareness. Deployment must probe all five runtime exports before recording `SCORE_PROMPT_RUNTIME_WORKER_VERSION` proof or admitting pinned paid work. This capability marker does not require changing stored settings or their runtime version.

The separate QC-policy upgrade advertises `RUNTIME_SETTINGS_VERSION = 'score-runtime-settings-v2'` for the **reader**, supporting both original v1 settings and explicit v2 QC policies. This runtime marker was never a field in `ProcessingSettingsSnapshot`; it must not be injected into historical captures. Original v1 envelopes retain their exact serialized shape/hashes, both version-1 schema fields, and absence of `qcPlan`, `processing.qc`, `workers.qc`, and `promptBundle`. `captureQcProcessingSettings` is an explicit **new QC admission** operation, not a retry/history reconstruction step. Deployment settings-reader verification must match the v2 emitted reader marker independently of prompt-reader verification.

## Candidate evaluation and activation

`current()` returns `{ bundle, activation, etag }`; `read()` also returns a complete `snapshot`. `revision(id)`, `bundle(id)`, and paginated `history(limit?, before?)` read immutable history. `capture(bundleId?)` retains complete immutable revision guidance and template/content hashes, selecting current only when an ID is omitted.

`createDraft(principal, { baseBundleId, baseBundleSha256, guidance, generalized: true })` creates a candidate without activation. The strict guidance map rejects other families, extra source/feedback fields, excessive text and unresolved placeholders. The explicit generalization assertion is a human review requirement, not a detector that can prove arbitrary prose contains no private information. Callers must not copy source quotations, individual feedback or plan prose into global guidance.

`evaluateDraft(principal, input, evaluator)` supplies an immutable candidate capture to the caller's evaluator and returns `{ candidate, evaluation }`. It propagates evaluator failure and never changes current. The caller owns bounded paid work, private case packs, model settings, lifecycle/idempotency, and evaluation persistence.

Read-only QC workers instead call the pure `createPromptCandidate(baseline, guidance, actor, createdAt, bundleId): PromptBundleSnapshot`. Identical frozen inputs reproduce the same candidate and changed revision identities across retries; unchanged and fixed revisions are copied exactly. This function does not read or write the registry. Keep its result in the private evaluation checkpoint until an authorized administrator activates the completed evaluation.

`createPromptCandidateSettings(baselineSettings, guidance, actor, createdAt, bundleId): ProcessingSettingsSnapshot` wraps that construction for a complete candidate evaluation capture. It requires a pinned schema-2 baseline and preserves every captured model/processing setting, revision and capture timestamp exactly, changing only `promptBundle`. It never synthesizes pins for legacy work, resolves current, activates, or writes global records. `guidance` is `PromptGuidanceDraft` (an editable-family map); QC change reasons and private feedback remain outside this map.

`activate(principal, { bundleId, bundleSha256, reason, evaluation, candidate? }, exactEtag, beforePublish?)` requires an application administrator through the configured tenant/admission/admin roster or the explicit authorization callback. It rejects wildcard/weak/list/stale ETags and requires:

- `evaluation.workspaceId`, `planId`, `planRevisionId`, `planSha256`, `evaluationId`, and `evaluationSha256`;
- `baselineBundleId` / `baselineBundleSha256` matching the unchanged active release;
- `evaluatedBundleId` / `evaluatedBundleSha256` matching the exact candidate.

The QC route must additionally verify source-plan access, peer visibility, persisted completed evaluation status, unchanged plan/case/model pins, generalized guidance and approval readiness. These references do not independently prove those private workspace facts. For a private evaluation, pass its exact retained `candidate` in the activation input: the service first validates the parent baseline and retained fixed revisions, then create-only registers the exact candidate snapshot without rebuilding identities or hashes. Failed authorization or stale/mismatched evaluation pins cannot register it. A concurrent pointer change still rejects the final CAS; an inactive immutable candidate may remain for audit, but is never made current by a blind retry.

The activation transaction itself replaces only the pointer and creates its audit. A lost acknowledgement succeeds only after reading back the exact committed immutable activation.

`published(bundleId)` returns `{ snapshot, activation }` for a compatible release's previous evaluated publication (or baseline initialization), not an inactive draft. Before restoring a non-baseline release, the QC route must verify source-plan access and peer visibility using this activation's evaluation references. `restore(principal, bundleId, reason, exactEtag, requestId, beforePublish?)` then performs an administrator-only audited CAS rollback without overwriting content or pretending a new evaluation occurred. Its audit has `evaluation: null` and `restoration: { requestId, sourceActivationId, expectedEtag }`. Replaying an exactly matching restoration request confirms the prior operation and returns the actual current pointer; it never restores again over a later release.

Both publication methods accept an optional `PromptPublicationGuard = () => Promise<void>`. QC supplies fresh authorization and workspace/run lifecycle/lease checks that reject when publication is no longer permitted. Checks must be idempotent: the service checks at handoff and the Azure store checks again after its final bundle read, immediately before the pointer/audit CAS transaction. A rejected guard propagates unchanged and never enters lost-acknowledgement reconciliation. An acknowledged restoration replay performs no publication and does not rerun the guard. The registry remains independent of workspace-specific authorization and lease implementations.

## Accepted work and compatibility

Wire `new AdminSettingsService({ ..., prompts: promptRegistry })` for admissions. A configured missing/failed registry fails closed. `captureLegacy()` intentionally never captures current prompts.

`captureProcessingSettings(settings, revision, capturedAt, promptBundle?)` emits:

- Version 1 without prompts for genuinely legacy work.
- Version 2 with required `promptBundle` for pinned work, bounded to 64 KiB.

The retained capture includes the immutable bundle and all seven revision values. Workers require no mutable-current prompt read or registry write: `resolveAcceptedPrompt` verifies accepted bundle/revision hashes and the compatible compiled template hash, then renders the selected guidance with the accepted numeric settings. Missing, corrupt or unsupported pins fail explicitly. Validation and API retry reconstruction preserve the capture rather than rebuilding a settings-only snapshot.

Existing job, GS generation/review, full assessment/grounding, and scoped-correction acceptance paths already carry this settings snapshot. Job output rubrics record `provenance.prompt`; GS plans/reviews record `prompt` and draft rubrics record `provenance.prompt`; assessment/review model provenance records `prompt` and the producing `modelCallId`. Strict frozen readers recognize those fields. Human rubric edits retain the original generation prompt provenance while remaining labeled edited.

Unpinned work keeps the exact compiled legacy system templates and legacy schemas. Never change those templates in place, resolve current for an old operation, rehash old artifacts or claim reconstructed historic prompt content. A future incompatible template must retain a compatible old renderer or fail explicitly. Summary-writing and resume-profiling guidance are not calibration targets.

## Original assessment QC diagnostics

`src\domain\analysis-qc-diagnostics.ts` contains the shared diagnostic contracts. Only the pinned `score-analysis-assessment-qc-v1` full-assessment contract adds `qcDiagnostics: { criteria: [...] }` in the existing assessment call. Each criterion has:

- `confidence`: `low`, `medium`, `high`, or `null` for unscored rows;
- `explanation`;
- `ambiguity`: bounded `{ category, explanation }` entries;
- `alternativeScores`: distinct defensible integers 0–5, excluding the selected score.

Confidence describes applying the saved rubric to that document, not personal ability or a probability. Missing evidence can be a confident zero. Unscored rows have null confidence and no numeric alternatives. Coverage, categories, lengths, states and alternatives are validated within the existing shared correction budget. Independent grounding receives the canonical assessment without diagnostics and remains mandatory.

The final accepted attempt's diagnostics are persisted in an immutable analysis-sources blob:

`{workspaceId}/{runId}/qc-diagnostics/{comparisonId}/{attemptId}.json`

The completed comparison links it with `qcDiagnostics: { schemaVersion, attemptId, modelCallId, resultSha256, assessmentSha256, blob }`. The sidecar carries the exact result/assessment/manifest/source hashes, frozen rubric ID/version/hash, assessment model/prompt/schema provenance and per-criterion `assessedScore` / `assessedEvidenceStatus`. It uses the same leased/lifecycle-fenced upload and completed-comparison transaction as score publication. Missing required capture or failed sidecar storage cannot publish a completed pinned comparison.

The sidecar's exact field names are:

```ts
{
  schemaVersion, version, dataKind, workspaceId, runId, comparisonId, attemptId, createdAt,
  resultSha256, assessmentSha256, modelAssessmentSha256, manifestSha256,
  resumeSnapshot: { snapshotId, sha256 },
  targetSnapshot: { snapshotId, sha256 },
  rubric: { id, version, sha256 },
  assessmentProvenance, // Includes the exact producing modelCallId and prompt execution provenance.
  criteria, // Diagnostic fields plus assessedScore and assessedEvidenceStatus.
}
```

Diagnostics are not embedded in the canonical assessment/result or deterministic score calculation. A code-owned evidence-gap normalization retains the model's original unscored diagnostic; it does not invent confidence in the resulting zero.

`server\analyses\qc-diagnostics.ts` exports `readAnalysisQcDiagnostics(blobs, context, signal?)`, where `AnalysisQcDiagnosticsReadContext` contains `{ run, comparison, result, resumeSnapshot, targetSnapshot }` for the exact result selected through `current-results.ts`. It also exports `parseAnalysisQcDiagnostics`, `assertAnalysisQcDiagnosticsBinding`, and `createAnalysisQcDiagnosticsSidecar`.

The reader returns `AnalysisQcDiagnosticsContext` with per-criterion states `recorded`, `unscored`, or `not-recorded`. Absent historical capture returns **Not recorded** without a model call. A declared missing/corrupt sidecar is an integrity failure. Corrected result projections retain the original reference but return Not recorded (`different-result`); selecting the original result still reads its unchanged diagnostic. Code-normalized ratings return `rating-normalized`, never fresh numeric confidence.
