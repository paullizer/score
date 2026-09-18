# Score

A jobs-first workspace for comparing resumes against clear criteria, with every score connected to its supporting evidence.

**Azure jobs and source-grounded GS ladder drafts are real; resume scoring is still a simulation.** Import job PDFs or public URLs, then derive separately reviewed GS grade rubrics from the job and applicable reference documents. Microsoft Entra authentication protects personal workspaces. The separate sample library, sample GS examples, resume imports, and analysis scores remain fictional. This is a review-oriented demo, not a production hiring evaluator or official classification authority.

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

1. **Jobs:** In Azure, choose **Real jobs**, then **Add jobs** to upload actual PDFs or import direct public posting URLs. Each input creates its own job and associated rubric. The separate **Samples** view and standalone local mode expose fictional jobs and simulated discovery; the OPM preset is not a live website integration.
2. **Resumes:** Browse fictional profiles, preview their documents, select several, or simulate a batch import.
3. **Rubrics:** Review job-specific criteria or choose **Create grade ladder** from a real job to prepare separate GS levels. Inspect the selected sources and grade matrix before approving supported versions. Sample GS rubrics remain separate. Weights must total 100.
4. **Analyses:** Select sample resumes and sample job rubrics, illustrative grade rubrics, or both. Each resume/target pairing gets a separate simulated result. Real jobs and real rubrics cannot be selected for demo scoring.
5. **Evidence:** Open a comparison to inspect 0-5 criterion scores, a weighted 0-100 overall score, an explanation, and exact resume citations. Citation buttons locate the quoted passage in the saved document snapshot.

Use the sample import and analysis **Demo scenario** controls to explore failures, partial results, cancellation, and retry. Real imports instead show durable server progress and actual processing errors. Successful jobs remain available when another input fails.

Custom criteria in sample rubrics have no fixture assessment. They are explicitly marked not assessed, and the overall score is withheld rather than invented. Other mock scores follow synthetic evidence profiles; editing criterion wording does not invoke a real assessment. Real source-derived criteria are reviewable without inventing resume assessments.

Sample GS examples are illustrative. Source-backed grade drafts also require human review and are not official OPM classification or eligibility determinations. Missing resume evidence does not prove a person lacks a skill. Do not use demo scores to make employment decisions.

## Real job ingestion

The authenticated API accepts raw PDF bytes or a direct public URL. One input must describe one job; listing/search pages and whole-site discovery are outside this release.

1. The API checks workspace membership, validates the input, and publishes an idempotent job record. Uploaded originals are stored immutably in the private `job-sources` Blob container before publication.
2. A Container Apps Job runs every minute, claiming pending Cosmos records with ETag leases and heartbeats. Processing continues after the browser closes; an import may wait about a minute before starting.
3. Azure Document Intelligence extracts PDF text and performs OCR on scanned pages. URLs use bounded HTML/JSON-LD extraction, with a separate private Chromium renderer when JavaScript is needed. Direct links that return PDFs use the same PDF pipeline.
4. Foundry generates a schema-constrained rubric from the extracted source. Criteria include required/preferred distinctions, 0-5 scoring guidance, weights totaling 100, and exact paragraph quotations. Metadata, weights, and citations are validated before publication; invalid output is repaired once or reported as an error, never replaced with a sample rubric.
5. Open the job to inspect its source beside the saved rubric. Citation links highlight the original passage, and the original file remains downloadable through the authorized API. Reviewer edits require the current job ETag and append an immutable rubric version.

| Limit | Current value |
| --- | --- |
| PDF size and page count | 10 MiB and 50 pages per PDF |
| PDF batch | Up to 10 files; each remains an individual job |
| Normalized source text | 180,000 characters |
| Direct URL length | 4,096 characters; public HTTP(S), standard ports only |
| Rubric | Up to 20 criteria; weights must total 100 |
| Transient processing failures | Up to three automatic attempts with backoff; explicit retry after failure |

Jobs expose queued, parsing, generating, ready, error, and cancelled states. Cancellation prevents late worker results from being published. Retrying reuses any preserved original and extracted source instead of silently changing the evidence. Encrypted/unreadable PDFs, unsupported pages, protected websites, and invalid generated output produce actionable errors. Public URLs do not carry the user's browser login, cookies, or credentials.

### Source isolation and model processing

Real jobs live in Cosmos `job-records`, partitioned by workspace. These records are also the durable work queue; there is no separate queue publication that can get out of sync. Originals and normalized source documents live in `job-sources`. They are not part of the legacy sample-state autosave and are not overwritten by sample reset or workspace snapshots.

The dedicated worker identity can access job records/sources, Document Intelligence, and Foundry inference, but not the legacy workspace-state Blob container or shared knowledge contents. Public HTTP requests use DNS-pinned connections, validate every redirect, and reject private, loopback, metadata, and other reserved addresses.

Chromium runs only in an internal-ingress Container App, separate from the credentialed worker. Its dedicated identity is for ACR image pulls only, with runtime identity access disabled. Startup verifies that the identity broker cannot issue a token, then removes broker variables before launching browser code. Browser requests use the same restricted public transport; fresh contexts have bounded time, request count, and response sizes, with no persistent profile, downloads, service workers, or WebSockets.

Job content is sent to Azure Document Intelligence for PDF extraction and to the configured Foundry model for rubric generation. The current deployment uses **GPT-5 mini (`2025-08-07`), deployment `job-rubric`, Data Zone Standard**. The Foundry resource is in North Central US, but model inference uses the **US data zone**, not a guarantee of North Central US-only processing. Generated rubrics need human review; exact citations establish traceability, not correctness of every interpretation.

## Source-grounded GS grade ladders

A ready real job can seed a new family of GS grade rubrics without changing the job or its original rubric. Confirm the occupational series and requested grades, review applicable OPM sources, optionally supply agency PDFs/public URLs, and generate independent grade drafts. The API captures the exact seed rubric and source so later job edits cannot change the ladder's evidence.

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

Provisioning creates the job/grade stores and private source containers, Document Intelligence resource, model deployment, and isolated worker/renderer identities. The postdeploy hook builds the renderer and shared worker image, waits for the renderer's latest revision, and configures separate job and grade schedules. The grade job uses a separate entry point and an independent initial image pin so an older worker image cannot accidentally activate it. The grade feature is enabled after its first deployed execution succeeds. Image pins are saved in the azd environment for subsequent provisioning.

When upgrading an existing deployment to add grade services, run `.\scripts\deploy.ps1 -ProvisionOnly` before `-DeployOnly`. To rebuild and publish only processing services after provisioning, run `.\scripts\deploy-worker.ps1`. Changing infrastructure files without reprovisioning does not create the required grade stores or identity permissions.

| Service | Configuration and purpose |
| --- | --- |
| App Service | One Linux B1 instance serving the React SPA and authenticated workspace API |
| Container Registry | Basic registry; managed-identity image pulls, no registry administrator password |
| Cosmos DB | Serverless workspace directory/membership and separate `job-records` / `grade-records` durable records and work queues |
| Blob Storage | Private `workspace-state`, `job-sources`, `grade-sources`, `documents`, and `knowledge` containers; shared-key access disabled |
| Microsoft Foundry | AI Services account/project, GPT-5 mini rubric deployment, and managed-identity Search/Blob connections |
| Document Intelligence | S0 resource for PDF layout/text extraction and OCR |
| Container Apps Jobs | Separate job and grade workers, each with a scoped identity and 1 CPU / 2 GiB; bounded work per execution |
| Internal Container App | Isolated Chromium renderer, 1 CPU / 2 GiB, scale-to-zero, no runtime data credentials |
| Foundry IQ / AI Search | Basic Search service, extractive knowledge source/base, and explicitly capped free knowledge-retrieval/semantic plans |
| Key Vault | Easy Auth application credential, accessed through the web app's managed identity |
| Azure Monitor | App Service diagnostics in Log Analytics; Application Insights provisioned for subsequent tracing integration |

All regional resources use North Central US, with the US data-zone inference distinction described above. App Service, ACR, and Search have ongoing infrastructure charges even when idle. Foundry inference is token-billed, Document Intelligence is page-billed, and Container Apps execution, storage, Cosmos, and diagnostics have usage-based costs. The rubric deployment reserves 100k tokens/minute of quota; this is throughput capacity, not a spending cap. The free IQ retrieval allowance is not a free Search hosting plan, and it does not cover rubric-model or OCR usage. Paid continuation after that retrieval allowance is not enabled.

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

Cosmos stores directory and membership documents together under the `/workspaceId` partition key. Legacy sample workspace state is stored in a private Blob rather than a single Cosmos item, avoiding Cosmos's per-item size limit. Sample saves require the current Blob ETag; metadata renames require the metadata ETag. Real job and grade mutations use their own versioned APIs and Cosmos ETags. Concurrent edits produce an explicit conflict instead of silently overwriting another session.

Initialization prepares state before atomically publishing directory metadata and membership. A failed or ambiguous publication does not delete another initializer's work. Retried default-workspace creation can reuse prepared state without replacing it with samples.

Cloud mode keeps document state in memory, not browser local storage. Only theme and the last-selected workspace ID are remembered locally, with the latter scoped to tenant and user. Writes are queued and acknowledged before showing a saved state. Switching or signing out flushes pending changes and pauses browser-only demo simulations. Save failures retain the newest edits; conflict recovery is explicit.

The data model reserves `group` workspaces and `owner`/`editor`/`viewer` memberships. Group creation, sharing administration, and Entra group resolution are deliberately not enabled yet. They must use these same server-side membership boundaries rather than client-side filters.

### Foundry IQ boundary

`score-knowledge` is an extractive knowledge base over `score-demo-guide`, using Search REST API `2026-04-01`. It contains only a nonsensitive application guide in the separate `knowledge` container. No LLM deployment is needed for this mode.

Search and Foundry project identities can read that knowledge container, not the private `workspace-state`, `job-sources`, `grade-sources`, or `documents` containers. Personal jobs, resumes, reference documents, and workspace snapshots are not indexed. Rubric generation sends selected source text directly to the model without adding it to shared IQ. Real per-workspace retrieval will require a deliberate document-isolation/filtering design before private content is connected.

Do not run `azd down` as routine cleanup: it deletes the deployment and its cloud workspace data. Key Vault also has soft-delete and purge protection.

## Standalone local mode and privacy

Standalone local job imports and all resume-import simulations read selected file **names**, not PDF contents. They use fictional replacement content and do not fetch submitted URLs or send those documents to an AI evaluator. Cloud sample state and its source labels are saved to the authenticated user's workspace; standalone local samples stay in the browser. **Cloud real-job and grade-reference imports do read, upload, extract, and store actual source content**, as described above.

In standalone local mode, demo records, source labels, rubric edits, and analysis snapshots are stored under `score-demo-workspace-v1` in browser local storage. Theme preference uses `score-theme`. Real selected document bytes are never read or stored.

Reset requires confirmation. In local mode it replaces only Score's local synthetic workspace; in cloud mode it replaces only the currently selected workspace's sample state. **Real jobs, grade ladders, their sources, and immutable versions are not deleted by Reset samples.** Theme preference and unrelated browser data are kept. Storage failures and corrupt data are surfaced explicitly rather than silently replaced.

Reloading during a simulation presents unfinished work as interrupted/cancelled so it can be retried. Cloud reads do not write this presentation change back automatically, since another browser might still be working. Historical results retain their original rubric and document snapshots even after later edits.

## Code organization

| Directory | Responsibility |
| --- | --- |
| `src\app` | Navigation, themes, sample workspace state, and separate server-owned job/grade state |
| `src\components` | Accessible UI primitives and source document/citation viewing |
| `src\domain` | Typed documents, jobs, rubrics, resumes, and analysis snapshots |
| `src\data` | Coherent fictional fixtures |
| `src\services` | Job/grade/cloud API clients, deterministic sample operations, and validated local persistence |
| `src\features` | Jobs, resumes, rubrics, grade-ladder review, and analysis screens |
| `src\styles` | Token-based visual system and responsive layouts |
| `server` | Authenticated workspace/job/grade APIs, authorization, Cosmos adapters, and private Blob storage |
| `worker` | Durable job/grade processing, safe public transport, OPM discovery, reference extraction, and grounded generation |
| `renderer` | Isolated internal Chromium service and fail-closed runtime identity boundary |
| `server-tests`, `worker-tests`, `renderer-tests` | Node test-runner coverage of API access, concurrency, source extraction, model validation, and rendering isolation |
| `infra` | Bicep resource definitions |
| `scripts` | Container build, deployment, identity, and knowledge-base configuration |

Real resume ingestion/scoring, whole-site discovery and multi-page crawling, group-workspace administration, and ATS integrations remain deferred. Direct job-URL rendering is not a general-purpose crawler. The current service boundaries keep those future integrations separate from sample simulations.

When hosting the built `dist` directory, configure SPA fallback to `index.html` so direct links to job, rubric, and analysis routes work.
