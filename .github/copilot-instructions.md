# Copilot instructions for Score

## Feature switches belong in Admin settings, not environment variables

Application administrators turn product features on and off under **Admin settings**. These switches live in `features.*` of the versioned application settings (`src/domain/admin-settings*.ts`). Don't add environment variables, Bicep app settings or build-time flags to turn a product feature on or off.

Use environment variables only for deployment facts:
- endpoints, resource and container names, and identities;
- limits imposed by the infrastructure;
- rollout gates that record a verified reader or worker deployment, such as `REAL_JOB_IMPORTS_ENABLED`, `WORD_DOCUMENT_IMPORTS_ENABLED` and `SCORE_RUNTIME_SETTINGS_ENABLED`.

A rollout gate says the infrastructure exists and is safe to use. The Admin switch decides whether people can use the feature.

A feature is available only when all three of these agree:

1. The deployment can offer it (`server/config.ts` and `SettingsDeploymentCapabilities`).
2. Its Admin switch is on.
3. New work is being admitted (runtime readiness and **Pause new work**).

Combine the three checks in `effectiveFeatures` (`server/settings/features.ts`). Enforce the same check in the route that does the work, because the browser is not a security boundary. The browser should follow `/api/features` rather than recompute policy.

New switches default to **on** unless there is a stated reason to ship them off, such as cost, privacy or an unverified rollout.

### Adding a switch safely

The API and every worker validate saved settings revisions and captured `ProcessingSettingsSnapshot`s with strict schemas, and captured snapshots must keep their exact shape. So:

- **Schema:** Add the key as optional (`z.boolean().optional()`) in `src/domain/admin-settings-schema.ts` and in the `AdminSettings` type. Never use zod `.default()` in a persisted schema.
- **Defaults:** Don't add the key to `createDefaultAdminSettings()`. That object is also the legacy baseline, so changing it changes earlier captures.
- **Reading it:** Use a helper in `src/domain/feature-switches.ts` that treats an absent key as the documented default; `rubricAssistantEnabled` is the example. Don't pass optional keys to `admissionReason(settings, kind)` in `src/services/publicSettings.ts`, because it treats a missing key as off.
- **Admin page:** Add metadata in `src/domain/admin-settings-fields.ts` with an explicit `defaultValue`, a plain description of what turning it off does, and its prerequisites. The Admin page shows the effective default for keys that older revisions omit, and only writes the key when an administrator changes it.
- **Deployment:** Deploy the API and all workers together with `scripts/deploy.ps1`. Older builds can't read a revision that contains a new key, so don't roll workers back after an administrator saves it. Making a key required needs the reader-first `RUNTIME_SETTINGS_VERSION` rollout.
- **Tests and docs:** Test four things:
  - An absent key behaves as the default.
  - Turning the switch off disables the feature in both `/api/features` and the route.
  - The Admin page shows the effective value.
  - Earlier revisions and captures keep their shape.

  Update `README.md` and `docs/` in the same change.

Human QC reviews and evidence corrections currently have only deployment gates. Give them Admin switches when they are next changed.

## Security guardrails

Pull requests to `main` run CodeQL, dependency review, a malicious-change review and three guardrail checks: XSS, access control and outbound requests. [docs/security-scanning.md](../docs/security-scanning.md) lists every rule. Run `npm run security:check` before you open a pull request, and fix what it reports rather than suppressing it.

- **Browser:** Render untrusted text as React text. The only HTML that Score renders is the Word document preview: `sanitizeDocxPreview` cleans it with DOMPurify and `DocxPreview` shows it in an `<iframe sandbox="">`. Keep both. Don't add `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` or string timers. Check that a URL from data or user input uses `http:` or `https:` before you bind it to `href` or `src`.
- **API:** Mount every route on the `api` router in `server/app.ts`, after the authentication and CSRF middleware. `/healthz` is the only route on `app` itself. Authorize inside the handler too: resolve the caller with `getPrincipal(req)` and let the repository or service check workspace membership or `isApplicationAdmin`. Never trust a workspace id, role or user id from the request body.
- **Outbound requests:** Fetch URLs that users supply only through `safeFetch` (`worker/runtime.ts`). It allows only public `http:` and `https:` addresses on standard ports, connects to the address it checked and rechecks every redirect. Don't call `fetch`, `http.request`, axios or a WebSocket with a user-controlled URL, and don't turn off TLS verification.
- **Supply chain:** Add a dependency only when it's needed, pin it through `package-lock.json`, and wait 7 days after a release before adopting it. Pin GitHub Actions to a full commit SHA, keep `permissions` minimal and never use `pull_request_target`. Don't add install scripts, encoded payloads or hidden Unicode.
- **Suppressions:** When a finding is a reviewed false positive, add `// security-reviewed: <rule-id> -- <reason>` on the flagged line or up to two lines above it. Every new suppression is flagged for review.

Changes to `.github/`, `scripts/security/`, `package.json` or `package-lock.json` are flagged for a closer look, so explain them in the pull request.
