# Score

A jobs-first workspace for comparing resumes against clear criteria, with every score connected to its supporting evidence.

**Authenticated cloud mode supports real job and resume imports, source-grounded GS ladders, and manually requested evidence-backed analyses.** Microsoft Entra authentication and workspace membership protect private sources and results. Each real feature requires its configured stores and deployed worker; this repository does not imply that an existing Azure environment has been upgraded. Standalone local mode and the separate **Samples** views remain fictional. Scores are document-evidence review aids, not official GS eligibility findings, intrinsic measures of a person, or hiring decisions.

## Run locally

Use Node.js 24 and npm.

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite, normally `http://127.0.0.1:5173`.

```powershell
npm run build
npm run lint
npm run test:server
npm run test:worker
npm run test:renderer
node --test src\services\*.integration.test.mjs
npm run preview
```

Standalone Vite mode uses the browser-only sample workspace. Real imports require the authenticated Azure API and processing services; `VITE_DEPLOYMENT_MODE=cloud` selects that integration at build time and never substitutes samples when the services are unavailable.

The application uses React 18, TypeScript, Vite, Tailwind CSS, React Router, and accessible Radix dialog primitives. Styling is custom: restrained glass surfaces, a warm light theme, and a charcoal dark theme. Theme colors are centralized in `index.html` as Clawpilot CSS variables. Light, Dark, and System preferences are supported; the host's `scoutTheme` query parameter takes precedence when supplied.

## Explore the workflow

1. **Jobs:** In Azure, choose **Real jobs**, then **Add jobs** to upload actual PDFs or advertised Markdown files (`.md` / `.markdown`), plus DOCX and legacy DOC when Word imports are enabled, or import direct public posting URLs. Each input creates its own job and associated rubric. The separate **Samples** view and standalone local mode expose fictional jobs and simulated discovery; the OPM preset is not a live website integration.
2. **Resumes:** In cloud mode, upload actual PDFs, advertised Markdown files, or enabled Word formats, or enter public resume/profile URLs, one per line, with up to 10 total inputs per batch. Inspect ready documents, provenance, and item-level errors. The separate sample library still contains fictional profiles.
3. **Rubrics:** Review job-specific criteria or choose **Create grade ladder** from a real job to prepare separate GS levels. Inspect the selected sources and grade matrix before approving supported versions. Sample GS rubrics remain separate. Weights must total 100.
4. **Analyses:** Select ready real resumes and saved real job rubrics or exact approved GS versions, review the comparison count, then explicitly start the run. The limit is 500 resume/target pairs. Importing never starts scoring automatically. Sample analyses use a separate fixture scorer that rejects real or mixed selections.
5. **Evidence:** Open a comparison to inspect criterion assessments, an available weighted 0-100 score, evidence gaps, and exact resume quotations beside the frozen job/GS requirement citations. Results retain their original documents, rubric versions, and approval provenance even after later edits.

Jobs, Resumes, and Analyses support reversible column sorting and a sorting selector, including on smaller screens. Sort names and labels alphabetically, counts numerically, dates chronologically, or processing status with attention-needed or completed work first. The default-order option restores each view's original order. Sorting does not change selections or saved records; processing completion is not a record of human review.

Inside an analysis, **Search comparisons** finds saved candidate names, roles, document labels, and job or grade names. Choose one exact target before sorting evidence-match scores high-to-low or low-to-high; **All targets** keeps the separate comparisons visible without combining their scores into a ranking. Missing or withheld scores stay after numeric scores in either direction, and zero remains a real score. Search, target, and sort choices remain in place while opening a comparison and returning, but reset when leaving the view or changing runs/workspaces. Searches use saved summary metadata, not full document text, and are not stored in browser storage or URLs.

Use the sample import and analysis **Demo scenario** controls to explore simulated failures, partial results, cancellation, and retry. Real imports and analyses instead show durable server progress and actual processing errors. One inaccessible URL or failed comparison does not discard successful items.

Custom criteria in sample rubrics have no fixture assessment. They are explicitly marked not assessed, and the overall score is withheld rather than invented. Other mock scores follow synthetic evidence profiles; editing sample criterion wording does not invoke a real assessment. Real analyses evaluate the exact saved criteria, including custom wording, against the frozen resume evidence.

Sample GS examples are illustrative. Source-backed grade drafts and real assessments also require human review and are not official OPM classification or eligibility determinations. Missing resume evidence does not prove a person lacks a skill. Do not treat a score as a hiring recommendation or automate employment decisions from it.

## Real job ingestion

The authenticated API accepts raw PDF or UTF-8 Markdown bytes, DOCX or genuine Word 97–2003 DOC bytes when the Word admission gate is enabled, or a direct public HTML/PDF URL. **Markdown and Word are file-upload only, not URL ingestion.** One input must describe one job; listing/search pages and whole-site discovery are outside this release.

1. The API checks workspace membership, validates the input, and publishes an idempotent job record. Uploaded originals are stored immutably in the private `job-sources` Blob container before publication.
2. A Container Apps Job runs every minute, claiming pending Cosmos records with ETag leases and heartbeats. Processing continues after the browser closes; an import may wait about a minute before starting.
3. Azure Document Intelligence extracts PDF text, performs OCR on scanned PDF pages, and extracts DOCX text. Legacy DOC text is extracted locally in a bounded Node parser, without Word, LibreOffice, Python, or another service. Markdown is strictly decoded as UTF-8 and parsed locally with `marked` into ordered, citable text with headings, lists, tables, and code; it uses neither OCR nor a browser renderer. URLs use bounded HTML/JSON-LD extraction, with a separate private Chromium renderer when JavaScript is needed. Direct links that return PDFs use the same PDF pipeline.
4. Foundry generates a schema-constrained rubric from the extracted source. Criteria include required/preferred distinctions, 0-5 scoring guidance, weights totaling 100, and exact paragraph quotations. Metadata, weights, and citations are validated before publication; invalid output is repaired once or reported as an error, never replaced with a sample rubric.
5. Open the job to inspect its source beside the saved rubric. Citation links highlight the original passage, and the original file remains downloadable through the authorized API. Reviewer edits require the current job ETag and append an immutable rubric version.

| Limit | Current value |
| --- | --- |
| Uploaded file size | 10 MiB per PDF, Markdown, DOCX, or DOC |
| PDF page count | 50 pages; this limit does not apply to Markdown or Word |
| Import batch | Up to 10 inputs; each remains an individual job |
| Normalized source text | 180,000 characters |
| Direct URL length | 4,096 characters; public HTTP(S), standard ports only |
| Rubric | Up to 20 criteria; weights must total 100 |
| Transient processing failures | Up to three automatic attempts with backoff; explicit retry after failure |

Jobs expose queued, parsing, generating, ready, error, and cancelled states. Cancellation prevents late worker results from being published. Retrying reuses any preserved original and extracted source instead of silently changing the evidence. Encrypted/unreadable documents, invalid Markdown encoding, unsupported formats, protected websites, and invalid generated output produce actionable errors. Public URLs do not carry the user's browser login, cookies, or credentials.

Markdown uploads accept `.md` and `.markdown` extensions case-insensitively, with UTF-8 encoding (an optional UTF-8 BOM is supported). Empty, binary, invalidly encoded, and oversized inputs are rejected explicitly; extracted text is never silently truncated. Original bytes and filenames remain downloadable. The evidence viewer shows Markdown as text sections with citation highlighting, not as executable HTML or a rendered Markdown page. Embedded HTML and front matter remain inert text, and linked images/assets are never fetched. Markdown URL ingestion, Markdown export, and Markdown supporting-reference uploads for GS ladders are not included.

When upgrading from workers without Markdown support, deploy the updated job, resume, grade-ladder, and analysis workers before the Markdown-capable web/API release so older workers never encounter Markdown records or snapshots. The authenticated feature response advertises `markdownJobImports` and `markdownResumeImports` separately, based on the corresponding real backend's availability; Markdown needs no new global environment flag. Missing or false Markdown capability fields do not enable Markdown uploads in the UI. The separate Word admission gate does not pause Markdown imports.

### Source isolation and model processing

Real jobs live in Cosmos `job-records`, partitioned by workspace. These records are also the durable work queue; there is no separate queue publication that can get out of sync. Originals and normalized source documents live in `job-sources`. They are not part of the legacy sample-state autosave and are not overwritten by sample reset or workspace snapshots.

The dedicated worker identity can access job records/sources, Document Intelligence, and Foundry inference, but not the legacy workspace-state Blob container or shared knowledge contents. Public HTTP requests use DNS-pinned connections, validate every redirect, and reject private, loopback, metadata, and other reserved addresses.

In the hosted deployment, Chromium runs only in an internal-ingress Container App, separate from the credentialed worker. Its dedicated identity is for ACR image pulls only, with runtime identity access disabled. Startup verifies that the identity broker cannot issue a token, then removes broker variables before launching browser code. Browser requests use the same restricted public transport; fresh contexts have bounded time, request count, and response sizes, with no persistent profile, downloads, service workers, or WebSockets.

PDF and DOCX job bytes are sent to Azure Document Intelligence for extraction; DOC extraction runs locally with the pure-Node `word-extractor` parser, and Markdown extraction runs locally with `marked`. Extracted text from all supported formats is sent to the configured Foundry model for rubric generation. The infrastructure configures **GPT-5 mini (`2025-08-07`), deployment `job-rubric`, Data Zone Standard**. The Foundry resource is configured in North Central US, but model inference uses the **US data zone**, not a guarantee of North Central US-only processing. Generated rubrics need human review; exact citations establish traceability, not correctness of every interpretation.

### Uploaded formats, evidence, and private Word previews

Markdown and Word support applies only to **real job-description and resume file uploads**. It does not change sample imports, add Markdown/Word URL ingestion, or permit independent agency/OPM reference Markdown/Word uploads. A ready Markdown- or Word-backed job can still seed a GS ladder, and those ready jobs/resumes can participate in explicitly requested real analyses.

| File format | Canonical upload MIME type | Extraction and preview |
| --- | --- | --- |
| PDF | `application/pdf` | Existing Document Intelligence text/OCR and PDF-page evidence |
| Markdown (`.md` / `.markdown`) | `text/markdown` | Strict UTF-8 decoding and local `marked` text extraction; text-section evidence, never an HTML preview |
| DOCX | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | Existing Document Intelligence text extraction; optional approximate formatted preview |
| DOC | `application/msword` | Local binary Word text extraction; extracted-text preview only |

The **10 MiB file**, **10-input batch**, and **180,000 normalized-character** limits apply to all supported uploads. The **50-page limit is PDF-only**. Markdown uses `markdown-sections`; Word uses `captured-sections`. Both have null physical page counts and stable paragraph citations; Document Intelligence's DOCX processing units are not printed Word pages. Tables, headings, and other available text contribute to the same bounded evidence, not a separate scoring path.

DOCX formatted previews use Mammoth in a cancellable browser worker, sanitize the untrusted result with DOMPurify, and display it in a restrictive sandbox/CSP. They approximate headings, lists, tables, emphasis, and supported raster images; they do **not** reproduce Word pagination or exact layout. Preview formatting is never scoring evidence: citations return to the authoritative extracted-text view. Preview conversion failures remain visible and do not invalidate a successfully extracted document. Legacy DOC previews show extracted text, not Word formatting.

The browser fetches original bytes only from authenticated, same-origin, workspace-authorized endpoints. No public Blob link, external Office/Google viewer, or third-party preview/conversion upload is used; originals and preview HTML are not persisted in browser storage. External resources and active content are not executed. The original bytes remain unchanged and privately downloadable.

DOCX ZIP structure/expansion and legacy DOC structure are checked with bounded, terminable local parsing. Renamed ZIP/OLE files, mismatched MIME/extensions, corrupt or encrypted documents, DOCM, RTF, and templates are not supported. Macros and embedded objects are never executed. **OCR of embedded or linked Word images is not supported**: export an image-only or scan-heavy document to PDF and use the existing PDF/OCR workflow.

### File upload API and compatibility

These paths have prefix `/api/workspaces/:workspaceId` and require authentication, workspace write authorization for imports, and the existing same-origin CSRF headers (`Origin` and `X-Score-Request: workspace`).

| Method and path | Contract |
| --- | --- |
| `POST /jobs/file` | Canonical raw PDF/Markdown/DOCX/DOC upload; `{ job }`, 202 on acceptance or 200 on confirmed replay |
| `POST /jobs/pdf` | Existing strict PDF-only alias; unchanged PDF fingerprints and replay behavior |
| `POST /jobs/markdown` | Existing Markdown-only upload endpoint; strict UTF-8 `text/markdown` and `.md` / `.markdown` filename |
| `POST /resumes/file` | Canonical raw PDF/Markdown/DOCX/DOC upload; `{ resume }` with ETag, 202 on acceptance or 200 on confirmed replay |
| `POST /resumes/pdf` | Existing strict PDF-only alias; unchanged PDF validation and receipt replay |
| `POST /resumes/markdown` | Existing Markdown-only upload endpoint; unchanged Markdown validation and receipt replay |
| `GET /jobs/:jobId/original` | Workspace-authorized private original attachment |
| `GET /resumes/:resumeId/original` | Workspace-authorized private original attachment |

Send the matching canonical `Content-Type`, percent-encoded safe basename in `X-File-Name`, and a UUID `Idempotency-Key` per input. Markdown permits `text/markdown` with no charset or `charset=utf-8`; other declared encodings are rejected. Send original bytes, not multipart or compressed request bodies. Job file imports retain optional UUID `X-Import-Batch`; resume imports require UUID `X-Import-Batch` and decimal `X-Import-Count` (1–10), identical across that batch. Filenames are display-only, never storage paths or inferred person identities. After an ambiguous response, keep the same key, bytes, filename, and batch headers rather than creating a replacement item.

Originals use immutable `original.pdf`, `original.md` (also for `.markdown` filenames), `original.docx`, `original.doc`, or URL-captured `original.html` beneath the owning job/resume prefix in its existing private container. Downloads verify ownership, MIME, length, and SHA-256 and remain `no-store`, `nosniff`, attachment-only responses. Original bytes, including Markdown BOMs and line endings, are preserved. Existing history is not rewritten. Resume PDF/URL receipts stay schema version 1, including the existing `pdfSha256` field. Markdown receipts remain version 1 with their separate `markdownSha256` field and fingerprints. New Word receipts use additive version 2 with `fileSha256`; PDFs and Markdown sent to `/file` retain their respective version-1 receipt contracts.

## Source-grounded GS grade ladders

A ready real job, including a Markdown- or Word-backed job, can seed a new family of GS grade rubrics without changing the job or its original rubric. Confirm the occupational series and requested grades, review applicable OPM sources, optionally supply agency PDFs/public HTML/PDF URLs, and generate independent grade drafts. Markdown and Word are supported here only as captured seed-job evidence, not as independent reference uploads or URLs. The API captures the exact seed rubric and source so later job edits cannot change the ladder's evidence.

**Automatic discovery accepts any GS occupational series, but does not guarantee that every requested grade has sufficient evidence.** It follows actual classification, qualification, family, functional-guide, and competency-policy references rather than guessing URLs or using model memory as the authority. Agency, supervisory/leader, research, or other applicability questions are surfaced when relevant. A "Program Manager" title alone does not determine the correct series or grading guide.

Source review distinguishes grading, classification, qualification, agency, issuance, and background documents. Captures retain requested/final URLs, intended sections, source relationships, revisions, hashes, extraction details, and exact passage/page references. Named qualification groups and table headers are preserved rather than using the first tab on an OPM page. Contradictory, retired, or superseded references are explicit review issues.

Confirming applicability records the reviewer's scoped decision, not a finding that the document supports every requested grade. It cannot override source-authority conflicts, explicit exclusions, or unsupported claims. Discovery-only capture notices can be resolved by the exact captured document/section. A missing linked reference is resolved only when its exact target is captured and selected in that frozen source set; deselecting it in a later set restores the gap. Resolution provenance and original discovery notices remain inspectable.

The grade matrix aligns competencies across levels while keeping each grade's expectations, weights, guidance, and review status separate. Click a citation to inspect the exact captured reference. Qualification requirements are unscored and separate from weighted work expectations; classification factor points are not presented as hiring-score weights.

Every grade receives deterministic citation/structure checks and a separate model grounding review. **Unsupported grade expectations remain incomplete drafts until supporting evidence is supplied. There is no custom-expectation approval bypass.** Supported grades can progress independently of another grade's gaps or failures. Reviewer approval is recorded against the exact immutable version, review, and source set; it is not OPM certification.

Gaps keep their weight unallocated and can be saved as incomplete drafts. Explicitly source-supported exclusions may remain as unscored, not-applicable matrix rows; approval still requires supported work criteria totaling 100 and a successful independent review of those exclusions.

Draft edits, source updates, and additional grades create new work and versions rather than rewriting approved results. Original files and historical source sets remain inspectable. Closing a browser does not stop accepted processing; retry/cancellation and partial progress are durable.

| Reference limit | Value |
| --- | --- |
| Supporting references | Up to 15, in addition to the captured seed-job context |
| Reference PDF size | 20 MiB; independent of the smaller job-upload limit |
| Selected PDF pages | Up to 250 per reference, 500 across a source set |
| Large references | Explicit page selection and cached extraction chunks; no silent truncation |
| Extracted reference text | Up to 2,000,000 characters per document |
| Model context | Bounded source passages; omitted or insufficient context is not treated as reviewed |
| Grades and criteria | GS-1 through GS-15 may be requested; up to 20 criteria per grade, subject to source support |

Real ladder families, work items, heads, versions, reviews, and approvals are stored in private Cosmos `grade-records`. Originals and extracted reference snapshots are stored in private Blob `grade-sources`, not legacy sample autosave or shared IQ. The separate scheduled grade worker has its own identity and no access to job or legacy workspace stores. It shares the existing model, OCR service, and internal renderer, so normal throttling/backoff still applies.

The cloud feature flag is `REAL_GRADE_LADDERS_ENABLED`. Without configured grade services the UI reports the feature as unavailable; it never substitutes a synthetic ladder.

## Real resume ingestion

The authenticated API accepts actual PDF or UTF-8 Markdown bytes, enabled DOCX/legacy DOC file uploads, and direct public HTTP(S) HTML/PDF resume/profile URLs, including LinkedIn profiles **only when publicly accessible**. Markdown and Word URLs are not supported. Each input describes one person, not a directory of profiles or a crawl. Limits are **10 MiB per uploaded file**, **50 pages per PDF only**, **10 total PDF/Markdown/Word/URL inputs per batch**, **4,096 characters per URL**, and **180,000 normalized source characters**, including headings. A same-named file is not assumed to be the same person; exact source/content repeats produce workspace-local duplicate warnings rather than silently merging profiles.

Accepted inputs continue processing after the dialog or browser closes. Per-item states distinguish queued, parsing, profiling, ready, error, and cancelled. Uploaded originals are stored immutably before work is published; URL workers preserve the captured original and manifest before profiling. The dedicated resume worker uses local Markdown text extraction, the existing Document Intelligence service for PDF/OCR and DOCX, local Node extraction for DOC, resume-aware HTML extraction, the isolated internal renderer when necessary, and the configured Foundry model for evidence-grounded display metadata. Missing names, roles, or other fields remain unavailable rather than being invented from filenames.

Public fetches never use the browser's signed-in session, cookies, or credentials. Sign-in, access-blocked, consent, and challenge pages cannot become ready resumes. A private or blocked profile reports **“This URL is not publicly accessible and could not be processed.”** There is no LinkedIn account integration, authentication/CAPTCHA bypass, or third-party scraping service. Missing pages, network failures, unreadable PDFs, unsupported content, and service outages retain their distinct error messages; not every failure means a URL is private. Sparse but genuine public profiles may provide much less evidence than full resumes.

Static HTML imports honor supported declared encodings and preserve the original capture bytes. Malformed or unsupported encodings produce explicit errors rather than silently replacing characters in names or evidence. If an encoding error prevents import, supply a UTF-8 public profile page, a readable PDF, or a UTF-8 Markdown file.

Inspect the actual document and download its original through workspace-authorized endpoints. Captures preserve source kind, filename or requested/final URL, timestamp, hash, extraction method, and stable document/version/paragraph identities. HTML and Markdown sources are displayed as untrusted text, not executed in the browser. Markdown extraction records section provenance rather than physical PDF pages. Transient errors receive up to three automatic attempts with backoff; explicit retry reuses preserved evidence instead of silently refetching a different profile. Cancellation and lost worker leases prevent late publication.

## Real evidence-backed analyses

Scoring is a separate, **manual** action after import. Choose ready real resumes and real job targets or approved GS rubric versions. The server resolves authorized IDs and exact versions, rejects stale or mixed sample/real selections, and freezes the complete comparison inputs. A newer unapproved GS draft does not replace the selected approved version. The UI shows the resume/target pair count before submission; more than **500 comparisons** is rejected, never silently truncated. For example, 103 resumes against four jobs produce 412 comparisons in one run.

Every comparison is independent. Larger runs use the same bounded background processing and concurrency, so they may take longer. Durable initialization, progress, cancellation, and retry preserve completed results if another comparison fails. Retries use the original immutable snapshots; selecting updated sources or rubrics requires a new run. Original resume quotations, saved job requirements, and historical GS reference captures remain available for inspection.

If cancellation pauses after processing errors or exhausted automatic retries, choose **Resume cancellation** to continue the saved cleanup. This does not restart scoring, replace snapshots, or change completed results. Individual comparisons can be retried only after that cleanup finishes.

The assessment follows the saved criteria and 0-5 scoring anchors. Positive scores require exact citations from the correct frozen resume document. Absence of supporting evidence is an explicit evidence gap, not a claim about the person's ability. An unassessable positively weighted criterion withholds the overall score rather than becoming an invented zero or silently changing the weights. Source-supported GS not-applicable rows remain unscored and zero-weight. **GS qualifications remain separate and unscored for human review**, not official eligibility findings.

Schema/coverage/citation checks and an independent grounding review precede publication; at most **two output corrections total per processing attempt** are shared across assessment validation, grounding-review validation, and semantic reassessment. Changing stages does not reset that budget. Weighted totals are calculated deterministically from validated criterion scores and unchanged rubric weights, not supplied by the model. Full-input context limits are reported as actionable limitations rather than silently dropping resume sections. Model identity, prompt/schema versions, grounding-review results, and frozen input identities/hashes are retained. Traceable quotations do not guarantee correct interpretation: humans must review the evidence and limitations. Different job or grade totals are not combined into a hiring ranking.

### Analysis failure diagnostics and retries

`invalid-citation` is a local evidence-validation failure, not an HTTP rate-limit response. Model-written quotations must be exact contiguous substrings of the specified frozen resume paragraph, preserving whitespace and punctuation; repeated citations within one list are also rejected. Shorter literal quotations are allowed, but rewritten text, normalized whitespace, or spliced passages are not. Errors identify the assessment or grounding-review stage and the affected row/citation. When deterministically identifiable, diagnostics distinguish whitespace changes and a quotation found in a different supplied paragraph; neither is silently accepted or reassigned.

Correction requests receive bounded, citation-specific findings and supplemental copies of relevant trusted source paragraphs. The complete frozen input is still supplied unchanged, and omitted supplemental paragraphs/findings are counted explicitly. Raw invalid model output is not echoed back. A corrected assessment still needs a supported independent review before publication. Two semantic reassessments can produce up to three saved reviews and six logical model calls; the existing bounded transport retries remain separate. Once the correction budget is exhausted, invalid output fails that comparison without a score or an automatic validation-retry loop.

Transient service failures retain their separate transport retries and up to three automatic processing attempts. **Retry saved pair** starts a fresh processing cycle against the same immutable inputs, so different model output can succeed without the resume changing. Completed comparisons are not replayed. `service-unavailable`, `timeout`, and citation/grounding failures remain distinct.

The analysis worker writes structured JSON events with `component: "score-analysis"` to the existing `ContainerAppConsoleLogs` table. Events include model responses, validation failures, correction attempts, and comparison outcomes, correlated by workspace, run, comparison, processing-attempt, and model-call IDs. They record stage, deployment, actual response model when available, prompt/schema versions, correction and transport-attempt numbers, HTTP status, bounded request IDs, durations, and privacy-safe citation reason/location metadata. Raw resumes, quotations, model output, credentials, and arbitrary upstream error bodies are not logged. An HTTP 200 followed by `validation-failed` is therefore distinguishable from an HTTP 429 without retaining private content.

For an authorized operator investigating a specific saved run:

```kusto
ContainerAppConsoleLogs
| where TimeGenerated > ago(24h)
| where JobName == "<analysis-worker-job-name>"
| extend Event = parse_json(Log)
| where Event.component == "score-analysis" and Event.runId == "<saved-run-id>"
| project TimeGenerated, Event.event, Event.comparisonId, Event.attemptId,
    Event.modelCallId, Event.stage, Event.httpStatus, Event.correctionCount,
    Event.code, Event.outcome, Event.citationDiagnostics
| order by TimeGenerated asc
```

Deploy and confirm readiness of API readers that accept two corrections and three grounding reviews **before** activating the updated analysis worker. The `azure.yaml` web deployment precedes its post-deploy worker update; preserve that compatibility order. After expanded provenance has been saved, any rollback must retain compatible readers rather than rejecting historical two-correction results. Deployment does not authorize automatic retries of an existing failed cohort.

### Private data, processing, and retention

Real resume records and durable work use workspace-partitioned Cosmos `resume-records`; original and normalized documents use private Blob `resume-sources`. Runs/comparisons use `analysis-records`, and frozen inputs/results use private `analysis-sources`. Neither is part of sample autosave, browser local storage, shared Foundry IQ, or AI Search. The API checks workspace membership before reading existing resume/job/grade inputs and writing the frozen analysis stores.

The resume worker identity can access only its own records/sources, OCR, and the shared model; it calls the existing credential-free internal renderer. The analysis worker identity can access only its own frozen analysis stores and the model, **not** resume, job, grade, legacy workspace, OCR, or Search data. Neither worker receives account keys or general workspace-storage permissions.

Actual resume/profile content can contain personal or sensitive information. PDF and DOCX bytes are processed by Azure Document Intelligence; Markdown and legacy DOC text extraction is local to the Node worker, but the extracted text still goes to Foundry. Resume text and selected rubric/source evidence are processed by Foundry for profiling, assessment, and grounding review. They reuse the existing **GPT-5 mini `job-rubric` deployment and US Data Zone Standard inference** described above, not a North Central US-only processing guarantee. Word previews add no external processing service. Do not import data without the appropriate authority and organizational review. Routine logs must not contain resume text, contact details, raw model responses, or personal source URLs.

This release retains private immutable captures and results. **Reset samples does not delete real resumes, analyses, jobs, grade ladders, or their source/version history.** Resume replacement/editing, deletion, and retention administration are not provided by this release; operators must establish an appropriate retention/deletion process. Blob soft-delete retention also applies after operator deletion.

## Deployment to Azure

The deployment uses Azure CLI (`az`), Azure Developer CLI (`azd`), Node.js 24, and PowerShell 7. Docker is not required locally: the web, worker, and renderer Linux images are built remotely in Azure Container Registry.

Sign in to the intended Microsoft Entra tenant with both tools, then run:

```powershell
az login
azd auth login
.\scripts\deploy.ps1
```

The script defaults to subscription `9698dd71-9367-49c2-bede-fd0deecfad62`, location `northcentralus`, environment `score-demo`, resource group `rg-score-demo-ncus`, and application user `paullizer@retroburn.cloud`. It does not change the Azure CLI's global subscription selection. Deployment requires resource/RBAC provisioning rights and directory permissions to create the application registration, assign its user role, and grant that user basic sign-in consent.

For separate provisioning or application updates:

```powershell
.\scripts\deploy.ps1 -ProvisionOnly
.\scripts\deploy.ps1 -DeployOnly
```

After initialization, the underlying azd commands are also available:

```powershell
azd provision --environment score-demo --no-prompt
azd deploy web --environment score-demo --no-prompt
azd env get-value AZURE_APP_SERVICE_URL --environment score-demo
```

`azure.yaml` and `infra\` define the deployment. The pre-deployment gate refuses to publish an application unless HTTPS, required Easy Auth, the configured tenant/user restriction, and the Key Vault authentication reference are active. Only `/healthz` bypasses sign-in, and it reports no user data.

Provisioning creates separate job/grade/resume/analysis Cosmos and private Blob stores, dedicated worker identities, and the existing shared Document Intelligence/model/isolated-renderer services. No extra model, Search index, or LinkedIn resource is introduced for resumes. The postdeploy hook builds the renderer and one shared worker image containing four independent worker entry points, waits for the renderer's latest revision, and validates the registry, identities, store boundaries, and processing-service configuration.

Each worker is updated in manual mode, must complete a successful initial execution, and is only then scheduled. Resume/analysis API flags are disabled during worker rollout and enabled after their respective workers pass. New analysis runs additionally require resume services and an available job or grade target service; historical reads, cancellation, and already-frozen initialization require only the enabled analysis API and its own stores. The initial execution validates startup, configuration, and available work, not the quality of every future model response.

`AZURE_WORKER_CONTAINER_IMAGE` and `AZURE_GRADE_WORKER_CONTAINER_IMAGE` remain independent. New `AZURE_RESUME_WORKER_CONTAINER_IMAGE` and `AZURE_ANALYSIS_WORKER_CONTAINER_IMAGE` start with placeholder images, **not** an inherited job/grade image. Resume/analysis schedules and provisioning-time flags stay disabled until their independently saved pins identify the new `score-worker:resume-analysis-*` image family and required services exist. Deployment saves each pin only after its matching `dist-worker/resume-worker.mjs` or `dist-worker/analysis-worker.mjs` entry point executes successfully. Shared packaging also includes both corresponding runtime bundles.

**Word has a separate, fail-closed rollout gate: `WORD_DOCUMENT_IMPORTS_ENABLED`.** Provisioning always writes `false`, regardless of saved image pins. The pre-provision hook disables admission in an existing environment, and the pre-deploy hook disables it before replacing the web application. Worker configuration disables it again before any renderer or worker changes. A renderer-only update leaves it disabled. No new stores, services, or identity permissions are required.

The worker workflow now builds fresh `score-worker:resume-analysis-word-v1-*` tags. The broader older `resume-analysis-*` family is **not evidence of Word compatibility**. Both web and worker containers require their sibling `word-parser.mjs`; the worker packaging check also writes a versioned `dist-worker/word-imports.json` SHA-256 manifest covering every worker/runtime bundle and the parser. Each manual initial execution validates that manifest, its actual artifacts, and the extraction runtime's exported `WORD_EXTRACTION_VERSION=score-word-extraction-v1` before running its ordinary entry point. A retagged older image or self-consistent manifest with an older extraction runtime cannot pass.

Word admission is enabled only after **all four job, grade, resume, and analysis workers** pass in the same rollout, their execution metadata and current schedules still identify the same verified image/entry points, and no incompatible old executions remain active. Failed or partial verification leaves Word disabled without overwriting unsuccessful workers' independent pins. An ambiguous enablement response triggers a disablement attempt; if Azure cannot confirm that, deployment reports the failure and operators must verify the setting before proceeding. Older in-flight executions must finish before retrying the worker rollout. Do not bypass these checks by manually setting the flag to `true`.

Serialize provisioning and deployments; do not reuse or overwrite the workflow's fresh image tags. For an intentional admission pause before other maintenance, the provisioned environment supports `node scripts\azure-worker.mjs disable-word`. Disabling this gate does **not** disable upgraded readers, original downloads, extracted evidence, or existing Word previews. Keep the corresponding real services available, and do not roll readers/workers back to PDF-only binaries after Word records exist. The normal rollout must complete again to reopen Word admission.

**Existing environments must be provisioned before deployment:** run `.\scripts\deploy.ps1 -ProvisionOnly`, then `.\scripts\deploy.ps1 -DeployOnly`. When upgrading workers that do not yet understand Markdown, run `.\scripts\deploy-worker.ps1` from this compatible build after provisioning and **before** `-DeployOnly`; the normal postdeploy verification still runs afterward. `-DeployOnly` and worker deployment refuse environments missing the new worker outputs. To rebuild processing services alone after provisioning, run `.\scripts\deploy-worker.ps1`. Merely changing infrastructure files or copying an old worker image does not create stores, permissions, or new functionality. These instructions describe the required rollout; no live Azure upgrade is implied.

| Feature | Environment gate (explicit `true`/`false`) | Dedicated Cosmos / Blob settings |
| --- | --- | --- |
| Real jobs | `REAL_JOB_IMPORTS_ENABLED` | `JOB_RECORDS_CONTAINER=job-records`, `JOB_SOURCE_CONTAINER=job-sources` |
| Real GS ladders | `REAL_GRADE_LADDERS_ENABLED` | `GRADE_RECORDS_CONTAINER=grade-records`, `GRADE_SOURCE_CONTAINER=grade-sources` |
| Real resumes | `REAL_RESUME_IMPORTS_ENABLED` | `RESUME_RECORDS_CONTAINER=resume-records`, `RESUME_SOURCE_CONTAINER=resume-sources` |
| Real analyses | `REAL_ANALYSES_ENABLED` | `ANALYSIS_RECORDS_CONTAINER=analysis-records`, `ANALYSIS_SOURCE_CONTAINER=analysis-sources` |
| Markdown file admissions | No separate flag; follows real job/resume availability | No additional stores; advertised as `markdownJobImports` / `markdownResumeImports` |
| New Word file admissions | `WORD_DOCUMENT_IMPORTS_ENABLED` | No additional stores; requires a real job or resume service and the verified four-worker rollout |

Absent environment flags disable the corresponding gated real feature. `/api/features` reports configured availability and authoritative import/analysis limits without a sample fallback; its `realAnalyses` field indicates readiness for **new runs**, not the existence of saved history. `markdownJobImports` and `markdownResumeImports` follow the availability of their respective real services without a new global flag. `wordDocumentImports` is true only when the explicit Word flag and at least one real job/resume service are available. Missing or false format-capability fields disable their respective uploads; older APIs lacking all of them remain **PDF-only**. The Word gate controls new Word admissions, never stored source/schema support or Markdown availability. Disabling a source feature does not disable authorized historical analysis operations when the analysis API itself remains enabled.

Cosmos and Blob names must be distinct across all five workspace/job/grade/resume/analysis stores, including inactive-feature defaults. The API uses `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, and `STORAGE_ACCOUNT_URL`; workers receive only their own store names and dedicated managed identity. All workers reuse `RUBRIC_MODEL_ENDPOINT`, `RUBRIC_MODEL_DEPLOYMENT`, `RUBRIC_MODEL_NAME`, and `RUBRIC_MODEL_REASONING_EFFORT`. Only extraction workers receive `DOCUMENT_INTELLIGENCE_ENDPOINT` and internal `JOB_RENDERER_URL`. New execution bounds are `RESUME_WORKER_MAX_ITEMS=5` and `ANALYSIS_WORKER_MAX_ITEMS=2`, with a 900-second job timeout, one replica, and no platform retry loop; durable item-level backoff handles transient failures and shared-model throttling.

Deploy matching web/API and analysis-worker builds when changing the comparison limit. Both validate saved runs and manifests; a frontend-only update does not enable larger analyses.

Explicit local worker testing is separate from the standalone fictional Vite demo: `WORKER_AUTH_MODE=azure-cli` uses the developer's Azure CLI identity against real configured services and data. Never enable that mode in hosted workers. A local resume worker may use an explicitly configured HTTP loopback renderer; hosted rendering remains private HTTPS. That loopback exception applies only to the isolated renderer connection, not imported source URLs. The credentialed worker never launches Chromium or forwards its credentials to rendering. Resume/analysis execution budgets default to 660,000 ms (11 minutes), below the container timeout; the infrastructure explicitly overrides their item limits to 5 and 2 respectively.

| Service | Configuration and purpose |
| --- | --- |
| App Service | One Linux B1 instance serving the React SPA and authenticated workspace API |
| Container Registry | Basic registry; managed-identity image pulls, no registry administrator password |
| Cosmos DB | Serverless workspace directory/membership and separate `job-records`, `grade-records`, `resume-records`, and `analysis-records` durable records/work queues, all partitioned by `/workspaceId` |
| Blob Storage | Private `workspace-state`, `job-sources`, `grade-sources`, `resume-sources`, `analysis-sources`, `documents`, and `knowledge` containers; shared-key access disabled |
| Microsoft Foundry | AI Services account/project, GPT-5 mini rubric deployment, and managed-identity Search/Blob connections |
| Document Intelligence | Existing S0 resource for PDF layout/text extraction and OCR, plus DOCX text extraction (not Word image OCR) |
| Container Apps Jobs | Separate job, grade, resume, and analysis workers, each with its own scoped identity and 1 CPU / 2 GiB; bounded work per execution |
| Internal Container App | Isolated Chromium renderer, 1 CPU / 2 GiB, scale-to-zero, no runtime data credentials |
| Foundry IQ / AI Search | Basic Search service, extractive knowledge source/base, and explicitly capped free knowledge-retrieval/semantic plans |
| Key Vault | Easy Auth application credential, accessed through the web app's managed identity |
| Azure Monitor | App Service diagnostics in Log Analytics; Application Insights provisioned for subsequent tracing integration |

All regional resources use North Central US, with the US data-zone inference distinction described above. App Service, ACR, and Search have ongoing infrastructure charges even when idle. Foundry inference is token-billed, Document Intelligence is page-billed, and Container Apps execution, storage, Cosmos, and diagnostics have usage-based costs. The rubric deployment reserves 100k tokens/minute of quota; this is throughput capacity, not a spending cap. The free IQ retrieval allowance is not a free Search hosting plan, and it does not cover rubric-model or OCR usage. Paid continuation after that retrieval allowance is not enabled.

The 10-input and 500-comparison limits bound submitted work, **not dollars**. Profiling, assessment, independent grounding-review calls, output corrections, and retries can each consume inference; OCR is billed separately. All workers share the model's throughput budget. Throttling/backoff and cancellation do not refund processing already performed.

### Authentication and credential rotation

The Entra application is tenant-only and requires an assigned `Score.User` application role. The configured user is assigned that role and granted only basic `openid`, `profile`, and `email` sign-in consent for that user. Easy Auth and the API independently restrict access using immutable object/tenant IDs, not email addresses. Workspace membership is checked server-side on every operation.

Choose `paullizer@retroburn.cloud` at the browser account picker. Other cached accounts, including a Microsoft work account, are not automatically granted access merely because they can manage the Azure subscription. Azure CLI application-token consent is separate from browser sign-in and is not enabled by this deployment.

The login credential is generated in memory and written directly to Key Vault; it is never printed, put into azd environment values, or committed. Credentials last 180 days. Provisioning reuses valid credentials and rotates them when fewer than 30 days remain. To rotate proactively:

```powershell
node scripts\azure-auth.mjs configure --rotate
```

This refreshes App Service's versionless Key Vault reference. `.azure\` and local environment files are excluded from Git and the Docker build context. Do not publish those files or paste token/secret output into logs.

### Cloud workspaces and future groups

The cloud build uses `VITE_DEPLOYMENT_MODE=cloud`. It never falls back to local fixtures if authentication or cloud storage fails. Each user can create, rename, and switch between multiple personal workspaces. Cloud links include `/workspaces/<id>/` so a bookmark cannot silently resolve against a different selected workspace.

Cosmos stores directory and membership documents together under the `/workspaceId` partition key. Legacy sample workspace state is stored in a private Blob rather than a single Cosmos item, avoiding Cosmos's per-item size limit. Sample saves require the current Blob ETag; metadata renames require the metadata ETag. Real job, grade, resume, and analysis mutations use separate versioned APIs and Cosmos ETags. Concurrent edits produce an explicit conflict instead of silently overwriting another session.

Initialization prepares state before atomically publishing directory metadata and membership. A failed or ambiguous publication does not delete another initializer's work. Retried default-workspace creation can reuse prepared state without replacing it with samples.

Cloud mode keeps document state in memory, not browser local storage. Only theme and the last-selected workspace ID are remembered locally, with the latter scoped to tenant and user. Writes are queued and acknowledged before showing a saved state. Switching or signing out flushes pending changes and pauses browser-only demo simulations. Save failures retain the newest edits; conflict recovery is explicit.

The data model reserves `group` workspaces and `owner`/`editor`/`viewer` memberships. Group creation, sharing administration, and Entra group resolution are deliberately not enabled yet. They must use these same server-side membership boundaries rather than client-side filters.

### Foundry IQ boundary

`score-knowledge` is an extractive knowledge base over `score-demo-guide`, using Search REST API `2026-04-01`. It contains only a nonsensitive application guide in the separate `knowledge` container. No LLM deployment is needed for this mode.

Search and Foundry project identities can read that knowledge container, not the private `workspace-state`, `job-sources`, `grade-sources`, `resume-sources`, `analysis-sources`, or `documents` containers. Personal jobs, resumes, reference documents, analysis results, and workspace snapshots are not indexed. Generation and assessment send selected source text directly to the model without adding it to shared IQ or Search. Real per-workspace retrieval will require a deliberate document-isolation/filtering design before private content is connected.

Do not run `azd down` as routine cleanup: it deletes the deployment and its cloud workspace data. Key Vault also has soft-delete and purge protection.

## Standalone local mode and privacy

Standalone local imports and explicit sample-import simulations read selected file **names**, not PDF contents. They use fictional replacement content and do not fetch submitted URLs or send those documents to an AI evaluator. Cloud sample state and its source labels are saved to the authenticated user's workspace; standalone local samples stay in the browser. **Cloud real job, grade-reference, and resume imports do read, upload, extract, and store actual content; real analyses process frozen source evidence**, as described above.

In standalone local mode, demo records, source labels, rubric edits, and sample analysis snapshots are stored under `score-demo-workspace-v1` in browser local storage. Theme preference uses `score-theme`. That standalone sample path never reads or stores selected document bytes.

Reset requires confirmation. In local mode it replaces only Score's local synthetic workspace; in cloud mode it replaces only the currently selected workspace's sample state. **Real jobs, grade ladders, resumes, analyses, their sources, and immutable versions are not deleted by Reset samples.** Theme preference and unrelated browser data are kept. Storage failures and corrupt data are surfaced explicitly rather than silently replaced.

Reloading during a simulation presents unfinished work as interrupted/cancelled so it can be retried. Cloud reads do not write this presentation change back automatically, since another browser might still be working. Historical results retain their original rubric and document snapshots even after later edits.

## Code organization

| Directory | Responsibility |
| --- | --- |
| `src\app` | Navigation, themes, sample workspace state, and separate server-owned job/grade/resume/analysis state |
| `src\components` | Accessible UI primitives and source document/citation viewing |
| `src\domain` | Typed documents, jobs, rubrics, resumes, and analysis snapshots |
| `src\data` | Coherent fictional fixtures |
| `src\services` | Real job/grade/resume/analysis and cloud API clients, deterministic sample operations, and validated local persistence |
| `src\features` | Jobs, resumes, rubrics, grade-ladder review, and analysis screens |
| `src\styles` | Token-based visual system and responsive layouts |
| `server` | Authenticated workspace/job/grade/resume/analysis APIs, authorization, Cosmos adapters, and private Blob storage |
| `worker` | Durable ingestion/analysis, safe public transport, OPM discovery, source extraction, grounded generation and assessment |
| `renderer` | Isolated internal Chromium service and fail-closed runtime identity boundary |
| `server-tests`, `worker-tests`, `renderer-tests` | Node test-runner coverage of API access, concurrency, source extraction, model validation, and rendering isolation |
| `infra` | Bicep resource definitions |
| `scripts` | Container build, deployment, identity, and knowledge-base configuration |

Authenticated LinkedIn access, whole-site discovery and multi-page crawling, resume editing/deletion administration, group-workspace administration, and ATS integrations remain deferred. Direct job/profile URL rendering is not a general-purpose crawler. Real imports and assessments remain separate from sample simulations.

When hosting the built `dist` directory, configure SPA fallback to `index.html` so direct links to job, rubric, and analysis routes work.
