export const networkModules = [
  'node:http',
  'node:https',
  'http',
  'https',
  'node:net',
  'net',
  'node:tls',
  'tls',
  'node:dgram',
  'dgram',
  'node:http2',
  'http2',
  'undici',
  'axios',
  'got',
  'node-fetch',
  'ws',
  'request',
  'superagent',
  'cross-fetch',
  'isomorphic-fetch',
  'ky',
  'needle',
  'phin',
]

export const playwrightModules = [
  'playwright',
  'playwright-core',
  '@playwright/test',
]

export const sanctionedTransports = [
  {
    file: 'worker/evals/decision-transport.ts',
    rules: ['outbound/global-fetch'],
    reason: 'Offline-only verified Microsoft Decision choice adapter posts to the single scoped Score Foundry account with Entra cognitive-services tokens, redirect:error, byte bounds and per-attempt deadlines. Read-only ARM discovery uses a fixed account/deployment path and separate management scope; never imported by production workers.',
  },
  {
    file: 'worker/runtime.ts',
    rules: ['outbound/network-module', 'outbound/playwright-import', 'outbound/playwright-navigation', 'outbound/global-fetch'],
    reason: 'Worker public-source transport uses validatePublicUrl, urlMatchesPolicy, DNS pinning, public-address checks and bounded redirects before node:http/node:https or Playwright page navigation; model calls go through fixed Azure endpoints.',
  },
  {
    file: 'worker/index.ts',
    rules: ['outbound/playwright-import'],
    reason: 'Worker startup imports Playwright only to inject Chromium into createPlaywrightRenderer; worker/runtime.ts owns the URL validation and route interception.',
  },
  {
    file: 'worker/model-transport.ts',
    rules: ['outbound/global-fetch'],
    reason: 'Shared structured model transport posts only to the configured Azure OpenAI deployment endpoint with redirect:error and Microsoft Entra token scope.',
  },
  {
    file: 'worker/analyses/model.ts',
    rules: ['outbound/global-fetch'],
    reason: 'Analysis model adapter wraps the configured model fetch with envelope validation and delegates transport to worker/model-transport.ts.',
  },
  {
    file: 'worker/resumes/model.ts',
    rules: ['outbound/global-fetch'],
    reason: 'Resume model adapter wraps the configured model fetch with envelope validation and delegates transport to worker/model-transport.ts.',
  },
  {
    file: 'server/assist/model.ts',
    rules: ['outbound/global-fetch'],
    reason: 'Assistant model adapter passes the fixed deployment endpoint to worker/model-transport.ts rather than accepting arbitrary URLs.',
  },
  {
    file: 'server/access/entra-directory.ts',
    rules: ['outbound/global-fetch'],
    reason: 'Graph adapter is fixed to https://graph.microsoft.com, validates continuation URLs stay under /v1.0, uses redirect:error and bounded deadlines.',
  },
  {
    file: 'server/settings/models.ts',
    rules: ['outbound/global-fetch'],
    reason: 'Admin model validation calls fixed Azure Management and configured Azure OpenAI deployment endpoints, validates continuations, and uses redirect:error.',
  },
  {
    file: 'renderer/browser.ts',
    rules: ['outbound/playwright-import', 'outbound/playwright-navigation'],
    reason: 'Renderer launches an isolated browser, validates initial and redirected HTTP(S) URLs with renderer/request-policy.ts, and fulfills browser traffic through an injected public fetcher.',
  },
]

export const ssrfPolicyFiles = [
  {
    file: 'worker/runtime.ts',
    tests: ['worker-tests/fetch-safety.test.mjs'],
    reason: 'Defines validatePublicUrl, safeFetch, DNS pinning, public-address rejection and local Playwright request routing for public job URLs.',
  },
  {
    file: 'worker/public-http.ts',
    tests: ['worker-tests/fetch-safety.test.mjs'],
    reason: 'Public fetch wrapper exposed to renderer and OPM/reference importers; changes can alter the safeFetch boundary.',
  },
  {
    file: 'worker/references/transport.ts',
    tests: ['worker-tests/fetch-safety.test.mjs'],
    reason: 'Grade reference importer validates public URLs, applies captured URL policy and manually follows bounded safeFetch redirects.',
  },
  {
    file: 'renderer/request-policy.ts',
    tests: ['renderer-tests/browser.test.mjs', 'renderer-tests/app.test.mjs'],
    reason: 'Renderer URL policy schema and host allow/block matching decide which browser URLs are permitted before public fetch transport.',
  },
  {
    file: 'renderer/browser.ts',
    tests: ['renderer-tests/browser.test.mjs'],
    reason: 'Renderer browser routing enforces policy, redirect, request-count and aggregate-byte limits while routing through the public fetcher.',
  },
]

export const knownModelTransportFiles = [
  {
    file: 'worker/model-transport.ts',
    reason: 'Canonical structured Azure OpenAI transport with fixed deployment endpoint, redirect:error and retry/deadline policy.',
  },
  {
    file: 'worker/analyses/model.ts',
    reason: 'Analysis-specific guard around the canonical structured model transport.',
  },
  {
    file: 'worker/resumes/model.ts',
    reason: 'Resume-specific guard around the canonical structured model transport.',
  },
  {
    file: 'server/assist/model.ts',
    reason: 'Server assistant adapter delegates to the canonical structured model transport.',
  },
  {
    file: 'server/settings/models.ts',
    reason: 'Admin-only Azure deployment inventory and explicit paid synthetic model probes against configured deployment endpoints.',
  },
  {
    file: 'worker/runtime.ts',
    reason: 'Legacy worker surface re-exports and invokes the canonical structured model transport with configured Azure endpoints.',
  },
  {
    file: 'worker/grade-index.ts',
    reason: 'Grade worker composition injects configured Azure model dependencies into the canonical structured model transport.',
  },
  {
    file: 'worker/qc/model.ts',
    reason: 'QC model adapter invokes the canonical structured model transport through injected dependencies for configured Azure endpoints.',
  },
]
