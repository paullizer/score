# Reviewer workspace access

Workspace owners can open **My workspaces → Manage reviewer access** to add or
remove a reviewer. The workspace picker shows the signed-in user's Entra object
ID and tenant ID so they can share their exact account identity with an owner.
Optional labels are display text only, not verified names or authorization claims.

An owner can grant access only to an object ID in the deployment's existing
`SCORE_ALLOWED_USER_IDS` configuration, within its configured tenant. This does
not invite users, resolve groups, search the tenant directory, change sign-in
admission, or grant application-administrator status. Existing owner, editor,
and viewer memberships cannot be modified through this screen.

Reviewers can read saved workspace content and participate in the separate QC
workflow. Ordinary content writes remain owner/editor-only: imports, scoring,
sample autosave, rubric edits, summary management, evidence-gap corrections,
renaming, and lifecycle mutations are not reviewer permissions. Workspace
administration remains owner-only. Application administrators receive QC
permissions only while they are workspace members, and receive no additional
ordinary content permissions.

Original downloads and report exports retain their separate role allowlists.
Adding the reviewer role does not add it to defaults or to existing saved policies.

## API contract

All routes are authenticated, same-origin/CSRF-protected, and `no-store`.
Only the current workspace owner can call them:

- `GET /api/workspaces/:workspaceId/reviewers` returns
  `{ workspaceId, tenantId, etag, reviewers }`. Each reviewer contains an
  `objectId`, the fixed `reviewer` role, and an optional `label`.
- `POST /api/workspaces/:workspaceId/reviewers` accepts
  `{ objectId, label? }` and the list's exact `If-Match` ETag.
- `DELETE /api/workspaces/:workspaceId/reviewers/:objectId` accepts the list's
  exact `If-Match` ETag and no body. An owner may remove a previously admitted
  reviewer even if deployment sign-in admission has since been removed.

Successful mutations return the refreshed access list and a new ETag. Missing
ETags return 428; stale ETags return 409. Wildcards, weak ETags, tenant/role/actor
overrides, and additional body fields are rejected. After a conflict or an
unacknowledged request, refresh the list before explicitly retrying; clients do
not replay membership mutations automatically.

Changes acquire the workspace mutation lease, recheck the current owner
membership, and honor pending lifecycle fences. Archived retained workspaces
still allow owners to manage access. Each change atomically updates the directory
ETag, creates or conditionally removes the membership, and creates an immutable
membership audit in the same Cosmos workspace partition. These endpoints cannot
alter the owner's recovery membership. Lifecycle membership cleanup preserves
audit documents and retains owner recovery access until final deletion.

Revoked principals fail subsequent workspace reads and writes. Clients must
discard private QC state when current membership is missing, revoked, or no
longer authorizes QC; application-admin status alone is never a fallback.
