# Quality pipeline

The application-admin **Quality pipeline** is a read-only evidence-to-release relationship map at `/admin/quality-pipeline`. Open it from workspace home or the administration links in normal or QC mode. It is not a new workflow engine, ingestion queue, release policy, or autonomous learning system.

## Following a change

The complete explanatory map opens without an active workspace or private source reads. Select a workspace, then use **Follow an improvement plan** to choose an authorized saved plan. The selector loads bounded pages; **More plans** is not an all-workspace search or a total-count claim.

The map uses six orientation stages:

| Stage | Meaning |
| --- | --- |
| Evidence | Original saved comparisons, submitted human QC, and saved job/GS rubric and reference context. Ordinary imports and analyses are evidence inputs, not a second complete pipeline. |
| Curate | Explicit feedback selection and drafting/holdout purposes captured in an immutable case pack. |
| Candidate | Generalized proposed guidance and the exact evaluated snapshot when one is recorded. A draft proposal is not an activated prompt bundle. |
| Evaluate | Baseline/candidate trials with the same frozen inputs and model/settings. Holdouts branch to evaluation, never planner drafting. Fixed validation and grounding remain protected. |
| Activate | The existing explicit member-admin decision, with its native reason, confirmation, and fresh version/permission checks. No extra independent-approval stage is introduced. |
| Future work | The current application pointer and potential effects on newly accepted tasks. Existing scores, rubrics, accepted work, and ordinary retries retain their captured versions. |

Select any node to open its explanation and authorized metadata **below** the map. **Back to map** restores focus to that node. **Focus selected path** reduces unrelated emphasis; **Show full map** restores the overview. On narrow screens the same nodes become an ordered vertical view, with accessible relationship descriptions.

The legend distinguishes **saved relationships**, **possible workflow relationships**, and **conditional future use**. An arrow does not prove that every source contributed or that a task actually consumed a candidate. The map is not exhaustive live lineage or worker health. An old activation can be recorded without remaining the current pointer.

The affected-task detail keeps four guidance families separate: job rubric generation, GS competency generation, GS rubric drafting, and analysis assessment. Captured deployments/model identities are shown separately from current defaults. Fixed citation, schema, privacy, qualification, scoring, and grounding contracts cannot be edited through the map.

## Versions, failures, and actions

The context strip names the selected change, next responsible role/action, and change boundary. Exact saved plan, case-pack, settings, baseline, and candidate pins are available in the version disclosure. Missing legacy hashes remain **Not recorded** rather than being reconstructed from today's defaults.

A saved successful evaluation is not a fresh activation authorization. The native action rechecks baseline, settings, compatible runtime, lifecycle, membership, and administrator authority. Explicit links open the existing improvement plan, exact evaluation, exact-result QC review, and prompt history. The map has no paid-work, approval, activation, restoration, or bulk-retry controls.

Transient read failures label retained same-scope metadata as stale. Access denial clears it. Identity, tenant, admin capability, workspace membership, or lifecycle changes abort old scoped requests; late replies cannot restore the previous private view. Use **Refresh pipeline** to read saved metadata, or **Refresh access** to recheck the directory and retry. Missing services, restricted access, no selected plan, and empty authorized pages are not presented as successful zero counts.

Saved metadata remains readable when new QC admission is off, new work is paused, or the workspace is archived. Existing lifecycle/deletion fences still apply. The map never initializes settings/prompts, repairs deployments, schedules inference, or records peer exposure. Deliberately opening native private QC screens retains their existing exposure auditing.

## API and privacy boundary

Both GET routes are mounted under the authenticated, no-store API and require same-origin access, application-admin claims, explicit workspace membership, and the existing selected-run/peer visibility rules. Authorization is checked again after reads. Each API instance limits pipeline requests to 300 per minute per user.

| Route | Projection |
| --- | --- |
| `/api/admin/quality-pipeline/workspaces/:workspaceId/plans` | Plan ID/name, revision, native status, and update time. Accepts `limit` (1-50) and an opaque scoped `continuationToken`. |
| `/api/admin/quality-pipeline/workspaces/:workspaceId/plans/:planId` | Exact result references, selected-review counts, case-pack digest, captured task/model/settings metadata, changed families, baseline/evaluated-candidate pins, saved execution/evaluation counts, and recorded activation ID. |

These are not aliases for the native QC plan list/detail endpoints, which can record peer exposure. The overview reads record metadata without blobs. A selected completed evaluation is read through the existing bounded digest/schema/binding validators; only its metadata is returned. Source documents, case packs, review prose, author identities, proposed instructions, trial narratives, and model outputs are not returned. Corrupt or mismatched artifacts fail explicitly.

There are no new stores, worker permissions, settings keys, feature environment variables, or changes to captured schemas. Current `/api/features` policy and native action routes remain authoritative for new-work admission.

Shared Search/Foundry IQ knowledge still contains only the nonsensitive application guide. Private workspace evidence is not indexed, and adding a source does not train a model or automatically publish knowledge to agents. Customer-rating sampling, reviewer gold, private knowledge adoption, new approval roles, and automatic rollback are outside this feature.
