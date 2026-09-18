# Private grade-ladder API

`routes.ts` mounts the grade-ladder API under
`/api/workspaces/:workspaceId/grade-ladders`. `service.ts` implements the workflow;
`azure-store.ts` supplies the Cosmos and Blob adapters. The shared record and wire
types are in `src\domain\real-grades.ts`; storage interfaces are in `store.ts`.

## Configuration and authorization

`REAL_GRADE_LADDERS_ENABLED=true` enables the API when grade dependencies are
available. The dedicated containers default to `GRADE_RECORDS_CONTAINER=grade-records`
and `GRADE_SOURCE_CONTAINER=grade-sources`; they cannot alias job or workspace
containers. Feature discovery remains centralized in `server\app.ts` and preserves
the real-job feature and limits.

Every route requires workspace membership. Owners/editors may mutate; viewers may
read. Existing same-origin and `X-Score-Request: workspace` CSRF checks apply to all
mutations. Membership is checked before the raw PDF parser. Responses and original
attachments are private, `no-store`, and never routed through legacy workspace state.
Every mutating handler then runs through `repository.withWorkspaceMutation`,
reauthorizing inside the durable workspace lease (`write` normally, `manage` for
lifecycle). The lease stays held until the handler's promise settles, including
after a disconnected HTTP client; it is not released by response/close events.

Mutations return `{ ladder: GradeLadderDetail }`; creation returns HTTP 202.
Detail GETs return `GradeLadderDetail` directly. Lists and version histories are
paged using `continuationToken` and an optional `limit` between 1 and 100.

## Archive, restore, and permanent deletion

Owners/editors can manage a ladder or a logical grade rubric, including inside an
archived workspace:

- `GET /:ladderId/lifecycle?grade=9` returns `{ impact }` and the current target
  ETag. Omit `grade` for the entire ladder. Impact includes owned record counts
  and links to blocking analyses.
- `POST /:ladderId/lifecycle` accepts
  `{ action: 'archive' | 'unarchive' | 'delete', grade?: number }`. Supply one
  exact `If-Match`: the **ladder ETag** for a family, or the **head ETag** for a
  grade. Success returns `{ ladder }`, or `{ deleted: true }` after the entire
  family has been purged. No wildcard ETags or client-controlled lifecycle
  metadata are accepted.
- Every durable unfinished cleanup returns HTTP 202 with
  `{ pending: true, operation, etag }`, including a failed cleanup whose
  `operation.status` is `failed` and `operation.error` explains the incomplete
  result. HTTP 202 does not mean the action completed; clients must inspect the
  operation status and preserve the retry ETag even without a ladder detail.
  Pre-fence validation, authorization, and unavailable-store errors still use
  their normal error statuses. Incomplete operations are logged server-side.
  The response ETag, also available from the impact endpoint, permits an explicit
  retry of the same action. A deletion fence survives process interruption:
  incomplete data is never restored to active. Until cleanup completes, ladder
  list/detail reads return a minimal non-editable recovery stub with the target
  identity/name, `lifecycle.deletingAt`, current `etag`, `pending: true`, and a
  pending delete `operation`. Levels, sources, work items, and issues are empty;
  the source set is null and captured context/title/blob paths are not exposed.
  This keeps deletion retry discoverable after closing a dialog or reloading,
  without dereferencing already-purged children. Version/source endpoints still
  hide deleting content. Once the family is fully purged it disappears from lists
  and detail returns 404.

Optional lifecycle metadata belongs only to mutable ladders and grade heads.
Older records without it remain active. Immutable source sets, competencies,
versions, reviews, approvals, and their hashes are never rewritten to archive.
Archived ladders and their histories remain in authorized paginated reads so
clients can include them in search; clients apply active/archive browsing filters.

Archive blocks edits and new processing and cancels only unfinished owned work,
revoking its leases. Completed evidence and results remain readable. A grade's
logical identity is `gradeHeadId(ladderId, grade)`, spanning **every** version.
Archiving that head does not cancel sibling-grade work or shared planning; the
planner skips archived/removed heads. Parent archive state is inherited without
setting child archive flags. Restoring a parent preserves independently archived
heads. Unarchive never restarts cancelled work.

Deletion always requires the cross-store `LifecycleDependencies.impact` provider
and rechecks blockers before fencing. Retained analyses, including archived
analyses and references to historical rubric versions/groups, block deletion.
The surrounding web coordinator serializes workspace mutations under its
recoverable state lease so another API request cannot add a dependency after the
check. Existing ladders also protect their seed jobs and logical seed rubrics.
New ladder creation rejects archived or removed seed jobs/rubrics, even when an
unpublished initialization artifact already exists. It rechecks the live ready
job and the exact saved rubric ID/version both before reusing preparation and
immediately before publication under the workspace mutation lease. The captured
rubric must still match the saved version's contents; a newer retained version
does not invalidate the snapshot, but deletion or replacement of the captured
version does. Previously published ladders remain independent captured history.

Deleting one grade removes all its versions, reviews, approvals, and owned work.
Its head remains as an explicit empty slot with `lifecycle.deletedAt`, no current
generation, no version/review/approval pointers, and no prior issues or content.
Shared references, source sets, competencies, and sibling histories remain intact.
Polling, unarchive, old idempotency receipts, and stale work retries cannot
resurrect the removed versions. A deliberate new generation with a fresh
idempotency key can fill an unarchived empty slot with fresh work/version identities.

Deleting a ladder removes every owned record and Blob, including old originals,
seed copies, source snapshots/chunks, discovery results, initialization artifacts,
and request receipts. It never deletes the independent seed job. Cleanup pages
records and exact validated workspace/ladder Blob prefixes, never broad workspace
or user-provided prefixes. Only a noncontent family tombstone remains to reject
replay of the deleted ladder's creation key.
Permanent deletion means unrecoverable through Score, not immediate physical
erasure from Azure backups or retention. The existing seven-day Blob soft-delete
policy remains unchanged; no application trash or restore route is provided.

`createGradeLifecycleParticipant(grades)` in `lifecycle.ts` exposes workspace
`setState`, `cancel`, `purge`, `counts`, `pendingWorkspaces`, and `resume`.
Private family controls retain minimal archive, unarchive, and deletion checkpoints
in the same transaction as the target fence. The web-owned reconciler discovers
bounded workspace IDs and resumes those checkpoints under the workspace mutation
lease; workers do not perform cross-store recovery. Completion clears the
checkpoint atomically with restoration, the final empty grade slot, or the family
tombstone, so a stale recovery pass cannot delete a deliberately new generation.
Legacy deleting markers remain discoverable and resumable.
Workspace counts use the shared `ladders`, `rubrics`, `rubricVersions`, and
`sourceArtifacts` keys, plus grade-specific inventory counts. `rubrics` counts
logical groups with retained versions, not empty grade slots or each version
separately. Archived histories and unpublished preparation artifacts are included;
minimal lifecycle tombstones are not content counts.

The participant also cleans unpublished preparations
tracked by family controls. Workspace cleanup also pages the exact workspace Blob
prefix to discover legacy interrupted preparations with no Cosmos record, then
purges each validated family separately. The coordinator must fence before
cancelling/purging; restoring or reactivating a deleting workspace is rejected.
If later workspace finalization fails after grade cleanup has reached `deleted`,
a repeated coordinator `deleting` request preserves the terminal `deleted` guard.
Repeated cancel/purge/finalize steps are idempotent and cannot reactivate content.
Workers need no access to the workspace directory, legacy sample state, or
seed-job store.

Before copying seed bytes, creation reserves a noncontent input fingerprint and
a 24-hour expiration in its family control. Publication clears that reservation
atomically with the new ladder. Failed preparations can be retried while their
seed remains eligible and the reservation has not expired. Detecting a revoked
seed during creation/retry fences and purges only that unpublished family; failed
or draining cleanup is resumed by the web reconciler. Expired unpublished
preparations are discovered and purged even when no ladder record was published.
They leave a noncontent tombstone, so deliberate creation afterward requires a
fresh idempotency key. Cleanup checks publication absence against the family CAS;
it never treats a published ladder as an orphan or deletes the independent job.

## Concurrency and immutable inputs

- Creation, discovery, source intake, confirmation, and generation require a UUID
  `Idempotency-Key`. Receipts bind requests to their inputs and, where applicable,
  their original `If-Match` value.
- Context edits, discovery, page selection, source confirmation, generation, retry,
  and cancellation require the ladder ETag. Draft edits and approval require the
  **grade-head ETag**, available in the detail response's `levels`.
- Creation captures an authorized ready real job, saved rubric, extracted document,
  and original evidence. `rubricVersion` is required to select an exact saved
  version; creation never silently substitutes the current rubric version.
- The captured job's `rubricId` points to that selected saved rubric, including a
  historical rubric with a different ID. The live job's current pointer is unchanged.
- `initialization.json` is the winning immutable preparation record. Retries reuse
  its seed snapshot, creator, and timestamp, even after a Cosmos publication timeout
  or later unrelated job changes, provided the exact saved seed remains eligible.
  No retry overwrites another initializer's blobs or revives a revoked seed.
- Seed context is included automatically and does not consume one of the 15
  supporting-reference slots. The supporting PDF page budget is 500 selected pages,
  with at most 250 selected pages per reference and 20 MiB per PDF.
- Page selection creates a new document version and cancels obsolete extraction
  work. Extraction work binds `documentVersion`; cached chunks are version-specific.
- Cancelling discovery advances the ladder's `sourceRevision` in the same ETag-
  guarded transaction that clears the discovery lease. Context changes also
  advance that revision and cancel discovery; stale workers cannot publish using
  their previous ladder/work ETags.
- Source-set confirmation freezes selected ready references and their exact blob
  paths under source and ladder ETag guards. Client applicability decisions cannot
  grant OPM authority or dismiss source/content blockers.

Only ladders, sources, heads, and work records are mutable. Source sets, competency
plans, versions, semantic reviews, and approvals are create-only. Transactions use
one same-workspace Cosmos batch, with individual `ifMatch` conditions. Records are
limited to 512 KiB and batches to 1.8 MB; full source documents belong in Blob.
Every create, replacement, claim, heartbeat, and publication also conditionally
writes workspace/family lifecycle controls in that **same batch**. A raced fence
therefore fails atomically, not merely through a preliminary active-state read.
The 100-operation/1.8 MB limits include these guards. Lifecycle deletion uses
bounded conditional delete batches and retains its fence until final cleanup.
Cleanup follows advancing continuation tokens even across empty pages or pages
containing only the retained ladder/head. Record pagination restarts after each
actual delete. Blob verification exhausts every page and repeats bounded sweeps
until an entirely empty sweep is observed; repeated tokens or an exhausted sweep
budget leave the operation fenced and incomplete rather than reporting success.

API and worker uploads reserve a writer in the family's Cosmos control before
writing. Azure uploads carry a 60-second abort bound and a 120-second reservation;
ambiguous writes retain their reservation until expiration. Cleanup remains
pending while writers drain, and performs a final exact-prefix sweep. A writer
that completes across a fence removes its newly written Blob before releasing
the reservation. Existing immutable artifacts are not overwritten or removed by
an archive retry.

## Validation and worker integration

The public factories are `createAzureGradeStore(config, credential)` and
`createAzureGradeBlobStore(config, credential)`.

`parseGradeEntity` rejects unknown fields, invalid ownership/identity, unsafe blob
paths, forged authority, and inconsistent immutable hashes.
`parseGradeSeedSnapshot` and `validateReferenceDocument` validate captured inputs.
`gradeRecordHash` is the shared API/worker SHA256 implementation for immutable
versions and source sets. It hashes recursively key-sorted JSON using ordinal
string comparison, preserving array order and omitting only the root record's
`contentHash` field. `gradeVersionHash` and `gradeSourceSetHash` delegate to it.

`validateGradeVersion` checks deterministic publication integrity, including exact
citations in criteria, qualifications, and issues, plus supported-criterion weight
bounds and distinct 0–5 guidance. Explicit gaps and blocker issues remain publishable,
and publication does not require weights to total 100. Exact quotes attached to a gap
are contextual evidence, not an assertion of grading authority. `validateGradeApproval`
requires at least one direct/derived supported criterion, positive supported weights
totaling 100, no gaps, and no unresolved blockers. Explicitly cited work-level
`not-applicable` exclusions are allowed only with weight 0, no `gradeBasis`, meaningful
interpretation/unscored guidance, and no score anchors. Their citations must be
applicable work-level evidence, never qualification-only, seed, or background
substitutes; the immutable semantic review must support the exclusion. Grade-specific
issues affect only their grade; issues without a grade remain
global. Workers persist incomplete drafts and use semantic review plus source/version
issues to select `needs-sources`; they must not treat ordinary support gaps as transport
or processing failures.

Draft edits append a new immutable version and independent semantic-review task.
The rubric ID advances with the version ID; the grade-head group and common
competency identities remain stable. Clients cannot relabel criterion support or
assign hashes, provenance, review verdicts, approvals, or server-owned identities. Approval additionally binds
the latest head/version, successful immutable review, and current frozen source set.
Prior approvals and their source sets remain inspectable after later edits.

Document and original GETs accept `?sourceSetId=...` to resolve an exact historical
capture instead of the source's latest extraction. All blob names are derived
within the authorized workspace/ladder/source prefix; filenames and URLs are never
used as storage paths.

Worker-only source artifacts include `capture.json`, `document-v<N>.json`,
`original.pdf`, `original.html`, and `chunks/v<N>-<safe-key>.json`. Chunk keys are
1-120 ASCII alphanumeric/dot/underscore/hyphen characters, with no separators or
percent escapes. Capture manifests use the same create-only Blob conditions as
originals; conflicting writes return the winning immutable bytes for the worker
to validate. These artifacts have no arbitrary-path API download route.

Ladders may also carry optional `discovery` metadata: `seriesTitle`, `seriesStatus`,
`catalogVersion`, `capturedAt`, and `artifactBlobName`. The title is optional; older
drafts need no discovery metadata. When present, the artifact must be an immutable
`discovery-<work UUID>.json` within that same workspace/ladder prefix. Metadata is
returned on ladder lists/details and is not client-editable.

## Reviewer-confirmed applicability

With confirmed position context, an explicitly selected `applicable` decision and
nonempty review reason can resolve nonconflicting conditional scope for a current
OPM reference. Uploaded/URL agency evidence can also be scoped to that context
while retaining `authorityStatus=supplied`; it never becomes official OPM evidence.
Background, excluded, and uncertain decisions do not perform this confirmation.

The change is confined to the immutable source set. The original source record
retains its catalog/extraction coverage. The frozen source explicitly labels its
scope `Reviewer-confirmed`, records the reason, and narrows previously unspecified
series, grade, and function lists to the review context. Existing explicit limits
are not broadened or overwritten. A `reviewer-confirmed-scope` warning preserves the
original state/explanation, while the source set binds the reviewer, timestamp,
context, decisions, exact document versions, and content hash.

This does not resolve unknown/conflicting authority, conflicting coverage, explicit
series/function mismatches, exemptions, missing sections, or grade-specific issues.
All substantive source and ladder issues remain intact. Unresolved cases remain
blocked; grade-specific restrictions do not become global restrictions.

Reviewer-confirmed applicability is not a finding that a document supports every
requested grade. Scored criteria still need exact applicable `gradeBasis` citations
and complete scoring guidance; permitted N/A exclusions remain explicitly unscored.
Each grade needs positive supported weights totaling 100 and an independent
successful semantic review bound to its immutable version. No custom-expectation
approval bypass is provided. Reconfirmation creates a new source set without
rewriting prior history.
