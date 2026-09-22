# Private workspace quality control

QC records reviewer opinions and runs explicitly requested, isolated prompt experiments. It does **not** edit production scores, approve generated rubrics, train a model, rank people, or replace independent grounding.

## Application integration

Mount `createQcRouter` from `routes.ts` under `/api`, after authentication, JSON parsing, processing-policy admission, and same-origin CSRF middleware. Its dependencies are:

```ts
createQcRouter({
  repository, // WorkspaceRepository
  state,      // StateStore: existing workspace mutation leases
  config,     // Config: application origin and administrator authorization
  qc,         // optional QcDeps
  analyses,   // optional RealAnalysesDeps
  prompts,    // optional PromptRegistryService
  now,        // optional () => Date
})
```

`qc` contains `store`, `blobs`, and `workerEnabled`. Construct its adapters with `createAzureQcStore(config, credential)` and `createAzureQcBlobStore(config, credential, store)`. `QcConfig` supplies `cosmosEndpoint`, `database`, `container`, `storageAccountUrl`, `blobContainer`, and `workerEnabled`.

QC independently authorizes read membership plus the QC capability before and inside the existing workspace lease. Do not route its mutations through the content-editor write gate: reviewers deliberately cannot edit workspace content. Application administrators still need workspace membership. All responses are private and non-cacheable.

Keep configured `qc` stores available even when `Config.qcEnabled` is false. Only explicit `qcEnabled: true` admits new review, batch, plan, and prompt mutations. History, exact-result context, peer-exposure auditing, and cancellation of previously accepted work remain available when admission is off. `workerEnabled` separately gates new paid requests without blocking historical plans or evaluations.

`QcCapabilities.admissionEnabled` is a required boolean for new QC changes. Both capability `writable` and comparison-context `writable` remain lifecycle-only; never overwrite either with the admission flag or apply that flag to ordinary workspace permissions. Admission-off projects `improvements: false` and plan `canEdit: false` / `canActivate: false`, but preserves the separately authorized, lifecycle-checked `canCancel`. Keep saved history tabs visible, and gate Cancel on its own capability and active-work state rather than new-work admission.

Register `createQcLifecycleParticipant(qc)` with workspace lifecycle processing and recovery. For `RealAnalysesDeps.qcLifecycle`, use `createQcRunLifecycleHooks(qc)`: it exports the exact `setRunState(workspaceId, runId, state, timestamp)` and `purgeRun(workspaceId, runId, timestamp)` hooks. Hold the existing workspace lease and await these hooks inside the durable analysis lifecycle operation, before purging original analysis evidence. Configured but unavailable QC dependencies must block lifecycle completion, not be skipped.

The equivalent lower-level calls are:

1. `setQcRunState(qc, workspaceId, runId, state, timestamp)` before archive, restore, or deletion publication.
2. `cancelQcRun(qc, workspaceId, runId, timestamp)` after archiving or beginning deletion.
3. `purgeQcRun(qc, workspaceId, runId, timestamp)` during deletion, after a `deleting` fence exists.

The adapter fences and cancels on archive/deletion, and drains interrupted cancellation before restoring an active state. An unchanged active state, including a rename, does not cancel accepted work. Archive retains readable feedback but prevents edits and late worker publication. Restore does not silently restart cancelled paid work. Deleting a source run removes its reviews and each dependent multi-run plan's entire private pack, history, work, and evaluations. Recovery resumes incomplete cancellation/deletion from durable flags. Control tombstones remain; no separately retained training corpus does.

Repeated `deleting` notifications after QC has already purged a run preserve its `deleted` tombstone while analysis cleanup finishes. QC writability also requires any durable analysis lifecycle operation to be complete, even if that analysis control already reports an active state.

## HTTP contract

All paths below are relative to `/api/workspaces/:workspaceId/qc`.

| Method | Path | Result / request |
| --- | --- | --- |
| GET | `/capabilities` | `QcCapabilities` |
| GET | `/context?runId=...&comparisonId=...&resultRevision=...` | `QcComparisonContext`; omit revision for current, specify it for exact historical evidence |
| PUT | `/reviews` | Save own `QcReviewInput` draft; included rows validate but can be incomplete |
| POST | `/reviews/submit` | Submit own complete per-criterion `QcReviewInput` |
| GET | `/reviews/history` | Own immutable submissions; requires all four comparison-scope query fields |
| POST | `/peers` | `QcComparisonRef`; records exposure and returns latest submission per reviewer |
| GET / POST | `/batches` | Paged batches / create a coordinator's pinned comparison selection |
| GET | `/prompts` | Current immutable guidance and registry ETag |
| GET | `/prompts/history` | Bounded previously activated prompt history |
| POST | `/prompts/restore` | `{revision, reason, confirm:true}`; compatible previously activated releases only |
| GET / POST | `/plans` | Peer-gated paged plans / create frozen `QcPlanInput` |
| GET | `/plans/:id` | `QcPlanDetail`, including work/evaluation and action capabilities |
| PUT | `/plans/:id` | `{proposal: QcPlanProposal}`; creates an immutable proposal revision |
| POST | `/plans/:id/draft` | `{}`; explicitly queue paid structured planning, return 202 |
| POST | `/plans/:id/evaluate` | `{confirmPaidWork:true}`; explicitly queue paired trials, return 202 |
| POST | `/plans/:id/cancel` | `{}`; cancel queued/running work |
| POST | `/plans/:id/retry` | `{}`; explicitly retry failed/cancelled accepted work |
| POST | `/plans/:id/activate` | `{reason, confirm:true}`; exact eligible evaluation and member-administrator authorization |
| GET | `/plans/:id/history` | Immutable plan revisions, with all selected peer gates enforced |

Every mutation requires a stable UUID `Idempotency-Key`. Reuse it only for the same actor/action/payload after an ambiguous transport result. Existing review and plan edits/actions require one exact strong quoted `If-Match` ETag; restore uses the current prompt-registry ETag. Initial drafts require no existing head or `If-None-Match: *`. Missing required matches return 428; stale/create conflicts return 409; malformed keys, fields, or ETags return 400. Successful versioned responses also set `ETag`.

Pages accept `limit` (1-50) and an opaque `continuationToken`; private-page tokens bind the exact workspace, filters, author, result, and page size. Peer pagination uses the POST body for its exact comparison scope and query parameters for paging.

Submission is never inferred from untouched rows. Opinions preserve separate authors, immutable history, disagreement, unable-to-judge responses, and explicit numeric zero. Noncoordinators cannot receive peer feedback until submitting their own complete review of the same result hash **and** revision. Plans, case selection, histories, and evaluations enforce every selected gate too. Seeing peers marks later feedback nonindependent; coordinators are explicitly nonindependent. Exposure-only auditing remains possible during archive, without modifying feedback.

Reviewer-authored plans are editable by their creator; coordinators may manage shared plans. Only a current member with application-administrator authority can activate or restore app-wide prompts. Published candidates are immutable.

Both publication paths pass a guard through the registry to its final pointer/audit CAS, after its last registry read. HTTP guards recheck current membership, administrator authority, admission and workspace metadata; service guards recheck exact plan/settings bindings, selected-run lifecycle state and the held mutation lease. Guard failures never become an ambiguous-write success. Restoring a non-baseline release must happen from its source workspace with access to its still-retained exact eligible evaluation; another workspace's membership is not sufficient. The compatible compiled baseline does not require a private source plan.

After a proposal is saved, `QcPlanDetail.trialScope` projects its exact compatible case/family pairs, including drafting/holdout purpose, from the authorized immutable pack. `baselineTrials` and `candidateTrials` describe the full evaluation's trial executions, not remaining work after checkpoint reuse or model calls; model stages, independent grounding, and bounded repairs can require additional calls. `unsupportedFamilies` identifies changed families lacking a compatible selected case and blocks evaluation admission. Before a proposal exists the optional projection is absent. Scheduling and evaluation-coverage validation share the same projection logic.

## Storage and privacy boundaries

Use private Cosmos `qc-records`, partitioned by `/workspaceId`, and private Blob `qc-sources`. Each record and artifact is strictly parsed. Native Cosmos batches fence exact workspace/run controls, affected parent plans, and mutated ETags. Blob objects are content-addressed as `workspaceId/ownerId/sha256.json`, conditionally created and verified against their bytes, metadata, and digest.

Paid-work acceptance captures the workspace and every selected run's lifecycle generation in its immutable private request receipt. Claims, checkpoints, heartbeats, and terminal publication must match those generations and atomically compare the current control ETags. Generations change only on lifecycle transitions; ordinary review/heartbeat ETag changes remain valid. An archive/restore cycle therefore cannot revive an old worker even after the live state reads active again.

Complete selected evidence, reference documents, saved results, and chosen attributable submissions are frozen into a case pack. Historical/corrected results use the production current-result resolver and production validators. Original confidence sidecars are read only when properly bound; absent historical sidecars remain "not recorded." Corrected/normalized scores do not acquire invented fresh confidence.

Limits include 25 cases, 100 selected submissions, 20 criteria, 500 comparisons per batch, at most 90 distinct batch runs, 50 rows per page, 16 MiB per immutable artifact, 1 MiB per record, and 1.8 MB per transactional batch. Oversized evidence must be explicitly narrowed or partitioned; it is never silently truncated. Current immutable prompt guidance is limited to 4,000 characters per family, and activation/restore rationales to 1,000; private review and prompt-change explanations remain 2,000.

Artifact writers reserve a finite 90-second private record, use bounded 30-second Blob requests and a 60-second lease, and recheck lifecycle fencing. Interrupted captures retain run ownership so deletion can remove them. Cleanup may return a retryable unavailable response while a bounded writer drains; it never removes the deletion fence.

Cancelling running work atomically preserves its last worker-lease expiry as a private drain reservation, including manual cancellation before deletion. Run and workspace purge wait for these finite reservations as well as Blob writers; they cannot prematurely erase the lease evidence by clearing the cancelled work's lease. Drain reservations contain only scoped identifiers and timestamps, and are deleted during purge. Retained control tombstones contain no feedback, plan, or source text.

Do not log review prose, source text, model responses, or rationale bodies. Worker telemetry contains static codes and counts only.

## Dedicated worker and settings rollout

Build `worker\qc-index.ts` as `qc-worker.mjs` and `worker\qc\runtime.ts` as `qc-runtime.mjs`. The runtime exports `RUNTIME_SETTINGS_VERSION`, `PROMPT_RUNTIME_VERSION`, and `QC_RUNTIME_VERSION`; QC's current runtime identifier is `score-qc-worker-v1`.

Grant its dedicated identity only:

- Read/write to `qc-records` and `qc-sources`.
- Read-only `application-settings`.
- The configured Azure Foundry model role.

Do not grant live workspace-directory, job, grade, resume, analysis, extraction, renderer, or prompt-publication permissions. Model adapters operate entirely on frozen private packs; the worker cannot publish global prompt revisions. At explicit evaluation admission the application uses the registry's pure `createPromptCandidate` helper and saves its complete pinned snapshot only in the private QC checkpoint. Planning and evaluation do not register global candidate documents. Authorized activation passes that exact evaluated snapshot to the real registry for create-only registration and pointer CAS, without rebuilding its hashes or requiring a pre-registration read.

Required environment:

| Variable | Meaning |
| --- | --- |
| `AZURE_TENANT_ID` | Directory tenant UUID |
| `AZURE_CLIENT_ID` | Dedicated managed identity UUID; required when hosted |
| `COSMOS_ENDPOINT` | Azure Cosmos HTTPS account root |
| `STORAGE_ACCOUNT_URL` | Azure Blob HTTPS account root |
| `SCORE_SETTINGS_CONTAINER` | Must be `application-settings` |
| `RUBRIC_MODEL_ENDPOINT` | Azure OpenAI HTTPS account root |
| `RUBRIC_MODEL_DEPLOYMENT` / `RUBRIC_MODEL_NAME` | Validated bootstrap model binding |

Optional environment: `COSMOS_DATABASE` defaults to `score`; `QC_RECORDS_CONTAINER` must be `qc-records`; `QC_SOURCE_CONTAINER` must be `qc-sources`; `QC_WORKER_MAX_ITEMS` defaults to 2 (1-10); `QC_WORKER_BUDGET_MS` defaults to 660000 (1000-660000); `RUBRIC_MODEL_REASONING_EFFORT` must be supported by the bootstrap model. `WORKER_AUTH_MODE=azure-cli` is local-development-only and is rejected in hosted/production environments.

`QC_ENABLED` and `QC_WORKER_ENABLED` are API admission flags, not worker configuration. The isolated worker neither requires nor uses them. Already accepted work can continue after new admission stops, subject to dedicated claim controls, cancellation, lifecycle generations, leases, and deadlines.

Runtime settings readers must advertise **`score-runtime-settings-v2`** before accepting global AdminSettings v2. V2 adds `ai.tasks.qcPlan`, `processing.qc`, and `workers.qc` together. A settings patch containing `{schemaVersion:2}` explicitly upgrades a v1 policy; `upgradeQcAdminSettings` and `captureQcProcessingSettings` support the same bounded upgrade. Legacy v1 settings and already accepted snapshots remain valid without fabricated task bindings or changed hashes. New QC plans explicitly upgrade a captured copy if necessary; this does not rewrite global settings.

For an existing v1 policy, the admin editor's **Add QC settings to draft** action prepares the complete v2 upgrade without changing the saved policy. QC controls appear in that draft; the upgrade takes effect only after ordinary review and publication. Discarding the draft preserves the saved v1 policy. Synthetic model probes still require their separate paid-work confirmation.

The reader capability marker is not a serialized snapshot field. Historical v1 captures retain both schema versions, their eleven task bindings, revision, timestamp, JSON bytes, and content hash; readers do not insert `runtimeVersion`, `runtimeSettingsVersion`, QC bindings, or current prompt pins. The outer processing-snapshot schema version describes prompt-pin capture, while the inner AdminSettings schema version describes QC task/policy support. Neither is rewritten to match a reader marker, and `PROMPT_RUNTIME_VERSION='score-prompt-runtime-v1'` remains an independent deployment capability.

Default QC planning uses a 16,384-token output ceiling, 240,000-byte input and 300,000-byte request budgets, and a 2,048-token safety reserve. Default QC processing allows three attempts, with 30-second base and 300-second maximum backoff. Captured task/model/retry settings govern accepted work. Current `workers.qc` controls claiming, pause, item count, and execution budget, within deployment hard ceilings; analyses-worker settings are not borrowed. Global maintenance prevents new admission without cancelling already accepted work.

Work has a 90-second lease, 15-second heartbeat, deadline cancellation, durable checkpoints, and transient-failure backoff. Both the deadline and lease are rechecked immediately before transactional publication. A completed baseline is checkpointed before buying its candidate trial; retries preserve the immutable candidate and successful prefix.

## Experiment guarantees

Planning receives only selected drafting evidence and authorized submitted feedback. Holdout evidence/feedback is excluded from planner input. Models under trial receive evidence and task guidance, never reviewer opinions or curator reference decisions.

Editable families are `jobRubric`, `gradeCompetencies`, `gradeDraft`, and `assessment`. Fixed grounding, schemas, safety contracts, and renderer placeholders cannot be changed through QC. Guidance must be generalized: known private names/identifiers, copied source passages, and reviewer prose are rejected. The strict planner records actual model identity, fixed prompt/schema hashes, exact input hash, proposal hash, and settings hash.

Baseline and candidate use identical captured evidence and task/model settings. Production job, GS, assessment, citation, qualification, weight, and independent-grounding validators are reused. GS trials reject any omitted source section before the model call and share deterministic counterfactual identity/time metadata. Full generated drafts retain citations, grade basis, qualifications, exclusions, issues, and warnings for inspection.

Only unchanged assessment criteria with explicit numeric curator references enter agreement/error denominators. New rubric meanings are never falsely matched to old numeric scores. Missing/unscored judgments are not zero. Confidence findings are bounded self-reported strata, not calibrated probabilities.

Activation binds the exact plan revision/content, candidate, case-pack selection, settings, baseline, and validated trial artifact. Failed/incomplete trials, schema/grounding failures, changed settings, changed baseline, or observed baseline/candidate model drift block activation. Selected-case results and optional holdouts remain limited diagnostics, not evidence of generalization or hiring validity.

## Focused verification

`worker-tests\fixtures\processing-settings-v1.json` retains a capture produced by the original serializer at commit `566a3d6d732e41b225bdfbdfe7dbd4b21b14aa3a`, with fixed raw snapshot and policy hashes. Compatibility tests load that historical capture rather than reconstructing a v1 fixture from current defaults, and separately verify retained baseline/candidate prompt pins and explicit QC-only upgrades. Server regressions cover v1 reads, ordinary edits, confirmed imports, exact-ETag restoration, and explicit v2 upgrades without rewriting immutable history or already accepted captures.

```powershell
node --test server-tests\quality-control.test.mjs server-tests\qc-store.test.mjs server-tests\qc-settings.test.mjs worker-tests\runtime-settings.test.mjs worker-tests\quality-improvement.test.mjs
npx tsc --noEmit --module ESNext --moduleResolution bundler --target ES2023 --esModuleInterop --skipLibCheck --strict server\qc\routes.ts worker\qc-index.ts
```
