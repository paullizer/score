# Reviewer workspace access

Workspace Owners and application Admins can open **Manage access** from the
workspace home or picker, choose an eligible Entra user, and select **Reviewer**.
The unified sharing screen also supports Reader, Editor, and equal co-Owner
memberships. The last explicit Owner cannot be removed or demoted.

New grants and privilege increases verify the exact same-tenant user against
Entra application-role assignments: `Score.User` or `Score.Admin` is required.
This does not invite users, change application-role assignments, or grant
application-administrator status. Directory failures block new grants, not
existing authorized reads or removal of access. Role-claim changes take effect
after token/session refresh; workspace membership changes are checked in Score.
The retired `SCORE_ALLOWED_USER_IDS` and `SCORE_ADMIN_USER_IDS` settings are not
runtime authorization sources.

Reviewers can read saved workspace content and participate in the separate QC
workflow. Ordinary content writes remain owner/editor-only: imports, scoring,
sample autosave, rubric edits, summary management, evidence-gap corrections,
renaming, and lifecycle mutations are not reviewer permissions. Workspace
administration requires effective Owner access. Application Admins have
tenant-wide ordinary Owner access, independently of membership, but receive QC
permissions only while they have a valid explicit workspace membership.
Even a Reader membership allows an application Admin to participate in QC.

Original downloads and report exports retain their separate role allowlists.
Adding the reviewer role does not add it to defaults or to existing saved policies.

## API contracts

The sharing UI uses `GET /api/workspaces/:workspaceId/share-candidates`,
`GET /api/workspaces/:workspaceId/members`, and conditional `PUT`/`DELETE`
operations on `/api/workspaces/:workspaceId/members/:userId`. The member role
accepts `viewer`, `reviewer`, `editor`, or `owner`. Owners and application Admins
can manage this collection using its exact ETag.

### Reviewer-only compatibility endpoints

All routes are authenticated, same-origin/CSRF-protected, and `no-store`.
Only a current explicit workspace Owner can call the reviewer-only endpoints;
implicit Admin access is not sufficient:

- `GET /api/workspaces/:workspaceId/reviewers` returns
  `{ workspaceId, tenantId, etag, reviewers }`. Each reviewer contains an
  `objectId`, the fixed `reviewer` role, and an optional `label`.
- `POST /api/workspaces/:workspaceId/reviewers` accepts
  `{ objectId, label? }` and the list's exact `If-Match` ETag. The exact object ID
  must be eligible in Entra. Optional labels are display text, not verified
  names or authorization claims.
- `DELETE /api/workspaces/:workspaceId/reviewers/:objectId` accepts the list's
  exact `If-Match` ETag and no body. An Owner may remove a previously admitted
  reviewer even if application-role assignment has since been removed.

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
alter existing Owner, Editor, or Reader memberships. Every explicit co-Owner
has the same authority; immutable creator provenance confers no special access
after demotion. Lifecycle membership cleanup preserves audit documents and
retains a current Owner's recovery access until final deletion.

Revoked ordinary members fail subsequent workspace reads and writes. Application
Admins may retain ordinary access, but losing explicit membership still removes
QC access. Summaries distinguish effective `role`/`accessSource` from an Admin's
explicit `membershipRole`. Clients discard private QC state and abort old
requests when membership is missing, revoked, or no longer authorizes QC;
application-admin status alone is never a QC fallback.
