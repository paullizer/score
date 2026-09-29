---
applyTo: "server/**"
---

# Access control in the API

Every `/api` request must come from an authenticated, admitted identity, and every request that changes data must pass the CSRF check. After that, each route checks what the caller may do.

- Add routes to a feature router that `server/app.ts` mounts on the `api` router, after `noStore`, the authentication middleware and the CSRF middleware. Don't reorder that wiring, and don't register routes on `app`. `/healthz` is the only anonymous route.
- Guard every workspace route before its handler runs, for example `router.get(path, authorize(deps.repository, 'read'), handler)`. Use `'write'` for changes and `'manage'` for lifecycle changes. Wrap handlers that change stored data in `repository.withWorkspaceMutation`, which checks access again.
- Gate application-wide routes with `requireApplicationAdmin` or `isApplicationAdmin`, and owner-only actions with `requireOwner`.
- Get the caller only from `getPrincipal(req)`. Only `server/auth.ts` and `server/middleware.ts` may read the `x-ms-client-principal` and development principal headers, and the development header must stay unreachable in production and on App Service.
- Take the workspace id from the route path, never from the request body, and don't trust a role, owner or user id that the client sends.
- Don't add CORS. The browser app is served from the same origin as the API.
- Pass request values to Cosmos DB queries as `parameters` (`@name`), never by building the query text from them.
- `server-tests/route-auth-inventory.test.mjs` checks that every `/api` route refuses requests without an identity and that every route that changes data refuses requests without the CSRF headers. Also test each new route's own rules: a non-member, a reader who tries to write, and a non-administrator.

The access-control check (`scripts/security/check-access-control.mjs`) enforces the route and wiring rules. See [docs/security-scanning.md](../../docs/security-scanning.md).
