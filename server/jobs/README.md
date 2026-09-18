# Real job lifecycle

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
  new analyses, ladder seeds, and sample-state saves.
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

## Storage and worker fencing

Every normal Cosmos create, replacement/claim, and rubric publication includes an
ETag-conditioned workspace guard in the same partition transaction. Lifecycle
changes use narrow internal methods; normal writes cannot clear lifecycle flags
or resurrect a deleted rubric. Workers use that job-container guard, not directory
or legacy-state permissions.

Every mutating job handler runs entirely inside
`repository.withWorkspaceMutation`: lifecycle requests use `manage`, other writes
use `write`, and authorization is checked again after acquiring the durable
workspace lease. The PDF parser runs after initial authorization but before this
mutation lease. The lease is held until the handler promise settles, even if the
HTTP client disconnects. Publication and cleanup boundaries also check the lease
keeper; the same assertions are no-ops in worker contexts.

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

`createJobLifecycleParticipant(jobs)` implements the workspace coordinator's
`setState`, `cancel`, `purge`, `counts`, `pendingWorkspaces`, and `resume` contract.
The web reconciler discovers persisted job/rubric `deletingAt` markers across
workspaces, then resumes at most 50 pending entities per workspace pass under the
workspace mutation lease. Blocked writers do not prevent other entries in that
page from being attempted. Neither discovery nor restart needs directory access
from a worker or in-memory operation state. `JobCleanupPendingError`
signals that its purge must be retried, not reported as complete. Workspace purge
preserves only non-content lifecycle guards and job-id tombstones.

Cosmos may return an empty page with a continuation token. Cleanup follows those
tokens through exhaustion before clearing rubric pointers or publishing job
tombstones; an empty page alone is not completion. Nonadvancing pagination fails
closed. Re-running record cleanup against a tombstone also removes any residual
owned records rather than skipping them.

Permanent deletion means unavailable through Score. Existing Azure Blob
soft-delete retention/backups still apply; this service does not alter the
account's seven-day retention policy.
