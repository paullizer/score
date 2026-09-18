# Real analysis persistence and API

Real analysis is explicitly started **after** resume import. The server accepts only
typed real selections and exact document/version/content hashes. It never calls the
sample scorer, chooses an unapproved draft, drops an invalid selection, or invents a
score. A run contains 1–100 resume/target pairs.

## Composition and authorization

```ts
createAzureAnalysisStore(config: RealAnalysesConfig, credential: TokenCredential): AnalysisStore
createAzureAnalysisBlobStore(config: RealAnalysesConfig, credential: TokenCredential): AnalysisBlobStore

new RealAnalysisService(
  analyses: RealAnalysesDeps,
  sources?: { resumes?: RealResumesDeps; jobs?: RealJobsDeps; grades?: RealGradesDeps },
  now?: () => Date,
)

createRealAnalysesRouter({
  repository: WorkspaceRepository,
  analyses?: RealAnalysesDeps,
  resumes?: RealResumesDeps,
  jobs?: RealJobsDeps,
  grades?: RealGradesDeps,
  now?: () => Date,
}): Router
```

`RealAnalysesDeps` and `RealResumesDeps` come from their `store.ts` modules.
`RealJobsDeps` comes from `server/jobs/routes.ts`; `RealGradesDeps` is declared
in `server/grades/service.ts` and re-exported by its router.

Mount the analysis router beneath the application's authenticated,
same-origin/CSRF-protected `/api` router. It independently authorizes workspace
membership and read/write roles and sets `Cache-Control: no-store`. Missing
analysis dependencies fail closed; missing source dependencies do not prevent
reading already frozen runs.

All paths below have prefix `/api/workspaces/:workspaceId/analyses`:

| Method and suffix | Response |
| --- | --- |
| `GET /targets` | `RealAnalysisTargetsPage` |
| `GET /` | `RealAnalysesPage` |
| `POST /` | HTTP 202, `{run: RealAnalysisRunSummary}` |
| `GET /:runId` | Unwrapped `RealAnalysisRunDetail` |
| `GET /:runId/comparisons` | `RealAnalysisComparisonsPage` |
| `GET /:runId/comparisons/:comparisonId` | Unwrapped `RealAnalysisComparisonDetail` |
| `GET /:runId/comparisons/:comparisonId/documents/:documentId?version=N` | `RealAnalysisDocumentResponse` |
| `POST /:runId/retry` with `{comparisonIds?}` | `{run: RealAnalysisRunSummary}` |
| `POST /:runId/cancel` with `{}` | `{run: RealAnalysisRunSummary}` |
| `POST /:runId/comparisons/:comparisonId/retry` or `/cancel` with `{}` | `{comparison: RealAnalysisComparisonSummary}` |

Creation requires a UUID `Idempotency-Key`. Actions require one exact `If-Match`
ETag for the run or comparison being acted upon. Lists support `limit` (1–100,
default 50) and opaque `continuationToken` values bound to the workspace/list/run.
Unknown body/query fields, duplicate selections, stale hashes, foreign IDs,
sample/mixed input, and unsupported types are rejected. Document access resolves
only IDs/versions in the comparison; callers cannot supply blob names.
If independently imported sources reuse the same document ID/version, document
lookup returns HTTP 409 rather than selecting a different source by array order.
Comparison detail retains both originals for source-kind-aware inline inspection.
A GS seed and its verified normalized reference remain one captured source.
For run/comparison cancellation and comparison retry, send an empty JSON object
`{}` or a genuinely bodyless request. Bodyless run retry is equivalent to `{}`.
An undefined parsed body is not automatically considered empty: a declared
nonzero entity or unparsed transfer-encoded body is rejected rather than ignored.
Nonempty action bodies must use supported JSON and the exact action schema.

## Frozen evidence and recovery

Discovery reads all authorized ready jobs and saved job rubric versions, plus
grade heads with approval pointers. A grade's current draft is not its approval:
the resolver loads the exact approved immutable version, approval, successful
review, source set, seed, reference captures, and historical context. It checks
content hashes, ownership, exact citations, grade support, and approval bindings.
The complete approved rubric includes zero-weight exclusions and separate
unscored qualifications.

Ready resume metadata is checked against the captured profile, complete normalized
document, source capture manifest, actual original bytes, and exact quotations.
Snapshots live in `analysis-sources`, not Cosmos. Job originals and normalized GS
reference documents are copied to bounded, content-addressed evidence blobs. GS
reference libraries are never embedded in comparison records or sent wholesale to
the model. Snapshot provenance can retain original library references for
inspection, but worker reads use only copies in `analysis-sources`.

Run IDs are `analysis-run-{idempotency-key}`. The deterministic immutable
`workspace/run/manifest.json` binds the full request fingerprint, creator,
timestamp, snapshots, and deterministic pair identities. Competing or ambiguously
acknowledged publication reuses the **winning manifest**, including its original
timestamps and evidence; it does not resolve later source versions.

Initialization and cancellation use chunks of at most 25 pair writes plus one
ETag-fenced run replacement, further reduced to stay below the transaction byte
budget. Each cursor and its pair writes commit atomically. A cancelled partial run
materializes its remaining pairs as cancelled, so none are stranded or scored.
`listPending` includes recoverable initialization/cancellation and due or expired
comparison work; ordinary terminal records are excluded. Run control work is
queried first so an initializer/canceller cannot be starved by its own queued pairs.
Comparison discovery checks the current parent and pages past non-scoreable
children without letting them consume the requested ready-work limit.

A cancellation with a durable non-retryable error, or an error after three
automatic attempts, is paused instead of being polled forever. Its cancellation
fence remains effective. `POST /:runId/retry` with `{}` and the current run ETag
explicitly retries **cancellation cleanup**, resets the control attempt cycle, and
preserves the original cancellation request, cursor, manifest, and completed
results. It does not restart scoring. Selecting comparison IDs is rejected until
cleanup finishes; ordinary in-flight cancellation also remains non-retryable.
The UI should label this paused-state action **Retry cancellation**. Once cleanup
finishes, a separate ordinary retry can restart failed/cancelled comparisons.
Comparison pages are scanned until the requested runnable-work limit is filled or
the query is exhausted; children of blocked parents do not consume that limit.
Non-retryable or exhausted cancellation failures remain visible as errors but do
not consume automatic-polling slots.

Completed results and frozen inputs cannot be replaced. Retry touches only
failed/cancelled comparisons and preserves successful original evidence. Bulk
retry uses bounded transactions; a concurrent change can stop later chunks while
retaining the already-retried subset. Reloading exposes the exact remaining work.

## Worker-only shared helpers

These exports are browser-free and require **only analysis stores**, not job,
grade, resume, or legacy workspace storage access.

From `lifecycle.ts`:

```ts
advanceAnalysisRun(
  deps: RealAnalysesDeps, workspaceId: string, runId: string,
  options?: { now?: () => Date; maxChunks?: number; leaseOwner?: string; expectedAttemptId?: string },
): Promise<VersionedAnalysisEntity<RealAnalysisRunRecord>>
// maxChunks defaults to 1 and is bounded to 1–4. Repeat through durable pending work.

applyAnalysisComparisonTransition(
  run: RealAnalysisRunRecord,
  previous: RealAnalysisComparisonRecord | undefined,
  next: RealAnalysisComparisonRecord,
  timestamp: string,
): RealAnalysisRunRecord

loadAnalysisRun(store, workspaceId, runId)
loadAnalysisComparison(store, workspaceId, runId, comparisonId)
```

Before claiming/scoring, require complete initialization and no cancellation.
For claim, heartbeat, automatic retry, terminal failure, and result publication,
write the comparison and the returned progress/state update in **one**
`store.transact(workspaceId, [...])` with both observed ETags. An API cancellation
replaces that same run fence, preventing late result publication. The Azure store
rejects standalone comparison writes and parent counters inconsistent with the
transaction's actual pair transitions.

Initialization/cancellation workers should process successive bounded chunks
under one identified lease/attempt, renewing between chunks. Do not count each
successful 25-pair chunk as a failed attempt or reset its attempt counter while
the same lease is held. On exhausted/non-retryable cancellation failure, retain
the durable error and release the lease/next-attempt timer; the API's explicit
cleanup retry provides recovery without an endless automatic poison loop.
Pass both `leaseOwner` and `expectedAttemptId` from the claimed record. The helper
returns the latest run unchanged if another attempt has reclaimed it, even if the
owner label is identical, and checks again after conflicts and between chunks.
Keep worker transaction guards for current lease expiry/deadline immediately
before commit; the run ETag still atomically fences every chunk.

From `snapshots.ts`:

```ts
readAnalysisManifest(blobs: AnalysisBlobStore, run: RealAnalysisRunRecord):
  Promise<RealAnalysisInitializationManifest>

readAnalysisSnapshots(
  blobs: AnalysisBlobStore, run: RealAnalysisRunRecord,
  comparison: RealAnalysisComparisonRecord,
): Promise<{ resumeSnapshot: FrozenRealResumeSnapshot; targetSnapshot: FrozenRealAnalysisTargetSnapshot }>

readAnalysisResult(blobs, run, comparison, snapshots?): Promise<RealAnalysisResult | null>
readAnalysisReferenceDocuments(blobs, run, gradeSnapshot): Promise<ReferenceDocument[]>
readAnalysisBlob(blobs, reference, workspaceId, runId): Promise<AnalysisBlob>
putAnalysisJson(blobs, name, value): Promise<ImmutableJsonBlobReference>
assertComparisonManifestBinding(manifest, comparison): void
```

Reads verify hashes, lengths, ownership, manifest bindings, exact frozen reference
versions, and result evidence. Missing/corrupt completed artifacts throw; they do
not become null successes. `readAnalysisResult` returns null only for a comparison
without a completed result.

From `validation.ts`:

```ts
parseAnalysisEntity(value: unknown): AnalysisEntity
analysisCancellationNeedsRetry(run: RealAnalysisRunRecord): boolean
parseAnalysisInitializationManifest(value: unknown): RealAnalysisInitializationManifest
parseFrozenResumeSnapshot(value: unknown): FrozenRealResumeSnapshot
parseFrozenTargetSnapshot(value: unknown): FrozenRealAnalysisTargetSnapshot
parseAnalysisResult(value: unknown): RealAnalysisResult
parseAnalysisAssessmentOutput(value: unknown): RealAnalysisAssessmentOutput
analysisRequirementEvidenceForInput(
  input: Pick<RealAnalysisAssessmentInput, 'rubric' | 'qualifications'>
): FrozenRequirementEvidence[]
validateAnalysisAssessment(output, resumeDocument, targetSnapshot): string[]
assertAnalysisResultBinding(result, run, comparison, resumeSnapshot, targetSnapshot): void
analysisHash(value: unknown): string // Canonical content hash, including assessment provenance.
analysisAssessmentHash(assessment: RealAnalysisAssessmentOutput): string
analysisBytesHash(bytes: Uint8Array): string // Actual stored Blob byte digest.
analysisResultBlobName(workspaceId, runId, comparisonId, attemptId): string
```

Results are stored at `workspace/run/results/comparison/attempt-uuid.json`.
`deterministic.ts` is the dependency-light shared core (Node crypto and domain
types only). It exports `analysisHash`, `analysisAssessmentHash`,
`analysisRequirementEvidenceForInput`, and `calculateAnalysisSummary`; the
validation module re-exports them for existing callers. The model helper uses
this same core as API result validation. Its public calculator additionally
validates and orders rows against the saved rubric, rather than maintaining
separate arithmetic. Semantic content hashes retain the previous canonical
sorted-JSON encoding; Blob/snapshot hashes still use their actual stored bytes.
Requirement rows preserve rubric/qualification order and first-occurrence citation
order. Exact repeated citations are deduplicated in requirement rows, including
qualifications, without changing the approved rubric or qualification records.
Grade criterion citations combine `sourceCitations` and `gradeBasis`; qualification
citations never become scored work evidence.
The compatibility wrapper also accepts
`analysisRequirementEvidence({kind: 'grade', version: {rubric, qualifications}})`;
no fabricated version provenance or type cast is needed for model-side derivation.
These pure helpers derive citation rows only; frozen approval authorization remains
the resolver's responsibility.

`parseAnalysisResult` checks the independently reviewed assessment hash,
snapshot/manifest/attempt provenance, deterministic one-decimal weighted total,
coverage, limitations, and human-review marker. The separate model/grounding
worker must perform semantic review; exact-string/schema checks alone do not
establish support. Qualification limitations can make completion `limited`
without withholding an otherwise fully assessable work score.

Do not log raw documents, profiles, source URLs, model responses, or validation
errors containing those values. These are retained private captures, not browser
sample state; sample reset does not delete them. Failed pre-publication attempts
can leave private immutable preparation blobs. Retention/deletion administration
is a separate feature.

Focused validation (independently bundles its own entry point):

```powershell
node --test server-tests\real-analyses.test.mjs server-tests\real-analyses-azure-store.test.mjs server-tests\real-analyses-model-boundary.test.mjs
npx tsc --project tsconfig.server.json --noEmit
npx eslint server\analyses server-tests\real-analyses*.mjs --quiet
```

The model-boundary tests exercise the actual assessment/grounding adapter with a
test HTTP transport, then persist its normalized output and read it through API
validation. They cover fractional weights and correction provenance, preserved GS
exclusions, unscored qualification limits, canonical hash stability, and withheld
results. They do not substitute a synthetic result for the model adapter.
