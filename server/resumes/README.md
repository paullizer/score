# Private real resume intake

This module stores real resumes separately from the sample `Workspace`. It never writes sample
state, selects a fictional profile, or starts scoring. Resume imports become eligible inputs for
a separately requested analysis only after the resume worker publishes a validated ready record.

## HTTP integration

Mount `createRealResumesRouter({ repository, resumes, now? })` under `/api`, **after** the existing
authentication and same-origin CSRF middleware. `resumes` is an optional `RealResumesDeps`
(`store`, `blobs`); omission fails closed with HTTP 503. The router authorizes workspace
read/write membership before its raw upload parser and returns private, `no-store` responses.
Feature flags, dependency construction, and feature discovery belong to the application wiring.

Paths below start with `/api/workspaces/:workspaceId`:

| Method and path | Input | Response |
| --- | --- | --- |
| `GET /resumes` | Optional `continuationToken`, `limit` (1–100; default 50) | `RealResumesPage` |
| `GET /resumes/:resumeId` | — | Unwrapped `RealResumeDetail`, with ETag |
| `GET /resumes/:resumeId/original` | — | Private original bytes as an attachment |
| `POST /resumes/pdf` | Raw `application/pdf`, import headers, percent-encoded `X-File-Name` | `{ resume: RealResumeSummary }` |
| `POST /resumes/url` | JSON `{ "url": "https://…" }`, import headers | `{ resume: RealResumeSummary }` |
| `POST /resumes/:resumeId/retry` | Exact `If-Match`; no body (empty JSON object also accepted) | `{ resume: RealResumeSummary }` |
| `POST /resumes/:resumeId/cancel` | Exact `If-Match`; no body (empty JSON object also accepted) | `{ resume: RealResumeSummary }` |

Both imports require UUID `Idempotency-Key`, UUID `X-Import-Batch`, and decimal `X-Import-Count`.
Every item in a batch must declare the same count (1–10) and importing principal. Each item has
its own idempotency key. A newly accepted item returns 202; a confirmed replay returns 200.
The write responses include the current ETag. Retry/cancel do not accept source text, profiles,
processing status, or other client-owned overrides.

PDFs are limited to **10 MiB and 50 pages**. The service parses their actual structure before
publication, rejects malformed/encrypted PDFs, and accepts image-only/scanned PDFs for worker OCR.
Filenames are display-only safe basenames, never storage paths or candidate names.
Public URLs are limited to **4,096 characters** and HTTP(S) standard ports, without credentials,
private IP literals, or known private hostnames. The worker must separately resolve/pin public DNS
and validate redirects. LinkedIn or another site requiring sign-in, consent, or an access bypass
must produce an actionable per-item processing error, never an authenticated scraping attempt or
fabricated substitute.

Normalized source text, including paragraph headings, is bounded to **180,000 characters**.
Initial name, role, location, and experience are null. An available profile field must contain
verbatim source evidence with exact document/version/paragraph/page/heading/quotation bindings.
Missing metadata can remain unavailable in an otherwise usable resume.

## Durable admission and source ownership

`resume-<idempotency UUID>` and `document-<same UUID>` are stable identities; batch records use
`resume-batch-<batch UUID>`. All Cosmos records are partitioned by workspace. The admission
transaction conditionally appends one unique batch item and creates its queued resume together.
Neither simultaneous submissions nor distinct keys can exceed the batch's declared count or ten
items. Invalid items do not discard accepted siblings.

Immutable import receipts bind the key to source kind, normalized URL or filename/PDF hash,
batch, count, and importing principal. Uploaded originals and their immutable capture manifests
are durable **before** publication. The winning receipt supplies stable creation/capture metadata.
After an ambiguous response, retry the same item with the same key, body, and batch headers.
Never overwrite or delete another attempt's winning blobs to compensate for a failed publication.
Unpublished receipts/originals may remain after a failure or lost admission race; retention/deletion
administration is outside this release. Resetting samples does not delete real resume data.

Blob names are restricted to these exact names beneath `<workspaceId>/<resumeId>/`:

- `import-receipt.json`
- `original.pdf` or `original.html`
- `capture.json`
- `source-document-v<documentVersion>.json`
- `profile-v<documentVersion>.json`

The container must be private. Authorized original downloads verify recorded MIME, length, SHA-256,
ownership, and capture manifest. HTML is an attachment with `nosniff` and a sandbox CSP, not
executable application content. Details also validate the normalized document and profile against
the saved immutable references; corrupt state fails closed and is never reseeded.

Duplicate warnings use workspace-local original hashes or normalized requested URLs, not filenames.
Admission stores initial warnings. List/detail reads refresh warnings from paged metadata so later
URL captures and concurrent batches are covered without rewriting completed records. Summaries
never include document/profile bodies, and candidate imports are never automatically merged.

## Worker and analysis helper contract

Azure factories:

- `createAzureResumeStore(config, credential)`
- `createAzureResumeBlobStore(config, credential)`
- `createResumeStoreFromContainer(container)` and `createResumeBlobStoreFromContainer(container)`
  expose the same adapters for isolated tests.

`RealResumeService(resumes, now?)` exposes `list`, `detail`, `original`, `importPdf`, `importUrl`,
`retry`, and `cancel`. `importPdf(workspaceId, request, filename, bytes)` and
`importUrl(workspaceId, request, url)` accept a `ResumeImportRequest` containing
`idempotencyKey`, `batchId`, `inputCount`, and server-authenticated `createdBy`.

Reusable validation exports:

- `parseResumeEntity`, `validateRealResumeDocument`, `parseRealResumeProfile`,
  `validateRealResumeProfile`, `validateResumeDocumentBinding`, `parseResumeCaptureManifest`
- `resumeIdForKey`, `resumeDocumentId`, `resumeBatchRecordId`, `isResumeUuid`,
  `isValidResumeId`, `isValidResumeDocumentId`, `isValidResumeBatchRecordId`
- `resumeOriginalBlobName`, `resumeCaptureBlobName`, `resumeImportReceiptBlobName`,
  `resumeDocumentBlobName`, `resumeProfileBlobName`, `isSafeResumeBlobName`,
  `isBlobInResumePrefix`, `resumeBlobContentType`, `resumeBlobLimit`
- `resumeSha256`, `resumeContentHash` (canonical JSON), `resumeBlobReference`
- `normalizeResumePublicUrl`, `isSafeResumeFilename`

`resumeBlobReference(name, blob)` verifies actual SHA-256, length, MIME, and namespace before
returning an immutable reference. `validateRealResumeProfile(value, document, expected?)` checks
exact citations; the optional expected binding contains `workspaceId`, `resumeId`,
`documentSha256`. Parsing a profile alone checks shape and internal identities, not whether its
quotations actually occur in the external source document.

Worker publication rules:

- Capture and capture-manifest references are paired. A URL capture includes a final normalized
  public URL; an uploaded PDF has no final URL or redirects. Reuse the winning capture, not a later
  fetch, after retries or ambiguous publication.
- Captures, extraction provenance/document references, and profiles are immutable once recorded.
  Store writes must preserve them, including during cancellation and manual retry.
- Parsing/profiling require a UUID `attemptId`, attempts greater than zero (maximum three), and
  a lease with `owner`, `heartbeatAt`, and `expiresAt`. Profiling additionally requires extraction.
  A reclaimed attempt increments the counter and cannot take an unexpired lease.
- PDF extraction uses `document-intelligence`, `pdf-pages`, and page count 1–50. HTML extraction
  uses `html` or `browser`, `html-sections`, and null page count. Its section labels are not claims
  about original PDF pagination.
- Ready requires capture, manifest, extraction, profile, `completedAt`, and no lease, pending retry
  timestamp, or error. Profile metadata must match the saved profile. Completed records are
  immutable. Error/cancelled records change only through a new explicit retry cycle.
- Cancellation clears eligibility and the current attempt identity. Manual retry increments
  `retryCount`, resets automatic attempts to zero, clears terminal/lease/error fields, and keeps
  every saved source/profile reference. Stale workers cannot publish through the old ETag.

The store validates all reads/writes, uses Cosmos transactional `ifMatch` conditions, handles
bodyless SDK batch responses, and only returns due queued or expired-leased processing work.
Routine application logs must not contain resumes, raw model responses, or personal source URLs.

## Targeted validation

Run `node --test server-tests\real-resumes.test.mjs`. The test builds its own isolated server
module beneath `dist-server`, uses the actual router, authorization, service, validators, and
Azure adapters with in-memory Cosmos/Blob transports, and removes its generated module afterward.
It needs no deployed cloud resources, model calls, browser login, or live candidate data.
