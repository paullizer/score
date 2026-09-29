## Summary

<!-- What changes and why. Link the issue if there is one. -->

## Validation

<!-- List the commands you ran and anything you checked by hand. -->

- [ ] `npm run lint` and `npm run build`
- [ ] The suites that cover this change: `npm run test:server`, `test:worker`, `test:renderer`, `test:reports`, `test:security`
- [ ] `npm run security:check`

## Security checklist

Tick each item, or say why it doesn't apply.

- [ ] Workspace data is read or changed only after the caller's workspace role is checked, with `authorize`, `requireOwner`, `requireApplicationAdmin` or the router's guard.
- [ ] No new anonymous routes. New routes sit under the authenticated `/api` routers.
- [ ] Changes still go through the CSRF checks: a matching `Origin` and the `X-Score-Request` header.
- [ ] HTML from documents or models is sanitized before it's shown, and frames stay sandboxed. No `dangerouslySetInnerHTML`, `innerHTML` or unsandboxed `srcDoc`.
- [ ] Requests to user-supplied URLs go through `safeFetch` and `validatePublicUrl` in the workers, or the renderer's request policy.
- [ ] No secrets, keys, tokens or connection strings in code, tests, docs or logs.
- [ ] New product features are switched on and off in **Admin settings**, not with environment variables.
- [ ] New or updated dependencies resolve through the npm registry or the public Microsoft mirror already in `package-lock.json`, and were published at least 7 days ago.
- [ ] Every new `security-reviewed:` comment names the rule and gives a real reason.
