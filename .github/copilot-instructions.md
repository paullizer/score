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
