# Microsoft-Decision-1 offline evidence spike

**Production decision: no-go on the current evidence.** This is a tested offline adapter and a small synthetic experiment, not a production model selection, scoring change, feature switch, deployment, or approval system. The explanatory assessor/reviewer remains unchanged. Neither probabilities nor this experiment establish a person's ability, hiring suitability, or eligibility.

## Verified native contract

The deployed [Microsoft Foundry](https://ai.azure.com/catalog/models/Microsoft-Decision-1) Decision-1 Playground choice sample and deployment-details endpoint were inspected directly, and native synthetic requests verified the contract:

- `POST https://<account>.services.ai.azure.com/providers/microsoft/v1/systemone`, without a guessed Chat Completions endpoint or API-version query.
- Microsoft Entra scope `https://cognitiveservices.azure.com/.default`.
- Request `{ model: "<deployment-name>", state: "<text>", questions: { evidence: { type: "choice", instructions: "<text>", criteria: { "<option-id>": "<description>" } } } }`.
- Named answers, a returned underlying model identity, and token usage.

The Playground choice sample uses `type`, `instructions`, and a named `criteria` map. The deployment Details page exposes the exact `/providers/microsoft/v1/systemone` endpoint, model version 1, and GlobalStandard SKU; API-key authentication is disabled. Entra authentication was confirmed by the native synthetic requests. No Playground inference, settings change, or credential capture was performed. Restricted documentation inspected during discovery is not redistributed in this public repository; its references remain in the private investigation artifacts.

An authorized 66-input-token synthetic maintenance-note smoke returned HTTP 200 on October 9, 2026. Its actual response verified the strict choice envelope:

```json
{
  "model": "microsoft-decision-1",
  "answers": {
    "evidence": {
      "type": "choice",
      "choice": "support",
      "confidence": 0.998204746753288,
      "probabilities": {
        "insufficient": 0.0007093244251902473,
        "mention": 0.00048751107261782597,
        "support": 0.998803164502192
      }
    }
  },
  "usage": { "input_tokens": 66, "output_tokens": 1 }
}
```

`confidence` is a separate provider value, not the chosen probability. Nonzero output usage is valid even though the [announced output price is free](https://commandline.microsoft.com/microsoft-decision-1-model-foundry/).

The spike is deliberately scoped to the existing `aif-score-3ser24tdznnh6` account and `Decision-1` deployment. Paid preflight reads that exact ARM deployment with a separate management token and requires Microsoft-Decision-1 version 1, Microsoft format, GlobalStandard, succeeded provisioning, `decision: true`, and `chatCompletion: false`. No access grants or Cosmos/Blob reads occur. The response does not return a model version: the capture records the observed ARM version, not a falsely inferred per-response version. GlobalStandard does not promise US-only processing.

No authoritative model-specific context maximum was established. The application's byte bound and conservative token reservation are **local experimental limits**, not advertised model context capacity. Availability/quota is a scheduling concern, not a suitability verdict.

## Commands and admission

Use Node 24, an already authorized Azure CLI identity in the manifest's tenant, and the existing dependencies:

```powershell
npm run build:worker
node scripts\decision-evaluation-prepare.mjs synthetic C:\private-evals\synthetic-v1.json
node scripts\decision-evaluation-run.mjs C:\private-evals\synthetic-v1.json C:\private-evals\synthetic-dry-v1 --dry-run
# Only after scoped paid-inference authorization:
node scripts\decision-evaluation-run.mjs C:\private-evals\synthetic-v1.json C:\private-evals\synthetic-panel-v1 --confirm-paid-inference
```

`synthetic` prepares ten engineering-authored records, not private resumes. Five variants produce 50 decisions: baseline, identical repeat, reversed option order, paraphrased definitions, and formatting. The separated requirement/evidence follow-up is independently captured:

```powershell
node scripts\decision-evaluation-prepare.mjs synthetic-separated C:\private-evals\synthetic-separated-v2.json
node scripts\decision-evaluation-run.mjs C:\private-evals\synthetic-separated-v2.json C:\private-evals\synthetic-separated-dry-v2 --dry-run
# A separate explicitly admitted run; four variants, 40 decisions, one attempt per decision:
node scripts\decision-evaluation-run.mjs C:\private-evals\synthetic-separated-v2.json C:\private-evals\synthetic-separated-panel-v2 --confirm-paid-inference
```

The v1 state retains the full saved criterion, including requirement citations. V2 explicitly separates the saved criterion's label/description from documentary excerpts and surrounding context; it excludes requirement citations and scoring guidance from model-facing evidence, while retaining their full frozen criterion hash. The missing `promptVersion` field continues to mean v1, so old manifests and provenance keep their exact shape. Neither prompt sends expected labels, prior model assessments, complete unrelated sources, or an ordinal-scoring request.

For an authorized **development-only** corpus manifest, prepare a separate unadmitted prototype:

```powershell
node scripts\decision-evaluation-prepare.mjs development C:\private-evals\development-unadmitted-v1.json C:\private-evals\development-screening-manifest-v1.json C:\private-evals\development-planted-evidence-annotations-v2.json
node scripts\decision-evaluation-run.mjs C:\private-evals\development-unadmitted-v1.json C:\private-evals\development-dry-v1 --dry-run
```

This takes the first ten planted criterion annotations in their frozen order, binds the first fact's first literal alternative to production passage IDs, and includes adjacent context. The selection sidecar records input/annotation hashes, authors and revisions. It is a preparation diagnostic, not a representative panel or evidence-recall experiment. Existing supporting/non-supporting/contrary fact roles do not establish all five semantic labels, so these cases have `expected: null`. Prior mini/Luna assessments are not used as truth. No sealed holdout is loaded. Review the source-bound selection and independently label the exact five-way task before any quality comparison.

**The confirmation argument is a mechanical guard, not permission to transmit private data.** Obtain explicit authorization identifying case/request count, maximum spend, exact source scope, and the GlobalStandard destination before private inference. A development dry-run does not acquire credentials or send data. Keep private inputs and captures outside the repository and public Actions artifacts; configure Windows ACLs explicitly, because POSIX modes alone do not establish Windows privacy.

## Validation, budgets and captures

The adapter accepts exactly the requested option set, finite probabilities in `[0,1]`, total probability within `1e-6` of one, a chosen maximum-probability option, valid confidence, exact model identity, and nonnegative integer input/output usage. It never repairs or renormalizes a bad distribution. Ties, insufficient-context, low top probability, or a small margin defer; confidence is not an authorization or safety bypass.

The transport uses the single fixed Azure endpoint, Entra authentication, `redirect: error`, a bounded response stream, and a deadline covering authentication, fetch, and body reads. At most two attempts are allowed. Only timeout/network failures and HTTP 429/502/503/504 may retry; provider cooldown beyond five seconds stops instead of issuing an early retry. Authentication, context/request rejection, malformed output, unexpected model, and metering failures remain explicit failures, never successful zero-evidence judgments.

Before each attempt, a durable journal records the request hash and a conservative token-cost reservation. Every finished attempt retains HTTP status, sanitized failure code, reported usage/model, duration, and a versioned price estimate. Missing usage remains unknown cost and keeps its full reservation; malformed probabilities still retain valid reported usage. Storage/journal errors stop the runner. Unexpected models, authentication failures, and spend/metering-bound breaches stop further admission.

The announced tariff is $0.042 per million input tokens and zero for output. Reservations use the declared maximum input count, required to exceed the complete request-byte bound by at least 4,096. No API parameter enforcing that token limit was verified. This is conservative local admission accounting, **not a guaranteed Azure invoice cap**; the runner fails closed on a reported bound breach, but cannot reverse a provider charge. Price estimates are not billing reconciliation. Establish provider-side spending controls separately if a contractual hard billing ceiling is required.

Default synthetic manifests use a 16,000-byte request bound, 24,000-input-token per-attempt reservation, 30-second timeout, sequential pacing of 1.5 seconds, and a $0.25 local admission ceiling. V1's worst-case reservation is $0.100900 (100 attempts, micro-dollar rounding); v2's is $0.040360 (40 attempts). These are not measured model-context limits or reasons to reject capacity.

Every dry-run/run requires a **new** output directory. It exclusively captures the original and parsed manifest, executable runner, evaluation bundle, dependency lock, Node version, verified contract and tariff, and execution hashes. Paid runs additionally retain deployment/admission snapshots, append-only attempt and observation journals, final observations, report, and cost summary. Reusing a directory or silently resuming/replaying a run is refused. Interrupted runs keep their saved prefix; they are not automatically resumed under a fresh budget or code version.

Case provenance binds the exact full input, saved criterion, source catalog, literal citations/context, prompt, option definitions, and perturbation. Production validation and the unchanged passage catalog/resolver establish ownership and exact source text; negative excerpt judgments do not prove absence in the whole document. Strict reports reject duplicate, modified, wrong-manifest, wrong-provenance, or response-hash-mismatched observations.

Reports show baseline-only confusion, false/missed support, deferrals, accepted errors, multiclass Brier (sum over the five options), descriptive probability bins, and risk-versus-coverage. Planted versus human-reviewed origins and independence remain separate. Repeats/perturbations use paired available-case denominators; failures and missing work are separate, not true negatives. Latency includes transport retries, not intentional inter-request pacing. No generative fallback is executed: deferral is a measured handoff signal, not a tested fallback outcome.

## Executed synthetic results: October 9, 2026

The contract smoke plus both panels used **91 total synthetic decisions**. Both panels had zero transport/schema errors, zero retries, and no missing decisions. Their 90 attempts used 36,696 input tokens; the smoke added 66. Per-attempt micro-rounded estimates were $0.001031 for v1 and $0.000557 for v2, plus approximately $0.000003 for the smoke. These are estimates, not settled bills.

| Baseline-only metric | Full-criterion v1 | Separated v2 |
|---|---:|---:|
| Authored cases | 10 | Same 10 |
| Expected-label matches | 3/10 | 8/10 |
| False-support labels | 5 | 1 |
| Missed-support labels | 1 | 1 |
| Deferred at probability 0.9 / margin 0.2 | 8/10 | 3/10 |
| Non-deferred errors / non-deferred cases | 1/2 | 0/7 |
| Multiclass Brier | 1.001739 | 0.287582 |
| Exact-repeat label flips | 0/10 | 0/10 |
| Reverse-options label flips | 0/10 | 0/10 |
| Paraphrased-options label flips | 1/10 | Not run |
| Formatting label flips | 3/10 | 0/10 |

V1 falsely supported the background-only case with probability **0.936255**, passing the exploratory deferral threshold. This directly refutes treating high confidence as sufficient safety. Its `[0.8,1]` baseline bin averaged probability 0.894555 with 3/7 matches.

V2 still falsely supported other-person attribution (0.865130) and missed the identity-substitution support case (0.782833); both deferred. Its `[0.8,1]` bin averaged 0.973006 with 8/9 matches. Identical repeats changed some probabilities by up to 0.012085 without changing labels; formatting changed probabilities by up to 0.115267. Across all 40 v2 decisions, request latency P50 was 146 ms and P95 was 928.4 ms.

V2 was written after seeing v1 on the **same authored development cases**. Its better observed agreement is not independent improvement evidence, validated calibration, fairness evidence, or Score-corpus quality. No private-corpus inference or further tuning loop was performed. **Do not promote either prompt, activate Decision-1 in production, replace the explanatory reviewer, or approve rubrics/scores from these results.** A separately authorized, independently reviewed task-specific evaluation remains necessary; quota does not decide that quality question.
