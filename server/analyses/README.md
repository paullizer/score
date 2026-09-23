# Real analysis persistence and API

Real analysis is explicitly started **after** resume import. The server accepts only
typed real selections and exact document/version/content hashes. It never chooses
an unapproved draft, drops an invalid selection, or invents a score. A run contains
1–500 resume/target pairs. The cap is on the total pair count,
so 103 resumes against four targets fit in one 412-comparison run. Larger runs use
the same worker concurrency and bounded processing, not a higher processing rate.

Ready Markdown, DOCX, and legacy DOC resumes/jobs are supported real inputs alongside PDF/HTML.
Markdown and Word are file-upload only. Those jobs can also appear as captured GS seeds, but
neither format is an independent agency/OPM reference upload or URL format. None of this starts scoring
automatically.

## Composition and authorization

```ts
createAzureAnalysisStore(config: RealAnalysesConfig, credential: TokenCredential): AnalysisStore
createAzureAnalysisBlobStore(config: RealAnalysesConfig, credential: TokenCredential): AnalysisBlobStore

new RealAnalysisService(
  analyses: RealAnalysesDeps,
  sources?: { resumes?: RealResumesDeps; jobs?: RealJobsDeps; grades?: RealGradesDeps },
  now?: () => Date,
  settings?: ProcessingSettingsProvider,
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
Every HTTP mutation awaits `repository.withWorkspaceMutation` for its entire
handler. Ordinary writes require an active workspace/run; lifecycle management
uses `manage` and remains available on archived workspaces. Publication checks
the workspace mutation lease again immediately before writing.
`WORD_DOCUMENT_IMPORTS_ENABLED` gates new job/resume Word admissions, not analysis source
schemas or historical reads. Upgraded validators must accept already-frozen Word evidence
even while that flag is off. Real analysis creation still needs its existing configured
source services and explicit user request; no additional storage or identity grant is needed.
Markdown intake follows the advertised `markdownJobImports` / `markdownResumeImports` real-service
capabilities, without a new global environment flag. The Word gate does not control Markdown.

All paths below have prefix `/api/workspaces/:workspaceId/analyses`:

| Method and suffix | Response |
| --- | --- |
| `GET /targets` | `RealAnalysisTargetsPage` |
| `GET /` | `RealAnalysesPage` |
| `POST /` | HTTP 202, `{run: RealAnalysisRunSummary}` |
| `GET /:runId` | Unwrapped `RealAnalysisRunDetail` |
| `PATCH /:runId/metadata` with `{displayName: string}` | `{run: RealAnalysisRunSummary}` and ETag header |
| `GET /:runId/lifecycle` | `{impact: LifecycleImpact}` |
| `POST /:runId/lifecycle` with `{action: "archive" \| "unarchive" \| "delete"}` | `{analysis: RealAnalysisDetail}` or `{deleted: true}`; HTTP 202 `{operation, etag?, analysis?}` while incomplete |
| `GET /:runId/comparisons` | `RealAnalysisComparisonsPage` |
| `GET /:runId/comparisons/:comparisonId` | Unwrapped `RealAnalysisComparisonDetail` |
| `GET /:runId/comparisons/:comparisonId/diagnostics?continuationToken=...` | `RealAnalysisDiagnosticsPage`; at most one private failed-attempt artifact per page |
| `GET /:runId/comparisons/:comparisonId/corrections/preview` | Owner/editor-only `AnalysisCorrectionPreview`; read-only before/after totals, exact ETag and result hashes |
| `GET /:runId/comparisons/:comparisonId/corrections` | Owner/editor-only `{correction}`; cheap status without loading evidence blobs |
| `POST /:runId/comparisons/:comparisonId/corrections` with `{policyVersion, resultSha256, criterionIds, reason}` | HTTP 202 `AnalysisCorrectionResponse`; exact preview policy, `If-Match`, and UUID `Idempotency-Key`; omitted policy retains legacy v1 semantics |
| `POST /:runId/comparisons/:comparisonId/corrections/cancel` with `{}` | `AnalysisCorrectionResponse`; exact correction-head `If-Match` |
| `GET /:runId/comparisons/:comparisonId/corrections/history?continuationToken=...` | Owner/editor-only immutable original assessment and up to 12 correction checkpoints |
| `GET /:runId/comparisons/:comparisonId/documents/:documentId?version=N` | `RealAnalysisDocumentResponse` |
| `GET /:runId/summaries` with optional `targetId` query | `RealAnalysisSummariesResponse`, including selected-scope ETag, status, published narratives, and report capture pins |
| `GET /:runId/summaries/:kind/:subjectId` | `RealAnalysisSummarySubjectResponse`; one candidate summary or exact target overview, with its own revision and ETag |
| `POST /:runId/summaries` with `{mode: "missing" \| "all", targetId?}` | `RealAnalysisSummariesMutationResponse` with durable request ID, scheduled counts, and summary state |
| `GET /:runId/summaries/:kind/:subjectId/history?continuationToken=...` | Owner/editor-only `AnalysisSummaryHistoryPage`, up to 12 private checkpoint events and the narrative record ETag |
| `POST /:runId/summaries/:kind/:subjectId/publish` with `{generationId, round, outputSha256}` | `{summaries}` for the subject's exact target; explicit manual approval of a persisted final draft |
| `POST /:runId/summaries/:kind/:subjectId/retry` with `{}` | HTTP 202 `{summaries}` for the subject's exact target; failed/cancelled work resumes its captured generation and remaining review budget |
| `POST /:runId/summaries/:kind/:subjectId/restart` with `{confirmRestart: true}` | HTTP 202 `{summaries}` for the exact target; explicitly supersedes one subject with a new generation using current settings |
| `POST /:runId/retry` with `{comparisonIds?}` | `{run: RealAnalysisRunSummary}` |
| `POST /:runId/cancel` with `{}` | `{run: RealAnalysisRunSummary}` |
| `POST /:runId/comparisons/:comparisonId/retry` or `/cancel` with `{}` | `{comparison: RealAnalysisComparisonSummary}` |

Creation requires a UUID `Idempotency-Key`. Scoring/lifecycle actions require one exact `If-Match`
ETag for the run or comparison being acted upon. Summary generation uses a stable UUID
`Idempotency-Key` and the **selected summary scope's ETag**, not a run or comparison
ETag. Lists support `limit` (1–100,
default 50) and opaque `continuationToken` values bound to the workspace/list/run.
Unknown body/query fields, duplicate selections, stale hashes, foreign IDs,
non-real, mixed, and unsupported input types are rejected. Document access resolves
only IDs/versions in the comparison; callers cannot supply blob names.
If independently imported sources reuse the same document ID/version, document
lookup returns HTTP 409 rather than selecting a different source by array order.
Comparison detail retains both originals for source-kind-aware inline inspection.
Diagnostic history accepts only its optional continuation token, not `limit` or
caller-supplied blob paths. Tokens and artifact references are bound to the exact
workspace, run, and comparison. Viewer roles may read the same private evidence
as other workspace members; outsiders and unauthenticated callers cannot.
A GS seed and its verified normalized reference remain one captured source.
For run/comparison cancellation and comparison retry, send an empty JSON object
`{}` or a genuinely bodyless request. Bodyless run retry is equivalent to `{}`.
An undefined parsed body is not automatically considered empty: a declared
nonzero entity or unparsed transfer-encoded body is rejected rather than ignored.
Nonempty action bodies must use supported JSON and the exact action schema.
Lifecycle actions always require the **run** ETag, never a comparison ETag.
`RealAnalysisDetail` is an alias of the existing `RealAnalysisRunDetail`.

## Human QC and prompt calibration

Human feedback is a separate API under `/api/workspaces/:workspaceId/qc`, never a
mutation of a production comparison. Reviewers have saved-evidence read access
but no ordinary analysis writes. Owners, editors, and workspace-member application
admins can also QC; being an application admin is not a workspace membership bypass.
Original-download/report policies continue to apply independently.

Every review binds the exact run, comparison, selected result revision, and result
hash. Drafts may be incomplete; submissions cover every saved criterion and create
immutable attributable history. Peer access is checked for that exact result on
review, case-pack, plan, and evaluation reads. Coordinator aggregation is explicit
and records peer exposure; a later submission cannot be reported as independent.

New full assessments capture confidence/ambiguity from their final accepted
assessment call in a bound sidecar. Canonical score payloads and historical hashes
are unchanged. Legacy comparisons without a sidecar remain readable and report
that diagnostics were not recorded; opening QC never triggers model work.
Scoped evidence corrections do not invent a new model-confidence assessment.

Accepted processing snapshots pin immutable prompt bundles in addition to model
settings. Retries and multistage generation retain those pins. QC trials write only
to their dedicated private stores, use frozen inputs and captured settings, and
never update production analysis heads. App-wide activation requires an application
admin, an exact evaluated proposal, the unchanged baseline and version guards, and
an explicit reason. Fixed scoring/evidence/grounding contracts are not editable
guidance. Existing saved rubrics are never regenerated by prompt activation.

When QC storage is configured, `RealAnalysesDeps.qcLifecycle` participates in every
durable analysis lifecycle operation. Archive fences QC work; delete waits for
QC cancellation, writer draining, review cleanup, and dependent case-pack/evaluation
invalidation **before** deleting analysis records or source snapshots. An unavailable
QC store leaves an explicit recoverable cleanup operation, rather than skipping
private artifacts. The QC workspace participant is fenced before the analysis
participant so inherited archive state is not mistaken for an individual archive.

## Missing evidence and reviewed result corrections

A successfully reviewed source without supporting evidence for an applicable
professional criterion is `missing`, with score `0` and no purported supporting
citations. Professional confidentiality/compliance is not a protected personal
trait. Zero describes the submitted evidence, not personal inability or a legal
finding. Newly generated zero anchors use this interpretation; historical frozen
rubric wording and hashes are never rewritten.

The assessment and independent grounding contracts explicitly distinguish evidence
gaps from genuine blockers. Source-quality/context failures, ambiguous requirements,
restricted personal-trait inferences, and failed processing must not become invented
zeros. GS exclusions stay zero-weight and unscored; separate qualifications remain
unscored. The deterministic calculator is unchanged: missing evidence retains its
full original weight, totals are not renormalized, and an entirely missing-evidence
assessment can be an available `0/100`.

Completed comparisons and original result bytes remain immutable. An
`analysis-correction:<runId>:<comparisonId>` head stores a separately guarded
current publication and durable worker state. Every explicit request binds its
actor, reason, selected criterion IDs, exact base/original result hashes, frozen
snapshots, manifest, and explicit correction policy. New previews use
`missing-evidence-zero-v2`. Its immutable proposal
only changes selected unassessed evidence-gap rows, related limitations/coverage,
and the deterministic explanation and total. Contextual citations alone do not
establish support or determine correction eligibility.

Preview eligibility means eligible for evidence-gap verification, not guaranteed
publication. The preview total is hypothetical, and HTTP 202 acknowledges queued
work rather than a published score. The v2 worker inspects the complete frozen
resume against only the selected requirements, not the unchanged numeric scores.
Each selected criterion must receive an exact, source-bound decision:

- `confirmed-missing`: successfully reviewed source contains no qualifying
  support; deterministic code assigns zero at the original weight.
- `evidence-found`: exact supporting passages were identified; do not substitute
  zero or silently rescore an unrelated criterion.
- `blocked`: a concrete unusable-source, ambiguous-guidance, or
  restricted-personal-characteristic reason prevents the conversion.

Only an all-confirmed-missing selection can publish its exact proposal. Service
outages, incomplete output, refusals, and context exhaustion are failed work, not
missing evidence. Private history retains decisions and source-bound findings;
the correction workflow exposes these findings without loading full histories
on every status poll.

An old criterion-level `source-quality` label without a structured blocker may
enter v2 verification; that generic historical label alone does not prove the
source was unusable. Explicit unusable-source blockers, processing/context
limitations, global source failures, and protected-trait safeguards still prevent
automatic correction. V1 eligibility remains unchanged.

The result retains original assessor attribution and explicitly records scoped
review provenance, its base assessment hash, and selected criteria. A scoped
review does not claim to reapprove unchanged scores and cannot replace full
grounding review for an ordinary assessment. Publication validates the approved
base and the exact unchanged-field transformation. Failed, cancelled, expired, or superseded work cannot
replace the last publication. Publication atomically fences the correction head,
run counts, lifecycle/cancellation state, and revision-bound summary scheduling.
Replay cannot double-count the recovered score.

Existing `missing-evidence-zero-v1` results, histories, proposals, and request
fingerprints remain readable and valid. Omitted request policy means v1, not an
implicit upgrade. Accepted v1 work retains its original full-assessment review;
a fresh preview and new explicit v2 request are needed to change review scope.
Reusing a v1 key with v2 consent is a conflict. The v1 workflow's full reviewer
could reject unrelated saved scores, while its immutable proposal could not
repair them; this is why a calculated preview did not guarantee publication.

New assessment drafts use the same scoped gap/blocker distinction before their
ordinary full grounding review. Confirmed absence is normalized to zero; actual
support returns to bounded assessment repair, and genuine blockers retain a
machine-readable `blockerCode` alongside legacy limitation codes. A processing
failure never becomes a completed zero.

New correction proposals capture application processing settings independently of
the original assessment. They require processing admission and respect maintenance
pauses, but do not require live source services or new-run admission. The independent
review uses the captured `assessmentReview` deployment, input/output budgets,
correction limit, automatic attempts, and retry backoff. Accepted proposal replay
and automatic retries retain that policy; historical reads and cancellation do not
require new-work admission. Unpinned legacy proposals use the immutable legacy
policy, never the current revision. Automatic replacement summaries use the
correction's captured summary mode and model bindings, without changing the
original comparison's processing settings.

All current readers resolve this head, including list/detail, report batches, and
summary inputs. `comparison.resultRevision` is a read projection and must never be
persisted over the original comparison record. Detail and candidate-summary reads
add only one constant correction-head lookup. Lists and target metadata use bounded
run-scoped head queries, not one lookup per comparison. Original results and every
prior candidate narrative publication remain available in private correction
history; rejected proposals and failed review findings are distinct from published
results.

Successful application/worker deployment automatically writes
`ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED=true` to both the API and analysis worker.
There is no deployment opt-in; a saved azd value of `false` is not honored as an
opt-out. Provisioning stages both flags as `false`, and deployment preparation
closes correction API admission. The replacement analysis worker keeps correction
claims disabled during initial verification. After compatible-reader checks pass
and incompatible executions have drained, deployment confirms worker activation,
then API activation, before reopening runtime-settings admission. `-ProvisionOnly`
must be followed by `-DeployOnly`; complete worker-only rollout also enables the
feature. Failed activation attempts close both flags with readback, reporting any
unconfirmed state. Renderer-only rollout leaves API admission closed and worker
configuration unchanged. Missing flags still default off in runtime configuration.

The UI capability is `analysisEvidenceCorrections`. The gate controls new requests
and worker discovery, not historical reads or authorized cancellation of accepted
work. Turning the gate off does not reinterpret already-published revisions, but
the next successful deployment enables it again. Maintenance and role checks
remain in force. Deployment does not create correction requests: a historical
repair batch remains a separate approved action with exact-hash scope verification.

A v1-to-v2 upgrade must retain this compatible-reader/worker verification and
drain sequence before reopening admission. Incompatible older workers must not
claim new v2 requests; accepted v1 work retains its pinned review policy.

Before recovering a historical cohort, inventory actual correction statuses and
findings rather than assuming every withheld result has the same cause. Preserve
already-published revisions as controls; use one approved v2 canary and then
bounded fresh requests for the remaining eligible results. Verify persisted
scores, counters, current reader hashes, and revision-bound narratives, not just
acknowledgements. Report each remaining genuine blocker or technical failure.
After v2 publication, rollback must retain v2-compatible readers.

## Saved narrative summaries

Narratives are versioned sidecars, not modifications to completed comparison
records or their immutable results. The original `result.summary` participates in
the assessment hash and independent review; it must never be replaced by a
summary refresh. Candidate and target work records live in `analysis-records`;
immutable narrative artifacts live under the owning run in `analysis-sources`.
Public summary DTOs expose text, state, safe provenance/revision identifiers, and
capture pins, not private blob names.

Comparison detail returns the validated score and frozen evidence without reading
summary inventories or publication blobs. Its optional `narrative` field is not
required for rendering; callers load candidate summaries and target overviews
independently through the subject GET. `kind` is `candidate` or `target`;
`subjectId` is the comparison ID or exact saved target ID, respectively. The
envelope binds `workspaceId`, `runId`, `kind`, `subjectId`, `revision`, `etag`, and
the matching `narrative`. It does not expose unpublished history to viewers.
Candidate DTOs include the bound `resultSha256`; corrected-score views reject an
older or unbound narrative as current, even while it remains readable as history.

Candidate subject/history GETs accept owner/editor-only
`resultRevisionId=original` or an exact published correction request UUID. These
explicit reads echo the selected revision, keep pagination bound to that revision,
and cannot publish or retry its drafts over the current assessment. Correction
history exposes these reads lazily. Historical reads do not replace current UI
caches or report pins, and do not enqueue any work.

Candidate-summary reads use scoped point reads and do not enumerate unrelated
candidates. Target-overview reads retain the metadata needed to prove their exact
aggregate revision but do not download other candidates' published text. Complete
summary reads remain exhaustive for management and report capture, with at most
four concurrent publication reads. Read cancellation stops further storage work,
not acknowledged background generation. No private content cache survives a
request.

The subject GET ETag is a display-read revision, not a substitute for the selected
summary-scope ETag used by generation or the narrative-record ETag returned by
private history for publication/retry/restart actions.

Optional `workHealth` metadata distinguishes prerequisites, eligible queues,
provider cooldown, live leases, expired/interrupted leases, and terminal work.
It includes available request/activity/lease/retry timestamps, attempts and
captured settings identity without downloading additional evidence. The optional
`workRevision` lets polling observe lease expiry and retry eligibility even
when the existing revision/ETag is unchanged. Heartbeat-only updates do not
reset polling backoff; health never changes publication hashes, summary-scope ETags,
report capture pins or readiness, and deriving it never writes a status.

Each candidate narrative binds the exact completed result, resume/target snapshots,
and manifest hashes. Each target narrative binds the exhaustive exact-target
comparison set, including statuses, result hashes, and candidate narrative
generations/publication revisions. Lease heartbeats and unrelated target work do
not invalidate a selected scope's revision. A published prior version can remain
readable during replacement, but queued/running/failed replacement work does not
become ready merely because old text exists.

GET is read-only: opening old history or exporting a report never schedules model
work. POST accepts only the current run or one exact saved target, not labels or
arbitrary comparison subsets. `missing` reuses current candidates, retries missing
or failed narratives, and refreshes missing/outdated dependent target overviews.
`all` requests a fresh generation of all required summaries in scope without
rescoring. Request replay must not start another generation or supersede a newer
accepted request after an ambiguous response.

New completed scoring results durably schedule candidate summaries and coalesce
the affected target overview. Target synthesis waits until selected scoring has
settled and every completed comparison has a current candidate narrative. A
pending correction cohort also holds the affected overview until its reviews
settle. Published corrections get a new candidate sidecar identity containing
the correction request UUID; old sidecars are never rebound to changed result
hashes. Only changed candidates and their affected targets are regenerated. A
scoring retry invalidates the affected overview immediately; a later completion
refreshes it without regenerating unchanged candidates. Failed/cancelled
comparisons contribute processing-status facts, not invented evidence or zero
scores. A target with no completed comparisons needs no narrative.

Generation uses only the frozen analysis stores and the configured analysis
model, so it does not require live source discovery/import services. The
`analysisSummaryGeneration` feature is separate from new-run `realAnalyses`
readiness. Normal workspace write authorization, mutation leases, exact
concurrency, CSRF protection, and `no-store` responses still apply. Authorized
viewers can read ready narratives; writable, non-archived runs are required for
generation. A settled partial/cancelled run may explicitly summarize its completed
results without restarting scoring.

Version 2 summaries undergo a narrow factual review against the supplied saved
assessment, not a new assessment of the original resume. The default maximum is
three durable logical rounds: an initial draft and at most two revisions with
earlier findings carried forward; captured policy may lower that budget.
Process recovery and failed-generation resume never reset it. Sentence counts, exact wording, number
formatting, score mentions, and exhaustive sentence/reference coverage are not
publication gates. Nonempty response shapes, exact input/output bindings, and
the technical bounds in `SUMMARY_LIMITS` still apply. Large target cohorts use
bounded exhaustive reductions rather than selecting a first page or top-N
subset. Reductions retain their own history but are never selectable final
summaries.

Legacy v1 artifacts keep their original bytes, hashes, claims, and legacy
validation. V2 has `claims: []` only for storage-shape compatibility; it does
not ask the model for claims. Its output hash covers the tagged draft
`{kind: "candidate", text, overview}` or `{kind: "target", paragraphs}`.
Automatic approval requires a supported review of that exact output and input.
The v2 artifact reader does not invoke the legacy prose or citation-coverage
validators. Published v2 DTOs carry `summaryVersion: 2` and `approval`; legacy
DTOs do not invent that metadata.

### Private history and owner/editor actions

`:kind` is `candidate` or `target`; `:subjectId` is the exact frozen
comparison ID or target ID, never a label or arbitrary blob path. Owners and
editors can inspect all captured checkpoint events, including completed
generations and earlier retries. Viewers can read publications but cannot read
unpublished history or invoke summary actions. Archived history remains readable
to owners/editors; archived, deleting, and cancelling work cannot be mutated.
History GET never schedules inference or repairs old runs. A pre-upgrade failure
without captured history returns an empty history, not a reconstructed draft.

Single-summary actions require a UUID `Idempotency-Key` and the **narrative
record ETag returned by history**, not the selected summary scope's ETag.
Publication verifies the latest usable final checkpoint for the selected
generation/round and its exact current frozen input. A changed output, stale
input, foreign subject, or racing generation is rejected. Explicit manual
approval retains the selected draft, original failed or absent review, known
issues, actor, and approval timestamp. It neither fabricates a supported
verdict nor claims a worker lease. Published text and narrative-bearing reports
must disclose manual approval and its known issues.

An immutable action reservation plus the committed request/generation identity
reconciles ambiguous responses. Replaying a committed action does not repeat
approval or create another generation; replay over newer work is rejected.
Retry of failed/cancelled work retains its generation, captured settings,
checkpoints and remaining review budget. Legacy retry calls for other states
retain their existing new-generation behavior. New clients use `canResume` for
the resume control and `canRestart` for an explicitly confirmed restart;
`canRetry` remains available for older clients.

Restart always creates a new generation, captures current model/task settings
and a new bounded review budget, and applies current new-work admission. It
preserves previous publications and the entire private history while fencing
late writes from the superseded generation. Compatible earlier draft/findings
may seed feedback, but do not substitute for new-generation model calls.
Candidate retry, restart or manual publication queues only its dependent target
overview through the existing narrative constructors. A target restart leaves
every candidate and unrelated target unchanged. These actions never modify
scores or frozen result/evidence bytes.

Checkpoint blobs use
`<workspace>/<run>/narrative-history/<kind>/<subject>/<generation>/<attempt>/<entry>.json`;
action reservations use `<workspace>/<run>/narrative-actions/<request>.json`.
Each immutable checkpoint links its predecessor, keeping Cosmos records bounded
to a history head and optional `summaryRound`. Writers verify the stored bytes
before advancing that head. Resume reads include every current-generation phase
and a compatible prior final draft/review seed; corrupt, missing, cyclic, or
over-budget history fails explicitly rather than silently dropping rounds.
History pages are scope-bound and pinned to a history head; reload the first page
if new checkpoints invalidate a continuation token.

History capture failures are distinct from factual disagreements
(`history-write-failed` versus `factual-review` diagnostics). Full drafts and
review text belong only in private artifacts and authorized history responses.
Routine audit events record allowlisted action/subject/generation/request IDs,
rounds, outcome and issue codes/counts, never drafts, reviewer messages, source
passages, private URLs, or raw model responses.

Worker events and API action audits are single-line JSON with
`component: "score-analysis-narrative"` and
`pipelineVersion: "score-analysis-summaries-v2"`. Model events preserve HTTP
status, safe request/call IDs, measured request budgets, timing, and completion
finish reasons. Optional `diagnostic.httpStatus` and `diagnostic.retryAt` survive
checkpoints and runtime failures. Provider cooldown is checkpointed before
sleeping and defers durably when it exceeds a cancellable operation deadline;
`nextAttemptAt` cannot precede either the provider time or captured policy
backoff. Deploy compatible strict readers before these new optional fields are
written. A transport or storage failure is not a factual-review verdict.
For worker diagnostics in the Container Apps Log Analytics table:

```kusto
ContainerAppConsoleLogs
| where TimeGenerated > ago(24h)
| extend Event = parse_json(Log)
| where tostring(Event.component) == "score-analysis-narrative"
| where tostring(Event.runId) == "<analysis-run-id>"
| project TimeGenerated, event = Event.event, stage = Event.stage,
    round = Event.round, code = Event.code, reason = Event.reason,
    httpStatus = Event.httpStatus, finishReason = Event.finishReason,
    comparisonId = Event.comparisonId, generationId = Event.generationId,
    modelCallId = Event.modelCallId, reviewOutcome = Event.reviewOutcome
| order by TimeGenerated asc
```

API approval/retry audit events use the same component in the web app's logs.

Worker claims, heartbeats, retries, and publication use independent narrative
attempt/generation fences in addition to current run/workspace lifecycle
controls. Cancellation, archive, and deletion prevent late publication. Cleanup
includes narrative records, versions, request artifacts, checkpoint history, and
action reservations, including orphaned immutable uploads; late Blob writers
must not recreate deleted content. New sidecar writes count toward the same
transaction operation/byte limits as scoring and initialization.

PDF, Word, and PowerPoint require current summaries for their complete selected scope.
Summary responses include authoritative report-capture pins; clients verify exact
comparison/result/narrative identities during collection and recheck the selected
revision before download. A stale or missing narrative aborts these exports
rather than mixing generations or generating prose on demand. CSV retains its
existing contract and remains independent of narrative readiness. PDF and Word
share one content pipeline, including the same selected scope, saved narratives,
featured reviews, completed-candidate overview, and authenticated source links.
Client polling must continue after scoring is terminal and follow summary
revisions, because regenerating a narrative never changes a completed
comparison's ETag.

Deploy compatible schema readers, lifecycle handlers, API, and report clients
before enabling workers that write narrative records. Historical source/results
remain unchanged, and older analyses are not backfilled by reading them. Retain
compatible readers on rollback once narrative history exists; no additional
storage resource or broader worker identity grant is required.

## Display names

Metadata PATCH accepts only a JSON object with `displayName`, requires the exact
current run `If-Match`, and rejects extra body/query fields. Names are trimmed,
must contain 1–160 JavaScript string characters after trimming, and cannot
contain control characters or line separators. Missing ETags return 428; wildcard,
weak, or multiple ETags are invalid, and stale ETags return 409. Workspace
membership, CSRF, mutation leases, and active workspace/run checks match other
ordinary writes; archived or removing records cannot be renamed.

The optional top-level `displayName` is a cosmetic override. A successful write
changes only that field and `updatedAt`: it does not retry/cancel model work or
rewrite progress, comparisons, results, citations, private failure diagnostics,
or evidence. The original
`name` remains immutable and must still equal `manifest.request.name`.
Existing analysis history can be renamed without live job/resume/grade services.

New analyses capture optional source aliases in resume and target summaries.
Frozen resume snapshots carry the captured alias separately from the canonical
resume/profile; target snapshots keep it in `summary.displayName`, while
`summary.label` remains the original job title or approved rubric name. Snapshot
hashes and summary bindings include this metadata. Later source renames never
update old comparisons, manifests, or reports, including records with no alias.
Aliases are not supplied to assessment or grounding models. Worker initialization,
leases, retries, progress, and conditional result publication preserve the latest
run alias.

Saved-summary selectors use captured target aliases without changing exact-target
scope or regenerating evidence. PDF, Word, and PowerPoint carry the current run
title and captured candidate/target aliases while retaining source-stated candidate
names and the canonical frozen job title, separately from the organization.
Aliases do not restore legacy combined job/organization headings or replace saved
narrative text. PDF and Word continue to share the same report content.

## Frozen evidence and recovery

Discovery reads all authorized ready jobs and saved job rubric versions, plus
grade heads with approval pointers. Archived/removing workspaces, resumes, jobs,
logical job rubrics, ladders, grade heads, and approved grade seed jobs are not
eligible for new work. Explicit scoring retries revalidate the exact selected
sources under the workspace mutation lease. A grade's current draft is not its approval:
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

Frozen Markdown and Word sources preserve their real MIME types and `.md`/`.docx`/`.doc` suffixes,
rather than falling through to `.html` or being converted to PDF. `.markdown` uploads retain
their display filename but use the canonical `.md` blob suffix. Copied job/GS-seed originals retain
their immutable byte hashes, lengths, ownership, and capture bindings. Resume snapshots
retain the existing immutable-original-reference policy; these formats do not broaden the
analysis worker's access to resume/job/grade containers. Existing snapshots and their
hashes are not rewritten or supplied new defaults on read.

Markdown is strictly decoded as UTF-8 and extracted locally with `marked`; provenance uses
`markdown-sections` and a null physical page count. Headings, lists, tables, and code become
ordered citable text. Embedded HTML and front matter stay inert text, and linked images/assets
are not fetched. The evidence viewer never executes Markdown or renders it as HTML.

DOCX source text comes from the existing Azure Document Intelligence service; legacy DOC
text comes from local pure-Node binary Word extraction with method/version provenance.
Word documents use **captured sections** and a null physical page count. Stable paragraph
identities and exact quotations remain authoritative; DOCX service processing units and
Word section indices must not be displayed as printed-page numbers or validated against
the PDF-only 50-page limit. Resume extraction records retain `pageCount: null`; the existing
normalized GS seed-reference model retains `pageCount: 1` as a captured-section count,
not a physical Word page count. The original 10 MiB upload, 10-input batch, and 180,000 normalized
source-character limits apply to Markdown and Word intake. Word-image OCR is not supported: use
the existing PDF/OCR path when meaningful content is image-only.

Optional formatted DOCX previews are approximate, sanitized Mammoth output in a sandbox,
not frozen assessment evidence or Word page fidelity. DOC displays extracted text. Preview
failure cannot replace the stored evidence or change citations. Original bytes stay private;
do not add public Office/Google viewers or third-party conversion services to inspect them.
Citation selection must return to the authoritative extracted evidence view.

Run IDs are `analysis-run-{idempotency-key}`. The deterministic immutable
`workspace/run/manifest.json` binds the full request fingerprint, creator,
timestamp, snapshots, and deterministic pair identities. Competing or ambiguously
acknowledged publication reuses the **winning manifest**, including its original
timestamps and evidence; it does not resolve later source versions.
Before an **unpublished** manifest is admitted as a run, its exact selections
must still be eligible in the live libraries. A retained preparation is not
permission to recreate deleted inputs. Revalidation never rewrites the winning
manifest; historical inspection and already-admitted processing still use only
the immutable captures.

Initialization and cancellation use chunks of at most 25 pair writes plus one
ETag-fenced run replacement, further reduced to stay below the transaction byte
budget. Each publication transaction also includes same-partition workspace and
run lifecycle control CAS operations (at most 28 Cosmos operations in total).
Each cursor and its pair writes commit atomically. A cancelled partial run
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

### Private failed-attempt diagnostics

`src/domain/analysis-diagnostics.ts` defines the versioned artifact contract and
the privacy-safe telemetry vocabulary. Each failed worker attempt can save
`workspace/run/diagnostics/comparison/attempt-uuid.json` through the existing
lifecycle-fenced immutable Blob writer. Artifacts bind the attempt, manifest,
resume and target snapshot hashes, pipeline version, error category and stage,
correction/processing counts, safe schema/citation findings, and at most 64 safe
events. They retain up to three validated assessment checkpoints with their
actual independent reviews, assessment hashes, source hashes, and model-call
provenance. Invalid raw model output and arbitrary validation messages are never
stored. Reviewer prose and canonical citations stay in the private artifact,
not operational logs or inline Cosmos records.

An optional `failureDiagnostic` field holds only the newest immutable reference;
each artifact's optional `previous` reference links the prior captured attempt.
The optional `diagnosticCapture` field distinguishes `saved` from `unavailable`
for a particular attempt. A write/read-back failure preserves the original
processing error and any older diagnostic head, and emits the safe
`diagnostic-write-failed` event. Ambiguous successful uploads reuse verified
winning bytes instead of repeating inference. Cancellation or ownership loss
cannot publish a late reference. Retry and subsequent completion preserve the
history without changing frozen inputs or completed result scores.

`readAnalysisFailureDiagnostics` in `diagnostics.ts` verifies the reference, stored
byte digest and length, scoped identities, source bindings, assessment hashes,
review scopes, and canonical citations before returning one artifact. History
is never embedded in comparison-list responses. Deleting/deleted runs cannot
expose it. Legacy records without a diagnostic reference return empty history:
absence means details were not captured, not that a resume was empty or that a
missing skill caused the failure. Private drafts do not qualify as completed
results, limited assessments, or report scores.

Deploy compatible API/UI readers before workers that write these optional
fields. Any rollback must retain diagnostic-compatible readers, including the
worker's record parser. The existing two-correction budget, strict validation,
independent review, completion semantics, and source permissions are unchanged.
Production deployment and controlled retries need separate operational approval.

## Library lifecycle and dependencies

`library-lifecycle.ts` owns archive/delete administration. The existing
`lifecycle.ts` still owns initialization, queue progress, and cancellation.
Only mutable run records and run summary/detail envelopes carry lifecycle
metadata. Archive never changes manifests, snapshots, comparison results,
reviews, citations, or private original provenance.

Archiving a run fences scoring immediately and cancels only that run's remaining
work, materializing uninitialized comparisons as cancelled in the usual bounded
chunks. Unarchive never clears cancellation or restarts work. Workspace archive
cancels owned analysis work without individually archiving every run. Archiving
an **input** resume/job/rubric/ladder does not cancel existing runs or invalidate
their frozen evidence; the eligibility restriction applies to new intake and
explicit scoring retries, not worker continuation or historical inspection.

```ts
createAnalysisLifecycleParticipant(analyses: RealAnalysesDeps): WorkspaceLifecycleParticipant
realAnalysisDependencyBlockers(
  analyses: RealAnalysesDeps, workspaceId: string, target: LifecycleTarget,
): Promise<LifecycleBlocker[]>
```

The participant exposes `setState`, `cancel`, `purge`, `counts`,
`pendingWorkspaces`, and `resume`. Counts include **every retained run**, including
archived and cleanup-pending runs (`analyses`, `analysisComparisons`). Workspace
deletion must combine these with other lifecycle blockers and must remain blocked
until all runs are explicitly deleted. `purge` also enforces this rule; it is not
an implicit analysis cascade. Run cleanup precedes resume/grade/job cleanup.

Dependencies come from exact manifest/snapshot bindings, including source resume
IDs, job IDs, stable logical rubric groups, historical rubric version IDs,
`gradeHeadId(ladderId, grade)`, ladder IDs, and frozen GS seed jobs/rubrics. No
mutable live-source lookup is needed. Unreadable dependency storage fails closed.
Blocker links use `/analyses/<encodedId>`. A workspace target returns
all retained real runs; an analysis target has no dependent-run blockers.

Delete durably saves the dependency bindings before removing evidence, fences the
run, and drains cancellation and Blob writers. It deletes comparisons and all
owned snapshots/manifests/copied evidence/results/diagnostics using exact ETags and validated
private prefixes. Cleanup follows empty continuation pages and restarts scans
after deletes so shifting page offsets cannot skip artifacts. All phases are
resumable. Until completion, list/detail responses retain recovery metadata but
deleting runs expose no partial comparison or document evidence.

Blob writers reserve a bounded slot in the same-partition run control. Azure
content PUTs require an exact placeholder ETag and a finite Blob lease, with
bounded requests and no automatic upload retries. Failed/ambiguous writers keep
their reservations until the request/lease window has drained; cleanup then
breaks leases and conditionally deletes. A late source/result PUT cannot recreate
deleted content. A permanent minimal run control tombstone prevents old
idempotency keys from recreating a run. Reconciliation preserves a terminal
workspace `deleted` fence rather than downgrading it to `deleting`.

Incomplete HTTP actions return 202 and a durable operation; reapers discover
them through `pendingWorkspaces` and advance them with `resume` under the
workspace mutation lease. Recovery respects live cancellation leases, backoff,
and the existing three-attempt/non-retryable pause instead of automatically
resetting worker budgets. Repeating the lifecycle action with the current run
ETag explicitly resumes paused cleanup without restarting scoring. Already
completed operations cannot cancel a later, explicitly retried comparison.
Neither workers nor these analysis-store controls
need new directory, legacy workspace, or live-source access.

## Worker-only shared helpers

These exports are browser-free and require **only analysis stores**, not job,
grade, resume, or legacy workspace storage access.
The analysis and grade workers are shared Word-evidence consumers even though they do not
accept Word uploads themselves. The rollout therefore verifies all four job, grade, resume,
and analysis worker images/artifacts before enabling new Word admissions. Partial rollouts
keep that gate off; disabling it is not permission to downgrade readers once Word history
exists. See the root README for fail-closed rollout and image-manifest checks.

From `lifecycle.ts`:

```ts
advanceAnalysisRun(
  deps: RealAnalysesDeps, workspaceId: string, runId: string,
  options?: { now?: () => Date; maxChunks?: number; leaseOwner?: string; expectedAttemptId?: string; lifecycle?: boolean },
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
Also require active workspace/run lifecycle controls. Only lifecycle
administration uses `lifecycle: true` to finish cancellation behind a deleting
fence; ordinary scoring workers never process deleted runs.
For claim, heartbeat, automatic retry, terminal failure, and result publication,
write the comparison and the returned progress/state update in **one**
`store.transact(workspaceId, [...])` with both observed ETags. An API cancellation
replaces that same run fence, preventing late result publication. The Azure store
rejects isolated comparison writes and parent counters inconsistent with the
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
analysisDiagnosticBlobName(workspaceId, runId, comparisonId, attemptId): string
parseAnalysisFailureDiagnostic(value: unknown): AnalysisFailureDiagnostic
assertAnalysisFailureDiagnosticBinding(diagnostic, run, comparison, snapshots?): void
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

### Source-selected model citations

The analysis worker's transport contract uses only `{passageId: integer}` for
criterion, qualification, and grounding-issue citations. Its versioned catalog
is derived from the exact frozen resume: model-visible paragraphs retain their
identity and order, with lossless bounded text passages instead of a second
copy of the complete resume. Long paragraphs are split at safe boundaries
without editing source characters; whitespace-only slices remain in context
with null, non-selectable IDs. Evidence crossing paragraph boundaries requires
separate selections.

Trusted resolution copies the selected original paragraph slices, then runs the
existing canonical literal-quotation validation. Unknown, malformed, oversized,
or duplicate selections fail explicitly. Catalog/source binding failures are
non-correctable integrity errors, not model requests to invent replacement
evidence. Independent grounding still checks relevance and interpretation:
selecting an existing passage does not by itself support a score.

The model-facing prompt/schema versions change, but the persisted `Citation`,
result schema version, canonical hashing, snapshot ownership, and API responses
do not. Historical results retain their original quotes and provenance. Source
viewers, highlighting, and report exports continue to read canonical citations;
they do not need to understand passage IDs. The two-correction budget, separate
transport retries, cancellation/publication fences, and unchanged completed
results remain in force.

Structured `evidence-catalog` logs record version, snapshot/document hashes and
source counts, while `citations-resolved` counts canonical-valid citations.
Neither event replaces semantic review. Selection findings include trusted
locations and bounded counts, not invalid model-supplied identities or text.
The root README contains a run-scoped Log Analytics query. Private snapshot
inspection uses existing authorized reads, not new data-store permissions or
public original-file links.

Do not log raw documents, profiles, source URLs, model responses, or validation
errors containing those values. These are retained private captures, not browser
state; only authorized lifecycle deletion removes them. Failed pre-publication attempts
can leave private immutable preparation blobs. Workspace cleanup enumerates
those private families as well as published runs, retaining terminal fences.

Focused validation (independently bundles its own entry point):

```powershell
node --test server-tests\real-analyses.test.mjs server-tests\real-analyses-lifecycle.test.mjs server-tests\real-analyses-azure-store.test.mjs server-tests\real-analyses-model-boundary.test.mjs server-tests\analysis-diagnostics.test.mjs worker-tests\analysis-runtime.test.mjs worker-tests\analysis-evidence-passages.test.mjs worker-tests\analysis-telemetry.test.mjs
node --test server-tests\analysis-corrections.test.mjs server-tests\analysis-read-performance.test.mjs worker-tests\analysis-corrections.test.mjs src\services\analysisCorrections.synthetic.integration.test.mjs src\services\analysisCorrections.synthetic.browser.integration.test.mjs
npx tsc --project tsconfig.server.json --noEmit
npx eslint server\analyses server-tests\real-analyses*.mjs --quiet
```

The model-boundary tests exercise the actual assessment/grounding adapter with a
test HTTP transport, then persist its normalized output and read it through API
validation. They cover fractional weights and correction provenance, preserved GS
exclusions, unscored qualification limits, canonical hash stability, and withheld
results. They do not substitute a synthetic result for the model adapter.
