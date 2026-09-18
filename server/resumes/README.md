# Private real resume intake

This module stores real resumes separately from the sample `Workspace`. It never writes sample
state, selects a fictional profile, or starts scoring. Resume imports become eligible inputs for
a separately requested analysis only after the resume worker publishes a validated ready record.

## HTTP integration

Mount `createRealResumesRouter({ repository, resumes, now?, wordDocumentImports? })` under `/api`, **after** the existing
authentication and same-origin CSRF middleware. `resumes` is an optional `RealResumesDeps`
(`store`, `blobs`); omission fails closed with HTTP 503. The router authorizes workspace
read/write membership before its raw upload parser and returns private, `no-store` responses.
Feature flags, dependency construction, and feature discovery belong to the application wiring.
`wordDocumentImports` defaults to disabled and comes from `Config.wordDocumentImports` /
`WORD_DOCUMENT_IMPORTS_ENABLED`. It gates new DOCX/DOC admissions only, not validation or reads
of already-stored Word sources, authorized downloads, or previews. `/api/features` advertises
`wordDocumentImports: true` only when the flag and a real job or resume service are available;
an absent field on older servers means PDF-only uploads.

Paths below start with `/api/workspaces/:workspaceId`:

| Method and path | Input | Response |
| --- | --- | --- |
| `GET /resumes` | Optional `continuationToken`, `limit` (1–100; default 50) | `RealResumesPage` |
| `GET /resumes/:resumeId` | — | Unwrapped `RealResumeDetail`, with ETag |
| `GET /resumes/:resumeId/original` | — | Private original bytes as an attachment |
| `POST /resumes/file` | Raw canonical PDF/DOCX/DOC bytes, import headers, percent-encoded `X-File-Name` | `{ resume: RealResumeSummary }` |
| `POST /resumes/pdf` | Existing strict raw `application/pdf` alias, same import headers and `X-File-Name` | `{ resume: RealResumeSummary }` |
| `POST /resumes/url` | JSON `{ "url": "https://…" }`, import headers | `{ resume: RealResumeSummary }` |
| `POST /resumes/:resumeId/retry` | Exact `If-Match`; no body (empty JSON object also accepted) | `{ resume: RealResumeSummary }` |
| `POST /resumes/:resumeId/cancel` | Exact `If-Match`; no body (empty JSON object also accepted) | `{ resume: RealResumeSummary }` |

All file/URL imports require UUID `Idempotency-Key`, UUID `X-Import-Batch`, and decimal `X-Import-Count`.
Every item in a batch must declare the same count (1–10) and importing principal. Each item has
its own idempotency key. A newly accepted item returns 202; a confirmed replay returns 200.
The write responses include the current ETag. Retry/cancel do not accept source text, profiles,
processing status, or other client-owned overrides.

Uploaded PDF, DOCX, and genuine Word 97–2003 DOC files are limited to **10 MiB each**.
The **50-page limit is PDF-only**. The service parses actual PDF structure before publication,
rejects malformed/encrypted PDFs, and accepts image-only/scanned PDFs for worker OCR.
DOCX package structure, expanded ZIP size/entry bounds, and legacy DOC structure are checked
in a terminable, resource-bounded Node parser; renamed ZIP/OLE files are not accepted as Word.
Each Node process permits at most two active parser threads and sixteen queued parses,
in addition to per-file, ZIP-expansion, timeout, and heap bounds.
Word URLs, password-protected documents, DOCM, RTF, and templates are not supported.
Macros, embedded objects, and external relationships are never executed.

Use `Content-Type: application/pdf`,
`application/vnd.openxmlformats-officedocument.wordprocessingml.document` (DOCX), or
`application/msword` (DOC), with a matching extension in the percent-encoded `X-File-Name`.
Send raw original bytes, not multipart or request-compressed data. The `/pdf` alias remains
PDF-only even when Word is enabled. Filenames are display-only safe basenames, never storage
paths or candidate names. File requests retain the existing `Origin` and
`X-Score-Request: workspace` CSRF contract.
Public URLs are limited to **4,096 characters** and HTTP(S) standard ports, without credentials,
private IP literals, or known private hostnames. The worker must separately resolve/pin public DNS
and validate redirects. LinkedIn or another site requiring sign-in, consent, or an access bypass
must produce an actionable per-item processing error, never an authenticated scraping attempt or
fabricated substitute.

Normalized source text, including paragraph headings, is bounded to **180,000 characters**.
Initial name, role, location, and experience are null. An available profile field must contain
verbatim source evidence with exact document/version/paragraph/page/heading/quotation bindings.
Missing metadata can remain unavailable in an otherwise usable resume. Word citations identify
captured sections, not physical Word pages; Document Intelligence's DOCX processing units are
not printed-page numbers.

## Durable admission and source ownership

`resume-<idempotency UUID>` and `document-<same UUID>` are stable identities; batch records use
`resume-batch-<batch UUID>`. All Cosmos records are partitioned by workspace. The admission
transaction conditionally appends one unique batch item and creates its queued resume together.
Neither simultaneous submissions nor distinct keys can exceed the batch's declared count or ten
items. Invalid items do not discard accepted siblings.

Immutable import receipts bind the key to source kind, normalized URL or filename/original hash,
batch, count, and importing principal. Uploaded originals and their immutable capture manifests
are durable **before** publication. The winning receipt supplies stable creation/capture metadata.
Existing PDF/URL receipts remain **schema version 1**, with their original fingerprints and
`pdfSha256` field unchanged. New Word uploads use additive **schema version 2** with
`fileSha256`; this does not rename or reinterpret historical fields. PDF uploads through
`/file` still use the version-1 PDF path, so old `/pdf` receipt replays remain compatible.
After an ambiguous response, retry the same item with the same key, body, and batch headers.
Never overwrite or delete another attempt's winning blobs to compensate for a failed publication.
Unpublished receipts/originals may remain after a failure or lost admission race; retention/deletion
administration is outside this release. Resetting samples does not delete real resume data.

Blob names are restricted to these exact names beneath `<workspaceId>/<resumeId>/`:

- `import-receipt.json`
- `original.pdf`, `original.docx`, `original.doc`, or URL-captured `original.html`
- `capture.json`
- `source-document-v<documentVersion>.json`
- `profile-v<documentVersion>.json`

The container must be private. Authorized original downloads verify recorded MIME, length, SHA-256,
ownership, and capture manifest. HTML is an attachment with `nosniff` and a sandbox CSP, not
executable application content. Details also validate the normalized document and profile against
the saved immutable references; corrupt state fails closed and is never reseeded.
Word originals retain their exact bytes and canonical MIME type. They are never converted
into replacement PDFs or exposed through public Office/Google viewers.

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

`RealResumeService(resumes, now?)` exposes `list`, `detail`, `original`, `importFile`, `importPdf`,
`importUrl`, `retry`, and `cancel`. `importFile(workspaceId, request, filename, bytes, contentType: UploadContentType)`,
`importPdf(workspaceId, request, filename, bytes)`, and
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
  public URL; an uploaded PDF/DOCX/DOC has no final URL or redirects. Reuse the winning capture, not a later
  fetch, after retries or ambiguous publication.
- Captures, extraction provenance/document references, and profiles are immutable once recorded.
  Store writes must preserve them, including during cancellation and manual retry.
- Parsing/profiling require a UUID `attemptId`, attempts greater than zero (maximum three), and
  a lease with `owner`, `heartbeatAt`, and `expiresAt`. Profiling additionally requires extraction.
  A reclaimed attempt increments the counter and cannot take an unexpired lease.
- PDF extraction uses `document-intelligence`, `pdf-pages`, and page count 1–50. HTML extraction
  uses `html` or `browser`, `html-sections`, and null page count. Its section labels are not claims
  about original PDF pagination.
- DOCX extraction uses the existing Azure Document Intelligence service. DOC uses local pure-Node
  binary Word extraction (`legacy-word`, with extraction-version provenance), not Document
  Intelligence, LibreOffice, Python, or a new service. Both use `captured-sections` and null
  physical page count, retain stable paragraph identities, and enforce the full normalized
  character limit without truncation. Embedded/linked Word-image OCR is not supported; use
  a PDF with the existing PDF/OCR workflow for image-only or scan-heavy content.
- Ready requires capture, manifest, extraction, profile, `completedAt`, and no lease, pending retry
  timestamp, or error. Profile metadata must match the saved profile. Completed records are
  immutable. Error/cancelled records change only through a new explicit retry cycle.
- Cancellation clears eligibility and the current attempt identity. Manual retry increments
  `retryCount`, resets automatic attempts to zero, clears terminal/lease/error fields, and keeps
  every saved source/profile reference. Stale workers cannot publish through the old ETag.

The store validates all reads/writes, uses Cosmos transactional `ifMatch` conditions, handles
bodyless SDK batch responses, and only returns due queued or expired-leased processing work.
Routine application logs must not contain resumes, raw model responses, or personal source URLs.
Extracted text from DOC, like PDF/DOCX/HTML text, still goes to the configured Foundry model
for profiling and to separately requested analyses; local DOC extraction is not an offline-only
processing guarantee.

## Private preview and rollout

DOCX has an optional approximate formatted preview from Mammoth in a cancellable browser
worker, DOMPurify sanitization, and a restrictive sandbox/CSP. It is not Word page fidelity,
and its HTML is never evidence for profile fields or scoring. DOC uses extracted-text preview.
Both keep original downloads workspace-authorized; no external viewer/conversion service,
public Blob URL, or browser-storage persistence is used. Preview failures do not replace or
invalidate the authoritative extracted document; citations return to extracted evidence.

Provisioning and deployment hooks close the Word admission gate before shared consumers
change. The gate can reopen only after the compatible job, grade, resume, and analysis
worker build artifacts and initial executions all verify, their image/entry-point bindings
still match, and incompatible older executions have drained. A partial/failed or renderer-only
rollout leaves Word disabled. Keep upgraded source readers available for stored Word documents
even when admissions are paused. See the root README for the versioned image/manifest checks
and rollout commands; these instructions do not imply any live environment has been upgraded.

## Targeted validation

Run `node --test server-tests\real-resumes.test.mjs`. The test builds its own isolated server
module beneath `dist-server`, uses the actual router, authorization, service, validators, and
Azure adapters with in-memory Cosmos/Blob transports, and removes its generated module afterward.
It needs no deployed cloud resources, model calls, browser login, or live candidate data.
