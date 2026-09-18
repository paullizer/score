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

Mutations return `{ ladder: GradeLadderDetail }`; creation returns HTTP 202.
Detail GETs return `GradeLadderDetail` directly. Lists and version histories are
paged using `continuationToken` and an optional `limit` between 1 and 100.

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
  or later job changes. No retry deletes or overwrites another initializer's blobs.
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
