# AI-assisted editing

Score's AI-assisted editing framework lets a reviewer change a draft by talking to an assistant. You describe a change in words; the assistant proposes structured edits; the editor applies them to the **unsaved** draft, highlights every change, and keeps an undoable history until you save. The first, and in this release the only, editor using it is the **real job rubric** editor.

The pattern follows the assisted editors in [SimpleChat](https://github.com/microsoft/simplechat/tree/paullizer-react-v2-ui): a full-screen editor with the item being edited plus a side panel of tools, an AI conversation scoped to that one item, auto-applied AI edits with per-turn undo, and a history whose entries record where each change came from. Score ports the pattern, not the code. Some differences are deliberate and explained below.

## What reviewers see

Open a real job rubric and choose **Edit with AI**. You can also choose **Ask AI** on one criterion, or **Edit rubric** and then **AI assist**. The editor opens full screen: the rubric form fills the main pane, and a side panel has three tabs:

- **Ask AI:** a conversation limited to this rubric. It includes quick actions (draft score guidance, tighten wording, rebalance weights, suggest missing requirements from the posting, check consistency, rebuild from the posting). You can also focus the conversation on one criterion. Each assistant turn lists what it changed, with **Jump to** links, the quoted posting passages, and **Undo this change**.
- **Job posting:** the parsed job source, with the focused criterion's cited paragraph highlighted.
- **Changes:** three lists:
  - every unsaved change (before → after, who made it, **Jump** and **Revert**);
  - this session's history (**Restore to here**, which never deletes anything);
  - the saved versions (**Preview**, and **Use as starting point**).

On a new, empty criterion, **Draft with AI** fills in its label, description, 0–5 guidance, requirement type, exact source quote, and weight.

Every unsaved change stays highlighted until you save. **AI assist** changes are blue and **your edits** are violet. Each highlighted field also shows a text badge and its previous value, so color is never the only cue. Fields in a newly added criterion show who wrote them, with no previous value or per-field Revert; remove the criterion to undo the addition. Removed criteria stay visible as **Removed · Restore** rows. **Undo** and **Redo** in the editor header work across AI and manual changes; inside a text box, Ctrl/⌘+Z keeps the browser's own text undo. When AI changes are present, the first **Save version N** opens the **Changes** tab and asks you to **Confirm and save version N**. Saves with only your own edits still take one click.

Highlighting, session history, undo/redo, the saved-versions list and the Job posting tab are part of the shared editor, so they also apply when you edit sample rubrics. The AI features appear only for real job rubrics in the cloud app.

## Guarantees

- **The assistant never saves.** It returns validated operations. Only **Save** persists a change, through the existing `PUT /jobs/:jobId/rubric` path, with its existing validation, job ETag check and immutable version append.
- **Scoped context.** The model receives only the job's parsed posting, the current unsaved draft, this editor's recent conversation and the new instruction. It never sees other rubrics, resumes, analyses or workspace data. Posting, draft and conversation are presented as untrusted material, never as instructions.
- **Grounded edits.** Every added criterion, and every change to what a criterion assesses, must quote the posting exactly. The server checks that the quote is an exact substring of the named paragraph. It then builds the citation's document ID, version, page and heading itself; the model never supplies them. AI-written guidance must anchor every score from 0 to 5 with documentary-evidence levels. Criteria for protected or questionable personal characteristics are rejected. If the posting doesn't support a request, the assistant explains instead of inventing requirements.
- **Invalid output never reaches the draft.** Output is validated against a strict schema and the rules above. One correction round (the configured `jobRubric` correction budget) may follow. If it still fails, the request fails and the draft is unchanged.
- **Stale work is refused.** If a newer rubric version was saved after the editor opened, the assistant returns 409 and Save conflicts as before; your draft is kept. The form is locked while a request is in flight. **Cancel**, or closing the editor, aborts the request.
- **Session-only conversation.** The conversation and the unsaved-change history live only in the open editor. Closing the editor discards them after the usual unsaved-changes warning, and a successful save clears them. **Saved rubric versions remain the permanent history.**
- **No new provenance in this release.** A saved version is still labeled **Reviewer edited**. The reviewer who saves is accountable for its content. Assistant usage is recorded only as content-free telemetry: outcome, operation count, correction count, conversation turns sent or dropped, duration and error category.

## Data path

This is the first **synchronous** model call on private data from the Score API. All other private-data model work runs in background workers. For each assistant turn, the API identity sends the job's extracted posting text, the reviewer's draft and the instruction to the existing Foundry deployment used for job-rubric generation. That deployment runs under the same US Data Zone processing boundary, and no RBAC change is required, because the API identity already holds the model-user role it uses for administrator model probes. Nothing from the exchange is stored. Instructions, drafts, replies and source text are never logged.

## Architecture

| Layer | Files | Responsibility |
| --- | --- | --- |
| Shared contracts | `src\domain\assist.ts` | Generic limits, outcomes (`changed`, `explained`, `clarify`), instruction and conversation schemas, response envelope, replay helpers |
| | `src\domain\rubric-assist.ts` | Job-rubric draft, request and operation schemas, server-built citations, field keys, and `applyRubricAssistOperations` (applied identically by browser and server) |
| Browser framework | `src\features\assist\types.ts`, `changeTracking.ts`, `useEditSession.ts` | Adapter contract, baseline diffing, AI/you attribution, bounded session history (undo/redo, restore, per-turn undo, grouped typing) |
| | `src\features\assist\AssistedEditorShell.tsx`, `AssistConversation.tsx`, `useAssistConversation.ts`, `ChangeHistoryPanel.tsx`, `ChangedField.tsx` | Full-screen layout and side-panel tabs, the scoped conversation, change and history lists, and field highlighting |
| Rubric adapter | `src\features\rubrics\rubricAssist.ts`, `RubricEditor.tsx`, `RubricPanel.tsx` | Rubric field descriptors, change summaries, saved-version notes, and the rubric editor and its entry points |
| Browser service | `src\services\rubricAssist.ts` | Request/response validation, a longer per-call timeout, typed errors for timeout, rate limiting, conflicts and invalid responses |
| Server framework | `server\assist\runner.ts`, `limits.ts`, `model.ts`, `types.ts` | Budget fitting (oldest turns dropped, source never truncated), shared deadline, correction rounds, abort on disconnect, error mapping, per-user limits, model invocation through the worker transport |
| Rubric profile | `server\assist\profiles\job-rubric.ts` | Code-owned prompt `score-rubric-assist-v1`, strict JSON schema, validation and citation construction |
| Route | `server\jobs\routes.ts` | `POST /api/workspaces/:workspaceId/jobs/:jobId/rubric/assist` |

The job-rubric **generation** prompt is unchanged. Its text is hashed into immutable prompt revisions, so the assistant has its own versioned prompt that restates the same rules. A test guards that the two keep the same key rules.

## API

`POST /api/workspaces/:workspaceId/jobs/:jobId/rubric/assist` requires authentication, the existing CSRF headers, and workspace **write** access (owners and editors; viewers and reviewers cannot use it). The route is read-only and does not hold a workspace mutation lease during the model call.

The request body contains:

- `submissionId` (UUID);
- `base: { rubricId, version }`, the saved version the editor opened;
- `instruction`, 1–2,000 characters, rejected rather than truncated when longer;
- `conversation`, up to 20 earlier turns;
- `focusCriterionId`, or null;
- `draft`, the unsaved draft (name, description, and criteria with their primary citation).

The response contains `outcome`, a plain-text `reply`, `operations` (`updateRubric`, `updateCriterion`, `addCriterion`, `removeCriterion`), `warnings` (for example a weight total other than 100, or criteria still missing a quote) and `assistant: { promptVersion, model }`.

| Status | Meaning |
| --- | --- |
| 200 | Validated operations, an explanation, or a clarifying question |
| 400 | Invalid request, or the posting plus draft exceed the model budget (nothing is truncated) |
| 403 / 404 | Not permitted, or unknown job |
| 409 | A newer version was saved, or the job or rubric is not editable (not ready, archived, deleted) |
| 429 | Score's per-user limit or the model provider's rate limit; `Retry-After` is set |
| 502 | The assistant could not produce a valid change, or the model declined; the draft is unchanged |
| 503 | Assistant disabled, new work paused, runtime settings not admitting new work, or the model took too long |

## Limits

| Limit | Value |
| --- | --- |
| Instruction | 2,000 characters, rejected, not truncated |
| Conversation replayed | Up to 20 turns; oldest dropped first, and dropped again if needed to fit the model budget |
| Model budget | The `jobRubric` task binding's input budget and completion limit; the posting is never truncated |
| Rate | 1 request in flight and 20 per 10 minutes per user; 8 in flight per API instance (approximate when scaled out) |
| Deadline | About 150 seconds on the server and 170 seconds in the browser, below App Service's 230-second request limit |
| Session history | 100 steps; older steps are removed with a notice, never the current draft |

## Configuration

The assistant is **on by default** wherever it can run. Administrators turn it off or back on under **Admin settings → Features & intake → Rubric AI assistant** (`features.rubricAssistant`); there is no environment flag. The server applies the change to the next assistant request without a restart; pages that are already open hide the button when they next refresh settings, and until then a request gets a clear "turned off" message with the draft unchanged.

It can run only where real job imports are enabled (`REAL_JOB_IMPORTS_ENABLED=true`) and the existing `RUBRIC_MODEL_ENDPOINT`, `RUBRIC_MODEL_DEPLOYMENT` and `RUBRIC_MODEL_NAME` are set (optional `RUBRIC_MODEL_REASONING_EFFORT`). Those describe the deployment rather than switch the feature, and a partial set fails at startup. Where they are missing, `/api/features` reports the assistant unavailable and the Admin switch cannot turn it on.

The assistant reuses the **`jobRubric` task binding** from Admin settings for its deployment, reasoning effort and budgets. When runtime settings are enabled it uses the pinned binding; otherwise it uses the environment-configured deployment. It therefore shares that deployment's quota with rubric generation, so expect occasional 429s under load.

The **Pause new work** switch and the runtime-settings admission gate also stop assistant requests, but turning off job imports does not: reviewers can still refine existing rubrics. `/api/features` reports `rubricAssistant: true` only when the deployment offers it, the Admin switch is on and new work is being admitted, and the assist route enforces the same checks.

Revisions saved before the switch existed omit the key, and an absent key means on. The key is written only when an administrator changes it, so earlier revisions and captured settings keep their exact shape. A revision that contains the key can be read only by API and worker builds that know it, so deploy them together (as `scripts/deploy.ps1` does) and don't roll workers back to an older build after saving it.

## Adding another assisted editor

1. **Browser adapter:** implement `EditSessionAdapter<TDraft>` (field and item descriptors, `revert`, optional `restoreKeyFrom`), plus functions that apply operations and describe them for change cards. Use `useEditSession`, `useAssistConversation` and the shell components.
2. **Contracts:** add a draft, request and operation schema module beside `rubric-assist.ts`, with an apply function shared by browser and server.
3. **Server profile:** implement `AssistProfile<TContext, TOperation>`: a code-owned versioned prompt, a strict schema, `buildPrompt` with stable evidence first, and `validate`, which must reject anything the save path would reject.
4. **Route:** authorize, check lifecycle and the base version, load evidence server-side, acquire the limiter, abort on client disconnect, and call `runAssist`. Never write from the assist route.
5. **Tests:** fake-model contract tests on the server and JSDOM tests for the editor. Deterministic tests prove the contract, not that every natural-language request succeeds.

A future **GS grade draft** adapter must respect that editor's rules: support verdicts cannot be relabeled, saving requests a new grounding review, and nothing bypasses approval.

## Follow-ups

- AI assistance for GS grade drafts, and a scripted demo assistant for samples.
- Recording AI-assisted provenance or saved-version authors (a worker-first schema rollout).
- A dedicated `rubricAssistant` model binding (a settings-version rollout).
- Server-side conversation history, streaming responses, and a lint for manual rubric edits.
