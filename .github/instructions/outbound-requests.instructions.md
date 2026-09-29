---
applyTo: "server/**,worker/**,renderer/**"
---

# Outbound requests

Score fetches job postings, grade references and other URLs that users supply. A request to a user-supplied URL that doesn't check its destination can reach the Azure instance metadata service, internal services or the storage account (server-side request forgery).

- Fetch user-supplied URLs only with `safeFetch` (`worker/runtime.ts`) or the public fetchers built on it (`worker/public-http.ts` and `worker/references/transport.ts`). `safeFetch` allows only `http:` and `https:` on standard ports without credentials. It resolves the host, refuses private, loopback, link-local, shared (`100.64.0.0/10`) and Azure platform addresses, connects to the address it checked, and validates every redirect.
- Load pages in a browser only through the existing Playwright code in `renderer/browser.ts` and `worker/runtime.ts`. It sends every browser request, including redirects, through the URL policy and the public fetcher.
- Don't call the global `fetch`, import `node:http`, `node:https`, `net`, `tls`, `undici`, axios, got, node-fetch or `ws`, or launch Playwright anywhere else. Calls to fixed Azure endpoints, such as Azure OpenAI, Microsoft Graph and Azure Resource Manager, belong in the existing model and directory transports, which use `redirect: 'error'` and deadlines. A new transport needs an entry, with its reason, in `scripts/security/policy/outbound.mjs`.
- Never turn off TLS verification: no `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED`, `ignoreHTTPSErrors` or `--ignore-certificate-errors`.
- Don't follow redirects automatically. Validate each hop yourself, as `safeFetch` does.
- When you change the URL policy (`worker/runtime.ts`, `worker/public-http.ts`, `worker/references/transport.ts`, `renderer/request-policy.ts` or `renderer/browser.ts`), add cases to `worker-tests/fetch-safety.test.mjs` or the renderer tests.

The outbound-request check (`scripts/security/check-outbound-requests.mjs`) enforces these rules. See [docs/security-scanning.md](../../docs/security-scanning.md).
