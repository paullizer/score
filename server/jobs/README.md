# Real job lifecycle

## Import admission

One browser batch submits each valid file or URL once, in order. Parallel inputs
must not compete for the workspace-wide mutation lease. File/PDF/Markdown/Word
and URL admissions compute their response under `withWorkspaceMutation` but send
HTTP 202 (new) or 200 (identical replay) only after the final lease validation and
confirmed release. A release transport failure returns an explicit uncertain
acknowledgment, not success; the original key still identifies any durable record.
The response boundary does not weaken authorization, source-write fencing, batch
limits or real contention with another workspace mutation.

The complete batch stays active while its submissions settle. A genuinely failed
item remains visible and is not automatically retried; its valid neighbors are
still attempted once. Explicit manual replay keeps the same key, source bytes,
filename and batch. Unmount, workspace changes, lost write access or disabled
admission stop remaining browser submissions. Acknowledged server work continues.

Substantive single-role descriptions are accepted even when fictional, synthetic,
internal, expired or not live vacancies. Multi-role collections, listing/search
pages and irrelevant/unusable documents remain invalid. The code-owned v5 rubric
prompt and generation-v3 immutable template release implement this contract;
stored captures are not rewritten. Use `scripts\deploy.ps1` for coordinated API
and all-worker deployment and the existing quality-gated Admin template
activation before admitting new work. No old-job migration or automatic restart
is performed.

## Import diagnostics

The import worker emits bounded JSON `score-job` events to the existing
`ContainerAppConsoleLogs` table. `job-stage` tracks parsing, rubric generation,
review and publication. `job-outcome` records `ready`, `failed`, `queued` or
`abandoned`, correlated with workspace/job IDs, attempt, captured model/deployment,
prompt/template versions, allowlisted error code and HTTP status when available.
Unknown error codes become `processing-error`; arbitrary exception bodies and
model rejection text are never logged. `failureWriteUnconfirmed: true` means the
failure could not be saved (including lease loss), not a successful job. Inspect
the private job record for the authorized user-facing explanation.
`execution-outcome` separates processed claims from successful publications.

```kusto
ContainerAppConsoleLogs
| where TimeGenerated > ago(1h)
| where JobName startswith "job-score-import-"
| extend event = parse_json(Log)
| where event.component == "score-job"
| project TimeGenerated, event.event, event.workspaceId, event.jobId,
    event.attempt, event.stage, event.outcome, event.code, event.failureWriteUnconfirmed,
    event.templateVersion, event.deployment
| order by TimeGenerated asc
```

Validate first-pass model behavior with fresh disposable single-role fixtures
and negative controls, the actual configured model/OCR services, one worker
attempt, one transport attempt and no output corrections in that isolated
validation capture. Require one acknowledgment per source and a validated,
reviewed ready rubric without manual retries. Mocked regression tests alone do
not establish live model acceptance. Deployment, activation, paid validation and
test-record cleanup are separately approved operations.

`GET /api/workspaces/:workspaceId/jobs/:jobId/lifecycle?scope=job|rubric`
returns `{ impact }`. `POST` to the same path accepts `{ action, scope }`,
where `action` is `archive`, `unarchive`, or `delete`, and requires the exact
current **job** `If-Match` ETag. Lifecycle management requires an owner/editor
membership, including when the workspace is archived.

- Archive cancels queued/running import work and revokes the job lease. Completed
  originals, extraction, and immutable rubric versions remain readable.
- Job, rubric, and workspace archive state are independent. Workspace cancellation
  does not stamp archive flags on children. Unarchive never restarts processing.
- Delete rechecks analyses and seed-ladder dependencies, including archived items
  and historical rubric versions. Missing dependency or storage capabilities fail
  closed. The application's workspace mutation lease serializes these checks with
  new analyses and ladder seeds.
- Rubric deletion covers the logical group and all its immutable versions. The job
  and source remain; `job.rubricId` becomes `null`, `job.rubricDeletedAt` records the
  deliberate removal, and the job remains `ready`. Retry cannot recreate it.
- Job deletion includes every rubric version and every validated job-source
  prefix artifact, including abandoned preparation/request files. Only a minimal
  Cosmos tombstone remains, so old import idempotency keys cannot recreate it.

Completed archive/unarchive/rubric deletion returns `{ job: RealJobDetail }`.
Completed job deletion returns `{ deleted: true }`, only after cleanup finishes.
Summary/detail responses carry optional `lifecycle` and `rubricLifecycle`;
immutable rubric content and source-document JSON never carry lifecycle flags.

Deletion is resumable: first it durably sets `deletingAt` and cancels owned work.
While source writers drain, HTTP 202 returns `{ job, operation }` with
`operation.status = "pending"`, `retryAt`, and a `Retry-After` header. A cleanup
failure also returns HTTP 202, with `operation.status = "failed"` and an explicit
error, without unlocking the item. Clients must inspect the operation status and
show a retryable lifecycle error, not treat HTTP 202 as completion. The current or
last-confirmed fenced job ETag remains in the payload even if refresh reads fail.
Reload its current job ETag and repeat the same delete action to resume. Neither
response means permanent deletion completed. Unavailable capabilities/dependency
checks before a durable deletion fence still return HTTP 503.

## Display names

`PATCH /api/workspaces/:workspaceId/jobs/:jobId/metadata` accepts exactly
`{ "displayName": "New label" }` as JSON, with the current job `If-Match` ETag.
It returns `{ job: RealJobSummary }` and the replacement ETag header. Names are
trimmed, must be 1–160 JavaScript string characters after trimming, and reject
control characters and line separators. Unknown body/query fields, weak,
wildcard, and multiple ETags are rejected. Missing ETags return 428 and stale
ETags return 409.

The optional alias lives on the real record and summary/detail wrapper, never
inside canonical `job` metadata. Only `displayName` and `updatedAt` change.
Extracted titles, filenames/URLs, fingerprints, source bytes, documents, and
immutable rubric versions remain unchanged. Renaming does not run or retry
extraction/generation and never sends the alias to the model. Future analyses
capture an alias separately; existing analysis snapshots retain their original
captured labels or legacy fallback.

Renames require owner/editor write access, normal CSRF protection, and the
workspace mutation lease. Existing workspace/job/rubric archive and removal
restrictions still apply. Workers preserve the latest alias when updating
progress or publishing a rubric and retry bounded ETag contention only while
they still own the active attempt; cancellation or lease loss still fences them.

## Request limits

Each API instance allows 600 requests per minute per user across every
`/api/workspaces/:workspaceId/jobs` route, in any workspace. The limit is
checked before workspace authorization, so refused requests still count. Excess
requests return 429 through the standard error shape with `Retry-After`. Rubric
exports also have their own, lower limit.

## Rubric exports

`GET /api/workspaces/:workspaceId/jobs/:jobId/rubric-export?rubricId=…&version=…&format=pdf|docx|pptx|markdown|csv`
returns one saved job rubric version as a JSON `RubricExportPayload`
(`src/domain/rubric-exports.ts`). The browser validates it again and writes the
file in a worker, so the API never generates documents or calls a model. The
payload holds the job's facts, the rubric version with its criteria, guidance
and posting quotes, the latest version number, the version's approval status
(`approved`, `draft` or `superseded`), and the current report policy with its
settings revision. It contains no candidate data or source bytes.

Any workspace member may call it, subject to application policy, and archived
jobs and rubrics remain exportable. Each API instance allows 60 rubric export
requests per minute per user, and they also count toward the job request limit.
Excess requests return 429 through the standard error shape with
`Retry-After`. It returns:

- 400 for missing or malformed `rubricId`, `version` or `format`, or any other
  query parameter;
- 403 when `features.rubricExports` is off, the member's role isn't in
  `reports.allowedRoles`, or `reports.enabledFormats` excludes the format.
  Markdown isn't a report format, so the format list doesn't restrict it;
- 404 when the job doesn't exist, the job or its rubric is being deleted or has
  been deleted, or the version doesn't belong to that rubric;
- 429 when the per-user export limit is reached;
- 503 when real jobs aren't configured or stored records fail validation.

**Pause new work** and runtime admission don't affect this route, because it
only reads saved records. Rubric version content is immutable, so the export
matches what the rubric page shows for that version.

## Rubric checks and approval

New analyses and grade ladders use only the version of a job rubric that a
workspace owner approved, while `features.rubricApprovalRequired` is on (the
default; an absent key means on). Approval locks one exact saved version: saving
an edit creates a draft version and the approved version stays in use until a
newer one is approved. Rubrics made before the evidence scale
(`score-evidence-ladder-v1`) can't be approved; importing the job again creates a
rubric that can.

The import worker runs the model-free checks and the shared one-pass model
review after generation. Its guarded transaction creates the rubric version and
the hash-bound `rubric-qa` record together, then marks the job ready. A cancelled,
failed or invalid review never publishes unchecked ready work. This does not
approve the rubric: a workspace owner still reviews the findings and approves
the exact saved version.

Approval follows the rubric checks for that version:

- `GET …/jobs/:jobId/rubric/checks?rubricId=…&version=…` (any member) returns
  `{ review: RubricCheckState }`: the version's `rubricHash`, its status
  (`approved`, `draft` or `superseded`), the reasons it can't be approved yet,
  and the stored check results, or `null` when the checks haven't run.
- `POST …/jobs/:jobId/rubric/checks` with `{ rubricId, version }` (owners and
  editors) runs the checks once for an edited latest version and stores them as a
  create-only `rubric-qa` record bound to the version's hash. Later calls return
  the stored results. The checks are the model-free findings from
  `src/domain/rubric-qa.ts` (scale problems block approval; overlap and wording
  a résumé can't show are warnings) plus one review by the job-rubric model with
  the code-owned prompt `score-job-rubric-review-v1`, whose findings are
  warnings. The model call runs outside the workspace mutation lease, uses the
  rubric assistant's per-user limits, and needs new-work admission (`/api/features`
  reports `rubricChecks`). Changing the checks or the review prompt needs a new
  `RUBRIC_QA_VERSION`. The API and worker share `worker/rubric-review.ts`; neither
  substitutes a successful result for invalid, empty or failed model output.
  Shared-source diagnostics carry bounded, Unicode-safe excerpts; complete
  authoritative quotations remain unchanged in the rubric's source citations.
- `POST …/jobs/:jobId/rubric/approve` with `{ rubricId, version, rubricHash }` and
  `If-Match` set to the job ETag is owner-only (application admins act as
  owners). It approves only the latest version, on the scale, with stored checks
  and no blockers, and only when `rubricHash` matches exactly the reviewed
  content. One transaction creates a create-only `rubric-approval` record (rubric
  version and hash, scale version, check record and its hash, the job document's
  id, version and SHA-256, approver, time, and the approval it supersedes) and
  moves the job's `rubricApproval` pointer. Other job writes can't change the
  pointer, and deleting the rubric removes its checks and approvals with it.

## Storage and worker fencing

Every normal Cosmos create, replacement/claim, and rubric publication includes an
ETag-conditioned workspace guard in the same partition transaction. Lifecycle
changes use narrow internal methods; normal writes cannot clear lifecycle flags
or resurrect a deleted rubric. Workers use that job-container guard, not directory
or legacy-state permissions.

Every mutating job handler persists under
`repository.withWorkspaceMutation`: lifecycle requests use `manage`, approvals
use the owner-only `approve` access, and other writes use `write`. Authorization
is checked again after acquiring the durable workspace lease. On-demand rubric
checks run their model call outside that lease, then acquire it to persist the
immutable result. Raw PDF, Markdown, and Word bodies are read only after initial
authorization. File validation, Word parsing, and persistence all run under the
mutation lease, including the `/file` upload endpoint. The lease is held until the
handler promise settles, even if the HTTP client disconnects. Publication and
cleanup boundaries also check the lease keeper; the same assertions are no-ops in
worker contexts.

All API/worker source writes use `putJobBlob`, which requires the Blob store's
`putFenced` capability. A bounded Cosmos reservation is acquired before writing;
source content is uploaded under a finite lease on that specific Blob, checked
again after lease acquisition. Uncertain uploads keep their reservation for at
most two minutes. Cleanup waits for reservations to drain, breaks any remaining
Blob leases, paginates only validated workspace/job prefixes, and performs a final
sweep. A suspended expired writer cannot publish content after purge. Empty
preallocation markers contain no source data and are never returned as documents.
The low-level immutable writer is retained for fixture/migration compatibility,
not used by API requests or workers.

Uploaded PDF, Markdown, DOCX, and DOC sources retain their format in both the job
and source metadata. Each uses its canonical `original.pdf`, `original.md`,
`original.docx`, or `original.doc` name and matching content type. URL imports stay
URL sources with PDF or HTML captures. Archive, cleanup, and idempotency tombstones
apply identically to every format; original downloads preserve the captured bytes.

`createJobLifecycleParticipant(jobs)` implements the workspace coordinator's
`setState`, `cancel`, `purge`, `counts`, `pendingWorkspaces`, and `resume` contract.
The web reconciler discovers persisted job/rubric `deletingAt` markers across
workspaces, then resumes at most 50 pending entities per workspace pass under the
workspace mutation lease. Blocked writers do not prevent other entries in that
page from being attempted. Neither discovery nor restart needs directory access
from a worker or in-memory operation state. `JobCleanupPendingError`
signals that its purge must be retried, not reported as complete. Workspace purge
preserves only non-content lifecycle guards and job-id tombstones.

Cosmos may return progress-only responses before a data page, or an empty page
with a continuation token. The bounded shared page reader handles progress
responses for listing, polling, cancellation, writers, and recovery. Cleanup
follows those tokens through exhaustion before clearing rubric pointers or
publishing job tombstones; an empty page alone is not completion. Nonadvancing
pagination fails closed. Re-running record cleanup against a tombstone also
removes any residual owned records rather than skipping them.

Permanent deletion means unavailable through Score. Existing Azure Blob
soft-delete retention/backups still apply; this service does not alter the
account's seven-day retention policy.
