# Security scanning

Score checks every pull request to `main` with GitHub's own security features and with four small checkers that live in this repository. The approach is adapted from [SimpleChat](https://aka.ms/simplechat), which runs CodeQL, Dependabot and homegrown diff checks for supply-chain, XSS and access-control problems. SimpleChat's checkers are written for Python, Flask and Jinja, so Score's are rebuilt for Express 5, React 18, the Node workers and the Playwright renderer, and add a fourth check for outbound requests.

None of these checks is a required status check, and there are no branch rulesets. A failing check means: fix it, or explain in the pull request why it's safe, before merging.

## What runs, and when

| Check | Workflow | Runs on | Fails when |
| --- | --- | --- | --- |
| CI | `ci.yml` | Pull requests to `main`, pushes to `main`, manual | Lint, the build (`tsc -b`, Vite and the server bundle), a test suite (`test:server`, `test:worker`, `test:renderer`, `test:reports`, `test:security`) or `verify-admission` fails |
| CodeQL | `codeql.yml` | Pull requests, pushes to `main`, weekly, manual | The analysis fails to run, or the separate **Code scanning results** check finds a new high or critical security alert. Alerts appear on the pull request and in the **Security** tab |
| Dependency review | `dependency-review.yml` | Pull requests | A dependency change adds a package version with a high or critical advisory |
| Malicious PR security review | `malicious-pr-security-review.yml` | Pull requests, manual | The review finds a Blocker |
| Security guardrails | `security-guardrails.yml` | Pull requests, manual | The XSS, access-control or outbound-request checker finds a Blocker |

CodeQL scans the `actions` and `javascript-typescript` languages with the `security-extended` query suite. SimpleChat uses `security-and-quality`; Score leaves quality to TypeScript and ESLint so that security alerts aren't buried. The repository's CodeQL *default setup* stays off, because this workflow owns code scanning.

Every workflow pins its actions to a full commit SHA, gives its token only the permissions it needs (read-only everywhere except CodeQL's `security-events: write`), checks out without persisting credentials, passes pull-request values to scripts through environment variables, and runs on `pull_request`, never `pull_request_target`. Dependency-installing workflows run the external-artifact and complete npm admission checks before `npm ci --ignore-scripts`. The installation policy uses exact versions and a minimum release age of 14 complete days, including security updates.

## Installation admission and local executables

Run `node scripts/verify-installations.mjs` before npm installation. This dependency-free check validates the manifest against the lockfile, rejects mutable versions or missing integrity, and checks authoritative npm publication times for **every** installed package, including unchanged, optional-platform, and transitive entries. There is no bypass flag. `.npmrc` saves exact versions and disables installation scripts. CI and every Docker npm-install layer use this check.

Run `node scripts/verify-artifacts.mjs` before building or deploying; deployment additionally uses `--deployment-tools`. `scripts/security/policy/installations.json` records exact image digests, action release tags/commits, runtime versions, and deployment-tool versions. The checker verifies upstream publication metadata and action tag-to-commit mappings. Image metadata URLs are restricted to Docker Hub's official Node tag endpoint and Microsoft's Playwright catalog endpoint; policy files cannot select arbitrary metadata destinations. Unapproved Docker bases, extra OS/browser installation commands, mutable CI Node versions, and unapproved actions block admission. OS/browser dependencies are supplied by the immutable renderer image rather than live apt or browser downloads.

First-time provisioning also uses the admitted immutable Node base, never floating placeholder images. It does not serve Score until the application images pass the existing deployment and readiness gates.

Deployment uses only the pinned Azure CLI's built-in commands. Hooks and deployment scripts disable dynamic extension installation and isolate extension discovery to `.azure/no-extensions`; admission rejects extensions in that directory. Shared global extensions are neither loaded nor modified.

Publication evidence must identify the exact artifact. An image's build time, a handwritten date, or the release date of software contained in a subsequently rebuilt image does not establish that image's publication age. If a registry returns no digest-bound publication evidence, deployment stays blocked until authoritative evidence is available. The gate does not change Azure resources or shared host tools.

For authenticated GitHub metadata reads, the checker accepts `GITHUB_TOKEN` (or `GH_TOKEN`) only as an authorization header to `api.github.com`, with redirects refused. CI supplies its existing read-only workflow token. Operators may supply a token only in their current process; never save it in azd, the repository, or application settings.

Score application executable code must come from the repository or exact-locked installed packages. Standalone third-party scripts or equivalent executable assets must be vendored with provenance, checksums, release evidence, and licenses, then loaded locally. Remote module imports, runtime script creation, nonliteral browser imports, and remote worker/code loading are blocked. Existing sandboxed document previews remain unchanged. Third-party pages deliberately visited inside the isolated job renderer may still execute their own scripts under the existing SSRF and sandbox policy; this exception does not allow Score itself to load remote application code.

### Brotli incident

[Node.js 24.22.1](https://nodejs.org/en/blog/release/v24.22.1) fixes [CVE-2026-111497](https://msrc.microsoft.com/update-guide/vulnerability/CVE-2026-111497). All Node build/runtime stages are digest-pinned to that security release. The renderer replaces the browser image's Node binary with the approved patched binary. Compressed JSON/PDF support is preserved rather than treating an HTTP header or parser restriction as a substitute for patching. Deployment verification must cover the web/API, renderer, all five workers, old executions/revisions, and other native Brotli copies in final images.

## Verdicts

Each checker finding has one of three verdicts:

- **Blocker**: fails the check. Fix it, or for the guardrail checkers, suppress it with a reason (see below).
- **Review**: a warning annotation and a line in the report. Someone should look at it, but it doesn't fail the check unless the checker runs with `--fail-on-findings`.
- **Note**: report only.

Findings appear three ways: as annotations on the pull request's **Files changed** tab, in the job's step summary, and as a Markdown report in the workflow run's artifacts (kept for 14 days). GitHub shows at most 10 error and 10 warning annotations per step, so read the step summary or the artifact for the full list.

## The checkers

The checkers are dependency-free Node scripts in `scripts/security/`. The guardrail checkers use the repository's own TypeScript compiler to read the code. Rules and allowlists live in `scripts/security/policy/`, one file per checker, and every allowlist entry records why it's there.

By default a checker looks only at what a pull request changes: the diff from the merge base with `main`, which is what GitHub shows on **Files changed**. For the three guardrail checkers:

- Blocker rules check the **whole file** of every file the pull request touches, so a touched file can't keep an unsafe pattern that sits on an unchanged line.
- Review rules report only on **added lines**.
- `--full-scan` checks every file and treats every line as added.

### Malicious PR security review

`scripts/security/malicious-pr-review.mjs` looks for supply-chain attacks and for changes that deserve a closer look before merging. It reviews every changed file.

The workflow runs the copy of the reviewer from the **base branch**, not the one in the pull request, so a pull request can't weaken the review of itself. Changes to the reviewer take effect after they merge. When the base branch doesn't have the reviewer yet, the workflow uses the pull request's copy and says so in a notice.

The reviewer doesn't accept `security-reviewed:` suppressions, and it flags every new suppression that a pull request adds anywhere.

Rule ids start with `review/`.

| Area | Blocks | Flags for review |
| --- | --- | --- |
| npm lockfiles (`package-lock.json` and `npm-shrinkwrap.json`, in any folder) | An unparseable lockfile or one without a `packages` map (`lockfile-json`). A new or changed `npm-shrinkwrap.json`, which npm prefers over `package-lock.json` (`npm-shrinkwrap`). A package resolved outside the allowlisted npm registries (`lockfile-registry`). An installed package without a resolved URL or integrity hash (`lockfile-integrity-missing`). Changed integrity without a changed version (`lockfile-integrity-changed`). Releases younger than 14 days (`release-age-fresh`) or with unverifiable age (`release-age-unverified`). | A newly added package with an install script (`lockfile-install-script`). |
| `package.json` | Invalid JSON (`package-json`). Added or changed install-time lifecycle scripts (`package-lifecycle-script`). Dependency and override specifiers that are not exact registry versions (`package-dependency-specifier`). | New direct dependencies (`package-new-dependency`), other changed scripts (`package-script-changed`), overrides (`package-overrides-changed`) and bins (`package-bin-changed`). |
| Registry configuration | An `.npmrc` or Yarn registry outside the allowlist (`registry-config-host`). `strict-ssl=false` (`registry-strict-ssl`). | Other registry configuration changes (`registry-config-changed`). |
| Secrets | Private keys (`private-key`). GitHub, AWS, Slack, Google, Stripe, npm and Azure Storage credentials (`secret-*`). | |
| Code and content | Known exfiltration, paste, tunnelling, webhook and chat-bot callback hosts (`exfiltration-host`). URLs with a public IP address (`public-ip-url`). Cloud metadata endpoints outside the SSRF policy files (`metadata-endpoint`). Dumping the environment or secrets (`environment-dump`). Decoding data and running it, piping a download to a shell, or PowerShell encoded commands (`decode-and-execute`). These five are Reviews in tests and docs. | `child_process`, `vm` or `worker_threads` imports (`risky-node-import`). `data:` or computed dynamic imports (`dynamic-import`). Large base64 or hex blobs (`large-encoded-blob`). New `eslint-disable`, `@ts-ignore` or `@ts-nocheck` comments (`lint-disable`). New focused or skipped tests (`test-skip-only`). A deleted test file (`deleted-test`) or fewer test cases (`test-count-reduced`). A new `security-reviewed:` suppression (`new-suppression`). |
| Hidden Unicode | Bidirectional control characters and Unicode tag characters (`hidden-unicode-bidi`). | Zero-width characters (`hidden-unicode-zero-width`). |
| Hidden changes | A change to any `.gitattributes`, which can mark files as binary and hide their diffs (`gitattributes-changed`). A NUL byte in a text file (`nul-byte`). Control or invisible characters in a file path (`unsafe-path-characters`). | |
| Binary files | Executables and native libraries, by content or extension (`binary-executable`). | Other new or changed binary files (`binary-file`). Binaries in the allowed asset folders are a Note (`binary-asset`). |
| Dockerfiles | Downloads piped to a shell (`docker-pipe-shell`), mutable/latest base images (`docker-floating-from`), and external bases without complete digests (`docker-from-no-digest`). Named earlier build stages are allowed. | `ADD` from a URL (`docker-add-url`), root users (`docker-root-user`), and removed users (`docker-user-removed`). |
| GitHub workflows | `pull_request_target`, in any form of `on:` (`workflow-pull-request-target`). `${{ github.event.* }}`, `github.head_ref` or `toJSON(github)` in a `run:` step or a `github-script` `script:`, including folded, quoted, escaped and multi-line values (`workflow-untrusted-run-context`). Printing secrets (`workflow-echo-secrets`). `ACTIONS_ALLOW_UNSECURE_COMMANDS` (`workflow-unsafe-commands`). An action at a branch, `latest` or no ref (`workflow-uses-floating`). | A third-party action that isn't pinned to a full commit SHA (`workflow-uses-not-sha`). Write permissions (`workflow-write-permission`). Self-hosted runners (`workflow-self-hosted`). Checkout without `persist-credentials: false` (`workflow-checkout-credentials`). A new secret reference (`workflow-secret-reference`). A `workflow_run` trigger (`workflow-run-trigger`). |
| Security controls | | Changes to the authentication, CSRF, SSRF and sanitizer files (`security-control-file`) or to security-related code (`security-control-pattern`). Changes to the security checks, workflows, Dependabot, ESLint or TypeScript configuration (`guardrail-tooling-changed`). |
| AI agents | | Changes to Copilot instructions, prompt files, agents, chat modes, `AGENTS.md`, `CLAUDE.md` or MCP configuration (`agent-surface-changed`). Prompt-injection phrases (`prompt-injection-phrase`). |
| Azure infrastructure | | Anonymous Easy Auth paths (`infra-anonymous-auth`). Public or insecure ingress (`infra-public-ingress`). Public network or blob access (`infra-public-network`). TLS below 1.2 or `httpsOnly: false` (`infra-weak-tls`). Local or shared-key authentication (`infra-local-auth`). New role assignments (`infra-role-assignment`) and privileged roles such as Owner (`infra-privileged-role`). Microsoft Graph permissions (`infra-graph-permission`). Deleting a resource group (`infra-resource-group-delete`). |

#### Release age and Dependabot

The reviewer blocks any checked package version published less than 14 complete days ago, including entries that don't record a resolved URL. It verifies changed entries in diff mode and every entry during a full scan. It looks up publish times on the public npm registry, using the already-approved public 1ES npm mirror with an explicit diagnostic if the canonical metadata transport fails. Missing, invalid, oversized, or unavailable publication metadata is always a Blocker. The exact fourteen-day boundary is admitted. `--release-age-days` can increase the minimum but cannot reduce it below fourteen.

Dependabot uses the same 14-day `cooldown` for version updates. Security updates can ignore Dependabot's cooldown, but they cannot bypass Score's admission gate. Select an eligible patched release or report the blocker when none exists; there is no automatic security-update exception.

Dependabot can't open a security update when the fix is only in a major version that the parent package doesn't accept. Use a scoped `overrides` entry in `package.json` for those, after checking that the parent still works with the fixed version, and remove it once the parent accepts that version. `pptxgenjs` 4.0.1 still asks for `image-size` 1.x, which has no fix for GHSA-w3rx-r6r6-pgpr or GHSA-5p2g-fcmc-qvqq. pptxgenjs never loads `image-size`, so Score overrides it to 2.x.

`package-lock.json` resolves every package through a public Microsoft mirror of the npm registry (`ms-feed-25.pkgs.visualstudio.com/1es-public`). The reviewer allows that mirror and `registry.npmjs.org`, and blocks anything else.

### XSS sinks

`scripts/security/check-xss-sinks.mjs` checks the browser app (`src/**/*.ts`, `src/**/*.tsx` and `index.html`).

| Rule | Verdict | Finds |
| --- | --- | --- |
| `xss/dangerously-set-inner-html` | Blocker | `dangerouslySetInnerHTML`, in JSX or in a props object |
| `xss/inner-html-assignment` | Blocker | Setting or appending to `innerHTML` or `outerHTML` |
| `xss/html-insertion` | Blocker | `insertAdjacentHTML`, `document.write`, `createContextualFragment`, `setHTMLUnsafe`, `parseHTMLUnsafe`, and `DOMParser` output inserted into the page |
| `xss/string-code-execution` | Blocker | `eval`, `Function`, and `setTimeout` or `setInterval` called with a string |
| `xss/srcdoc` | Blocker | `srcDoc` anywhere except the Word preview, and any `srcdoc` attribute in `index.html` |
| `xss/iframe-sandbox` | Blocker | An iframe without `sandbox`, or with both `allow-scripts` and `allow-same-origin`. `allow-scripts` alone, or a sandbox value the checker can't resolve, is a Review |
| `xss/csp-unsafe-script` | Blocker | `'unsafe-inline'` or `'unsafe-eval'` in a `script-src` or `default-src` directive |
| `xss/markup-renderer-import` | Blocker | A Markdown renderer, HTML parser, sanitizer or Word-to-HTML converter imported into the browser app, other than the Word preview's DOMPurify and mammoth. `import`, `export … from`, `import = require`, `require()` and `import()` all count |
| `xss/post-message-wildcard` | Blocker | `postMessage` to `'*'` |
| `xss/runtime-script` | Blocker | A `<script>` element created at runtime |
| `xss/javascript-url` | Blocker | A `javascript:` URL. In `index.html`, the scheme anywhere in an attribute value counts, after character references are decoded |
| `xss/index-inline-script` | Blocker | An inline script in `index.html` whose SHA-256 isn't pinned in the policy. The finding gives the hash to record after review. Only `application/json` and `application/ld+json` data blocks are exempt: import maps and speculation rules change what loads, so they need a pin too. Script text containing markup such as `<!--` or `<tag` can't be pinned, because browsers can read it past the first `</script>` |
| `xss/index-inline-handler` | Blocker | An inline `on…=` event handler in `index.html` |
| `xss/index-remote-script` | Blocker | A script in `index.html` whose `src`, `href` or `xlink:href` isn't a same-origin path such as `/src/main.tsx`. Absolute, protocol-relative, backslash and `data:` URLs all count, including ones spelled with character references |
| `xss/index-base-element` | Blocker | A `<base>` element in `index.html`, which would change where relative script and asset URLs load from |
| `xss/nonliteral-url` | Review | A computed `href`, `src`, `action` or `formAction`, unless a same-origin URL helper in the policy builds it |
| `xss/dynamic-module-load` | Blocker | `import()` or `require()` with a computed browser module name, which the checker can't resolve |
| `xss/remote-executable` | Blocker | Remote/data/blob module URLs, nonbundled workers, runtime service-worker/script imports, and streaming WASM downloads |
| `xss/navigation-nonliteral` | Review | Navigating to a computed URL with `location` or `window.open` |
| `xss/browser-storage-write` | Review | A write to `localStorage` or `sessionStorage` |
| `xss/message-listener` | Review | A new `message` event listener |
| `xss/sanitizer-sensitive-change` | Review | Any change to `src/components/documents/docxPreviewSanitize.ts` |

### Access control

`scripts/security/check-access-control.mjs` checks the API (`server/**/*.ts`). It finds every Express route and makes sure a recognized guard protects it, and it checks that `server/app.ts` still wires authentication and CSRF protection before the feature routers.

| Rule | Verdict | Finds |
| --- | --- | --- |
| `access/unguarded-route` | Blocker | A route without a recognized guard, such as `authorize`, `withWorkspaceMutation`, `requireApplicationAdmin`, `requireOwner`, `isApplicationAdmin` or `getPrincipal`. Routes that need only an authenticated caller, such as `GET /api/session`, are listed in the policy with a reason |
| `access/direct-app-route` | Blocker | A route registered on `app` instead of the `api` router, other than `/healthz` and the SPA fallback |
| `access/app-wiring-order` | Blocker | `server/app.ts` no longer applies, in this order: no-store, authentication, CSRF and the settings context; the feature routers; the `/api` 404 handler; then authentication for the SPA |
| `access/principal-header-read` | Blocker | Reading `x-ms-client-principal` or the development principal header outside `server/auth.ts` and `server/middleware.ts` |
| `access/permissive-cors` | Blocker | The `cors` package, or a wildcard, reflected or credentialed `Access-Control-Allow-Origin` |
| `access/dev-header-production-guard` | Blocker | Removing or weakening the check that turns the development principal header off in production and on App Service |
| `access/query-interpolation` | Review | Cosmos DB query text built by interpolation or concatenation |
| `access/healthz-change` | Review | A change to the anonymous `/healthz` handler |
| `access/guard-helper-change` | Review | A change to a guard helper, such as `getPrincipal`, `isApplicationAdmin`, `authorize` or `requireOwner` |
| `access/get-principal-only` | Note | A new route whose only visible guard is `getPrincipal`, so the service it calls must check membership |

`server-tests/route-auth-inventory.test.mjs` backs this up at runtime. It starts the API and calls every `/api` route without an identity, expecting 401. It then calls every mutating route as an administrator with a foreign `Origin` or without `X-Score-Request`, expecting the CSRF error rather than a handler response. A control request with valid CSRF headers must reach the handler.

### Outbound requests

`scripts/security/check-outbound-requests.mjs` checks the API, workers and renderer (`server/`, `worker/` and `renderer/`). Score fetches job URLs that users supply, so every outbound request must go through a transport that validates the destination.

| Rule | Verdict | Finds |
| --- | --- | --- |
| `outbound/global-fetch` | Blocker | The global `fetch` called outside a sanctioned transport. A `fetch` that is passed in as a parameter is fine |
| `outbound/network-module` | Blocker | `node:http`, `node:https`, `net`, `tls`, `dgram`, `http2`, `undici`, axios, got, node-fetch, `ws` or a similar client loaded outside a sanctioned transport. `import`, `export … from`, `import = require`, `require()` and `import()` all count |
| `outbound/playwright-import` | Blocker | Playwright imported outside the renderer and worker browser code |
| `outbound/playwright-navigation` | Blocker | `page.goto`, Playwright request APIs, `route.fetch`, or `route.continue` with a new URL, outside the sanctioned browser code |
| `outbound/tls-verification-disabled` | Blocker | `rejectUnauthorized: false`, a custom `checkServerIdentity`, `ignoreHTTPSErrors` or `--ignore-certificate-errors` |
| `outbound/node-tls-disabled` | Blocker | Setting `NODE_TLS_REJECT_UNAUTHORIZED` |
| `outbound/redirect-follow` | Review | Following redirects automatically, or setting a redirect limit |
| `outbound/dynamic-module-load` | Review | `import()` or `require()` with a computed module name, or an import of `node:module`, whose `createRequire` loads modules the checker can't see |
| `outbound/ssrf-policy-change` | Review | Any change to the URL policy files: `worker/runtime.ts`, `worker/public-http.ts`, `worker/references/transport.ts`, `renderer/request-policy.ts` and `renderer/browser.ts` |
| `outbound/model-transport-change` | Review | Model endpoint calls outside the known model transport files |

The policy lists each sanctioned transport, the rules it's allowed to break and why. Most are fixed Azure endpoints (Azure OpenAI, Microsoft Graph and Azure Resource Manager) that refuse redirects.

## Suppressing a finding

When a guardrail finding has been reviewed and is safe, add a comment on the flagged line or up to two lines above it:

```ts
// security-reviewed: xss/inner-html -- content comes from DOMPurify with the preview profile
```

The comment must name the rule id shown in the report, then `--`, then a reason of at least 10 characters. A suppression without a reason is ignored, and the report says so. The malicious PR review lists every new suppression for review, so they stay visible.

Use a policy allowlist in `scripts/security/policy/` instead when a pattern is intentional and permanent, such as the sanitized Word preview. Each entry needs a reason.

## Running the checks locally

```powershell
npm run security:check                      # all four checks, changes since origin/main, including uncommitted files
npm run security:check -- --full-scan       # every file
npm run security:check -- --base main --head HEAD --fail-on-findings
npm run test:security                       # the checkers' own tests
```

`security:check` looks up package release ages on the public npm registry when the lockfile changes; add `--no-release-age` to stay offline. You can run a single checker directly, for example `node scripts/security/check-xss-sinks.mjs --help`.

Exit codes: `0` passed, `1` findings failed the check, `2` the check couldn't run.

## Repository settings

These GitHub settings are on for the repository:

- **Dependabot alerts** and **Dependabot security updates**.
- **Secret scanning** and **push protection**, which blocks pushes that contain recognized secrets.
- **Private vulnerability reporting**, used by [SECURITY.md](../SECURITY.md).

`.github/dependabot.yml` also opens weekly version updates for GitHub Actions and npm. npm minor and patch updates are grouped into one pull request, major versions are left for manual upgrades, and both ecosystems wait 14 days after a release. Image updates are reviewed manually together with the digest and publication evidence in the installation policy.

## Limits

- The checkers are heuristics. They catch common mistakes and obvious attacks. CodeQL, the test suites and human review remain the main defences.
- The checkers read the pull request so that it can't hide changes from them. They diff with `--text` whatever `.gitattributes` says, treat file names literally, read file contents by object ID, and show control characters in the report as visible escapes. In GitHub Actions they pause workflow commands while printing findings, so text in a finding can't forge an annotation or change the job.
- The workflow rules read YAML line by line. They follow block, folded, quoted, escaped and multi-line values, but not anchors, aliases, tags or complex keys. CodeQL's `actions` analysis parses workflows fully and backs them up.
- The access-control checker proves that a route passes through a guard. It trusts, but doesn't prove, the workspace membership checks that services make after `getPrincipal`.
- The checks aren't a security boundary against a pull request that edits a workflow or a checker. The reviewer runs from the base branch and flags those edits, but changes to `.github/` and `scripts/security/` still need a careful human review.
- GitHub asks a maintainer to approve workflow runs for first-time contributors. Keep that setting.

## Follow-ups

Not done yet:

- Infrastructure and container scanning, such as Microsoft Security DevOps, Checkov, Trivy or PSRule for the Bicep templates and the three Dockerfiles.
- Base images pinned by digest, plus the Dependabot `docker` ecosystem.
- Browser integration tests with Playwright's Chromium in CI.
- OpenSSF Scorecard, and `npm audit signatures` once it's verified against the mirror-resolved lockfile.
- A ruleset that requires these checks, plus the Actions settings that require SHA-pinned actions and restrict which actions can run.
- A site-wide Content Security Policy and security headers for the browser app.
