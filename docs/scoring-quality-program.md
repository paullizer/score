# Evidence-first scoring evaluation

The goal is repeatable document-evidence scores, not a required user workflow for model disagreements. Production scoring is unchanged by the offline evaluation tools. Human QC is separate from ordinary scoring; neither model agreement nor a higher mean score proves correctness.

## Offline implementation boundary

`worker/evals` provides strict versioned suite, observation and reference contracts; ordinal repeat statistics; a bounded resumable executor; and a USD cost ledger with a durable milestone outbox. The explicit production adapter and paid runner reuse production model transports; the experimental evidence-first adapter is offline-only. These tools do not provision infrastructure, expose new API routes, edit global prompts, activate configurations or change ordinary scoring.

The initial program targets four existing jobs, 50 simulated resume families, 300 criterion references and 30 blind human spot checks. These are program targets, not implicit schema defaults. Resume families and all derived variants must stay in one split. Keep private evidence and labels outside this public repository.

## Offline commands

Build with the existing toolchain:

```powershell
npm run build:worker
node scripts\scoring-evaluation.mjs validate C:\private-evals\suite.json C:\private-evals\references.json
node scripts\scoring-evaluation.mjs report C:\private-evals\suite.json C:\private-evals\observations.json C:\private-evals\report.json C:\private-evals\references.json
node scripts\scoring-evaluation.mjs costs C:\private-evals\cost-ledger.json C:\private-evals\cost-state.json
node scripts\scoring-evaluation.mjs prepare-corpus C:\private-evals\sources.json C:\private-evals\corpus.json
node scripts\scoring-evaluation.mjs spot-checks C:\private-evals\manifest.json C:\private-evals\targets.json C:\private-evals\blind-pack.json score-blind-v1
node scripts\scoring-evaluation.mjs silver-references C:\private-evals\manifest.json C:\private-evals\reference-targets.json C:\private-evals\observations.json C:\private-evals\silver.json mini-low 1
node scripts\scoring-evaluation.mjs extraction C:\private-evals\extraction-trials.json C:\private-evals\extraction-report.json
node scripts\scoring-evaluation.mjs judge C:\private-evals\fixed-judge-trials.json C:\private-evals\judge-report.json
node scripts\scoring-evaluation.mjs judge-report C:\private-evals\suite.json C:\private-evals\proposals.json C:\private-evals\observations.json C:\private-evals\judge-labels.json C:\private-evals\judge-report.json
node scripts\scoring-evaluation.mjs invariance C:\private-evals\suite.json C:\private-evals\observations.json C:\private-evals\pairs.json C:\private-evals\inputs.json C:\private-evals\invariance-report.json
node scripts\scoring-evaluation.mjs human-labels C:\private-evals\manifest.json C:\private-evals\blind-targets.json C:\private-evals\human-submission.json C:\private-evals\human-labels-v1.json
node scripts\scoring-evaluation.mjs source-references C:\private-evals\reference-manifest.json C:\private-evals\reference-targets.json C:\private-evals\reference-results.json C:\private-evals\source-labels-v1.json source-luna-high
node scripts\scoring-evaluation.mjs gates C:\private-evals\suite.json C:\private-evals\observations.json C:\private-evals\human-references.json C:\private-evals\gates.json baseline candidate
node scripts\scoring-evaluation-run.mjs C:\private-evals\manifest.json C:\private-evals\runs\screening --confirm-paid-inference
```

The offline CLI writes atomic artifacts without network requests. The paid runner invokes the fixed Azure account only after complete source/settings/price preflight and the explicit admission argument. It checkpoints each repetition and retains private results and transport attempts. Do not use a public Actions artifact for private source text or labels. The output directory should have appropriate filesystem access controls; POSIX file modes alone do not configure Windows ACLs.

New adapter executions require an explicit frozen model version and the responding model's exact dated identity to match it. An unexpected identity/deployment, or a successful response with no model identity, is retained as an unknown-cost paid attempt and stops admission; it cannot silently publish an unverified model under the old configuration. Earlier runs retain actual-model provenance for an explicit identity audit, rather than retroactively claiming this guard was active.

The suite schema is defined in `worker/evals/contracts.ts`. Freeze source/algorithm versions, configuration settings hashes and exact case input hashes before executing. `evaluationHash` hashes serialized JSON; all suite callers use the strict parsed suite, whose schema fixes field ordering. Input hashes must be captured consistently by the eventual production adapter, not generated from source filenames.

New reference selection uses hashed case/criterion tuples to avoid ambiguous dotted IDs. Existing frozen target files and blind packs keep their original IDs; do not regenerate them in place or silently substitute the new selection into an earlier suite.

Observations bind the suite hash, configuration, case and repetition. Complete observations cover each saved criterion exactly once; failures contain an error code and no successful score. Numeric zero remains zero, while missing/failed/null results are not scored as zero. Conflicting duplicate repetitions fail instead of being overwritten.

Grade suites explicitly capture `excludedCriterionIds` for saved not-applicable rows. Paid preflight requires the exact frozen grade exclusion set; observations still include those rows but must keep them null. They do not count as unstable/missing scored criteria, and cannot receive scored reference labels. The optional field stays absent in older job suites, preserving their exact shape.

## Statistics and references

Pairwise disagreement counts disagreeing unordered pairs divided by all scored pairs for an item. For example, `[2,2,2,2,2,3]` has 5 disagreeing pairs out of 15, not 100% disagreement. Its any-change indicator is true; that is a different statistic.

The report uses equal item means, sample SD for repeated overall scores and linearly interpolated quantiles. It reports incomplete repetitions, completion counts and separate development/calibration/holdout strata. It is descriptive: no family-clustered confidence intervals, population weighting, noise-floor claim, judge qualification or release eligibility is inferred.

`metrics.ts` separately supports seeded paired family-clustered bootstrap intervals and annotated evidence-fact precision/recall. Unannotated passages remain unknown, not false positives or proof of recall. The descriptive report does not automatically apply these measurements or qualify a release.

The blind batch contains 18 development, six calibration and six holdout cards. Twenty are probability-sampled within job/split strata, ensuring every job is represented in each split; ten prioritize caller-supplied uncertainty. Store priority reasons privately, not on blind cards. Cards expose complete source passages and saved criterion anchors but no model opinions. Keep holdout human responses sealed from tuning.

## Experimental evidence-first candidate

`score-evidence-first-v1` maps supporting and contradictory source passage IDs for every criterion, scores against the complete source and saved anchors, then selectively verifies uncertainties, qualifications, extremes, inconsistencies and a fixed audit sample. A disputed assessment receives bounded automatic resolution, which can raise or lower a score. No averaging, higher-score preference, user disagreement action or retry-until-accepted loop is introduced.

The candidate shares at most two repair/resolution calls across the comparison. It preserves source ownership, exact quotes, saved weights and private intermediate diagnostics. Its final resolver does not face a further independent veto; that is an experimental policy requiring evaluation, not a production guarantee. Malformed model output is an explicit failed observation; ledger/storage failures stop admission rather than becoming scores.

New runner executions retain private validated assessment/review checkpoints even on typed scoring failure. The candidate additionally retains its initial assessment, initial provenance and evidence-map provenance alongside the final result. Observer callbacks receive clones and cannot rewrite model evidence. Diagnostic-storage failure stops reusable completion; it is not converted into a failed score. Earlier smoke/screen runs started before this diagnostic persistence was added cannot recover missing proposal snapshots retroactively, and must not be treated as a qualified fixed-judge audit. Diagnostic retention does not change scoring prompts, saved anchors or policy.

New attempt JSONL records also include an `evaluation` binding to the suite, case, configuration and repetition, so concurrent transport costs can be attributed to exact jobs. Typed model failures retain a private `<job-hash>.failure.json` with safe code, stage and diagnostic reason, distinguishing input context, response size and completion exhaustion without saving raw upstream error bodies. Storage failure stops reusable publication. Earlier runs without these bindings/reasons cannot recover them by guessing from concurrent timestamps or a generic `context-limit` code.

Reference origins stay separate: model-assisted, planted, human-reviewed and adjudicated. A score of null is an unresolved reference, not zero. Select one effective reference per origin and criterion; keep original submissions and revisions separately. Exact source hashes protect against applying a label to changed evidence. Model identity and exposure metadata remain attributable.

`silver-references` exports provisional scorer-derived anchors with frozen settings/task bindings and observation hashes. These are explicitly non-independent; they are not separately prompted judgments. Same-producer agreement cannot establish accuracy. The output is a provenance bundle: pass its `references` array, not the entire bundle, to report/validation commands. Independent references and blind human calibration remain required.

Reference errors are averaged per item before aggregation, so repeated model calls do not become extra human labels. Inclusion probabilities are preserved but are not used to claim a population estimate. Unobserved executions are visible in suite completion counts; observed failures/null criterion outcomes are visible in reference diagnostics.

Reports also include equal-item exact/within-one agreement and quadratic-weighted kappa. Degenerate single-category agreement has no defined kappa and remains null. These descriptive values do not make repeated outputs independent human labels.

`score-source-reference-v1` independently reads complete source evidence and the saved anchors in one separately prompted call, with no scorer outputs, correction feedback or human labels. Its task binding uses `assessmentReview`; its output is an offline AI reference, not a production review-approved score. `source-references` accepts only its source-bound results and preserves actual-model and exposure provenance. Independent exposure does not imply independent model errors or gold labels.

The paid runner also accepts `kind: "fixed-judge"` with only `score-fixed-judge-v1` configurations and a `proposals` array of `{ id, assessmentSha256, assessment }`, covering every case exactly once. Sources and saved proposal hashes are checked before paid admission. It calls only the captured `assessmentReview` task on that unchanged proposal: no assessor, semantic score correction or repeat-until-supported loop. Bounded JSON/schema repair remains allowed under the captured policy. `observations.json` contains proposal-bound verdicts, not scoring observations; private `<job-hash>.review.json` files retain full findings. Ground-truth labels must stay separate and are never supplied to the reviewer. A rejection is a completed review verdict, while processing failures remain failed observations. The same program lock, attempt ledger, deadlines, identity checks and execution fingerprints apply; proposal hashes also bind resume.

`judge-report` binds separately supplied labels to exact source/proposal hashes. A label requires `caseId`, `inputSha256`, `assessmentSha256`, `origin` (`planted` or `human-reviewed`), `author`, `revision`, `independent`, `expectedIssue` (`none`, `over-credit`, `under-credit` or `unsupported-fact`) and a nonblank `reason`. Select one effective revision per origin/case; model-exposed labels remain visible but do not count as independent truth. Reports separate origin, split and repetition rather than treating repeated calls as additional labels. Missing work is reported separately from actual processing failures; neither becomes a true negative. These are binary issue-detection measurements, not proof of correct issue-type classification or judge qualification.

The same report includes label-free `verdictStability` per unchanged proposal/configuration and `configurationComparisons` for matched repetition indices between configurations. It separately measures binary issue disagreement and categorical outcome disagreement (`supported`, `needs-correction`, `unsupported`), with explicit completed-pair denominators, missing reviews and processing failures. Empty label arrays permit these descriptive comparisons but produce no accuracy measurements. Agreement cannot establish correctness; accepted/disputed prior model verdicts are sampling provenance, not expected labels.

Offline reporting and resume validation recompute each structurally valid proposal's canonical assessment hash; retaining an old hash while editing its rationale, scores or citations is rejected even when all observations and labels still quote that old hash. Paid admission additionally checks each proposal against its complete frozen source, requirement citations and weights.

`human-labels` regenerates the exact blind pack from frozen inputs and binds the submission to its hash. Responses require a human reason, explicit unable-to-judge status, and valid passage IDs for positive scores. Seen-model responses remain human-reviewed but non-independent. Revision outputs are immutable; the original AI labels and earlier human revisions are never overwritten. Keep holdout label files private and separate from development tuning.

`extraction` checks exact planted-fact preservation, separately reports whitespace equivalence, and verifies that the passage catalog reconstructs every source paragraph. It does not infer PDF/OCR fidelity from Markdown results. `fixedJudgeStatistics` distinguishes known defect detection, missed issues, false corrections and indeterminate processing failures; over-credit and under-credit are separate strata.

`layout-integrity <raw-service-response.json> <planted-facts.json> <report.json>` diagnoses literal OCR misses without changing extraction. It binds service selection annotations to exact state-consistent, nonoverlapping content spans, retains their raw confidence and marks malformed or uncertain spans unbound. UTF-16 and Unicode code-point indexing are explicit; non-ASCII text-element indexing is not guessed. A temporary inspection view omits only bound service annotations and checks case-sensitive word-sequence preservation separately from exact/whitespace fact matches. No saved evidence or model input is rewritten. Punctuation can carry meaning, and an injected service checkbox annotation is not proof that a checkbox exists in the original image; these lexical diagnostics establish neither semantic fact recall nor a correct score.

Controlled resolution trials retained all 16 job-bound fact checks at 144 DPI and at 72 DPI. At 54 DPI, 8/16 exact checks missed across two of the four source bodies. Inspection found an inserted selection annotation/paragraph break in one fact and a missing final period in another, not demonstrated loss of the factual words. Four job bindings per source are not four independent OCR observations. Preserve the original literal report, service output and images; do not force credits, strip real selection marks or classify these misses as unfair scores without evidence. These small development trials do not cover population scans or qualify a production extraction change.

### Span-bound table extraction candidate

The controlled live DOCX/PDF trial demonstrated why fact recall alone is insufficient: Document Intelligence can expose the same table cell in both `paragraphs` and `tables`, with exactly the same source offsets. Rendering both repeats evidence even when every planted fact survives. The offline `documentIntelligenceParagraphs` option `tableParagraphPolicy: 'span-bound'` removes a standalone paragraph only when its normalized text, complete ordered valid source spans and page exactly match a cell included in a rendered table. Equal text at different offsets, uncertain/missing spans, distinct physical PDF pages and paragraphs from overwritten cells are preserved. DOCX captured sections continue to use synthetic page 1 rather than infer physical pagination.

The default remains `preserve`; production import callers do **not** opt into the candidate. Source deduplication is not a text-only heuristic and does not rewrite saved sources. Candidate experiments must capture a separate extraction-policy version and source hash, preserve the original service result, measure context/order and score effects, and qualify the change before any rollout. Word/PDF extraction versions still describe the unchanged production policy; local candidate artifacts separately identify the span-bound policy. Reducing duplicate representations does not establish hiring validity or predict the direction of model scores.

`invariance` compares explicit `{ id, baselineCaseId, variantCaseId, kind }` pairs against frozen `{ id, input }` rows. Kinds are `identity-only`, `irrelevant-detail`, `paraphrase` and `format`. Cases must belong to the same family/job/split and exact criterion/exclusion set. Source hashes must match, and saved rubric definitions, weights, qualifications and requirement evidence must remain identical; shared criterion IDs alone are insufficient. At least two unchanged repetitions are required. Each scored criterion reports the all-pairs cross-input signed/absolute change and disagreement, separately from unchanged-baseline and unchanged-variant noise. Zero is retained; failures, missing observations and null scores make panels incomplete. Pair kinds do not certify semantic equivalence, and pair counts are not independent samples. This descriptive report never authorizes a release or establishes population fairness.

The report's `noiseFloor` summaries keep each perturbation kind, split and configuration separate. Complete criterion panels contribute cross-input disagreement, greater-than-one change rate and mean absolute difference, minus the average of the two unchanged-input estimates. Criterion panels are averaged within each résumé family and families weighted equally; shared jobs, variants and repeats are not extra independent people. Negative noise-adjusted excess is retained, not clamped. Counts expose incomplete criterion panels separately from incomplete whole comparisons. `configurationComparisons` matches the exact same complete pair/criterion panels in both configurations before comparing noise-adjusted excess. Each contrast reports point estimates and, with at least two contributing families, a reproducible family-cluster percentile interval using 1,000 seeded resamples. With fewer families, uncertainty remains explicitly unavailable.

These estimates are **descriptive**, not acceptance gates or causal claims. Two repeats give a particularly noisy within-source estimate. Complete-panel selection may bias results, and several pairs can share the same original source. Bootstrap intervals do not correct label mistakes, certify evidence equivalence, extrapolate to unseen jobs or adjust for multiple exploratory comparisons. A negative excess or interval spanning zero cannot establish fairness or prove an absence of meaningful effects. Numerical qualification still requires the frozen larger panel, human evidence checks and separate release decision.

Controlled added/removed evidence is a different experiment, not evidence-preserving invariance:

```powershell
node scripts\scoring-evaluation.mjs monotonicity C:\private-evals\suite.json C:\private-evals\observations.json C:\private-evals\evidence-pairs.json C:\private-evals\inputs.json C:\private-evals\monotonicity-report.json
```

Each pair specifies `id`, `weakerCaseId`, `strongerCaseId`, `expectedCriterionIds`, `addedFacts` (`id`, `paragraphId`, exact complete `text`), `origin` (`planted` or `human-reviewed`), `author`, `revision`, `independent` and a nonblank `reason`. The sources must share a family/job/split, unchanged rubric, qualifications, requirement evidence, criterion order, exclusions and resume identity/title/metadata. Each added fact binds one new complete paragraph in the stronger source; deleting exactly those paragraphs must recover every original paragraph's text, heading, page and order. Extraction may renumber paragraph IDs. Undeclared edits, partial quotes, altered targets and stale input hashes are rejected. This deliberately narrow contract does not admit arbitrary paraphrases or contradictory rewrites as additions.

For every scored criterion, the report preserves zero/null distinctions, source hashes, label exposure and complete-panel coverage. It reports all-pairs stronger-minus-weaker deltas, decreases, decreases greater than one anchor, unchanged outcomes, increases and separate unchanged-input repeat noise. Expected supporting criteria identify the declared hypothesis, not a required numeric increase: stronger evidence may legitimately remain at the same anchor. Other criteria are shown for spillover, not automatically treated as unaffected. Insertion and removal are the same contrast with a fixed orientation, not two independent samples. A decrease is an investigation signal, not proof of an incorrect score; incomplete panels and model-exposed fact judgments cannot establish independent monotonicity. No aggregate accuracy, population fairness or release approval is inferred.

To measure whether final criterion citations actually contain annotated facts, separately from source extraction and numeric anchors:

```powershell
node scripts\scoring-evaluation.mjs evidence-selection C:\private-evals\suite.json C:\private-evals\observations.json C:\private-evals\inputs.json C:\private-evals\fact-annotations.json C:\private-evals\final-assessments.json C:\private-evals\evidence-report.json
```

Inputs supply every exact `{ id, input }` case once. Each annotation contains `caseId`, `criterionId`, `inputSha256`, `origin` (`planted` or `human-reviewed`), `author`, `revision`, `independent`, `reason` and `facts`. Each fact group specifies `id`, `role` (`supporting`, `non-supporting` or `contrary`) and one or more equivalent `alternatives` containing a source `paragraphId` and literal `text`. Fact identity, alternative uniqueness and source presence are checked; a group counts once when at least one complete alternative is fully quoted by that criterion. The annotation author judges relevance and equivalence; exact source binding does not independently establish them. Private final assessments supply `{ caseId, configurationId, repetition, assessmentSha256, assessment }` and must match a completed observation, canonical assessment hash, exact source citations, criterion scores and code-calculated total. New production-adapter observations include the optional canonical final `result.assessmentSha256` and bind the artifact's content to that observation. Legacy observations retain their original shape and are explicitly reported as `legacy-score-only`; matching their scores cannot prove identical final evidence. Missing legacy hashes are never filled retrospectively. A prior or intermediate proposal is not a substitute.

Reports separate split, origin, exposure and repetition. Selection precision is **conditional on annotated supporting/non-supporting fact groups**, not all citation prose; unannotated citations remain unknown and contrary-fact coverage is separate. A support-only panel does not estimate practical precision. Full-quote matching is deliberately literal: a partial quote can be relevant but still miss this measurement, and uncited rationale prose is not evidence selection. Completed unscored criteria retain their evidence while being counted as unscored. Missing private assessments, processing failures and absent observations have separate coverage counts and cannot be treated as empty evidence sets, recall errors or successful results. Selecting irrelevant/context evidence is a diagnostic, not proof of a false factual claim or wrong score. This is final-citation fact coverage, not semantic retrieval recall, human accuracy or release qualification.

`gates` applies the frozen engineering targets to two configurations, requires six repeats and at least 20 families/four jobs, and rejects missing/null criterion panels. Human quality requires at least 30 determinate blind human items and paired complete outputs. It checks MAE <=0.5 and conservatively requires the family-clustered upper confidence bound on error increase to be <=0; this is not a claim that 30 checks certify population quality. It always retains `eligibleForRelease: false`: rubric signoff, judge qualification, perturbation/noise-floor experiments, compatible readers and explicit promotion remain external prerequisites. Stable but incorrect scores cannot pass through model agreement alone.

### Versioned targets

`gates` accepts an optional targets version and panels file after the two configuration IDs:

```powershell
node scripts\scoring-evaluation.mjs gates C:\private-evals\suite.json C:\private-evals\observations.json C:\private-evals\human-references.json C:\private-evals\gates-v2.json baseline candidate score-engineering-targets-v2 C:\private-evals\gate-panels.json
```

Without a version, `gates` applies `score-engineering-targets-v1` exactly as before. Target sets are registered in `worker\evals\gates.ts` (`SCORING_ENGINEERING_TARGET_SETS`). A frozen set is never edited; a change gets a new version.

`score-engineering-targets-v2` keeps every v1 threshold and adds the scoring-stability targets. It applies to job and GS grade rubrics:

| Area | Check | Target |
|---|---|---|
| Stability, per target kind | Completion, criterion disagreement, disagreement by more than one level, median overall SD, P95 overall range, incomplete items | The v1 thresholds |
| Coverage, per target kind | Cases, resume families, rubric targets | At least 1 case, 20 families and 4 targets |
| Rubric generation, job and grade | Valid generations across repeats | 100%, with at least 6 repeats of at least 4 sources |
| Reviewer | Verdict flips on fixed proposals (repeats that disagree about whether an issue exists) | At most 10% |
| Reviewer | Planted-defect recall | 100%, with no failed reviews |
| Reviewer | Gap between over-credit and under-credit recall | Set from the baseline |
| Monotonicity | Expected-supporting criteria whose mean score falls, and drops of more than one level | 0 and 0 |
| Invariance | Worst family-mean excess disagreement over unchanged-input noise for identity, format and irrelevant-detail edits | Set from the baseline |
| Cross-model gap | Mean per-criterion and overall gap between two model configurations on the same locked rubric | Set from the baseline |
| Cost and latency | Mean cost per analysis, P95 analysis time | Set from the baseline |

Suites mark GS grade-rubric cases with `targetKind: "grade"`. Cases without it are job cases, so suites frozen earlier keep their hash. Human checks stay pooled across kinds, with at least 30 blind items.

v2 is a **draft** until the recorded baseline fills the thresholds marked "Set from the baseline". A draft never meets the targets: its unset checks report `insufficient` with the note `target-not-frozen`. Freezing sets `status` to `frozen` in the same version before any candidate runs. To explore thresholds, the library also accepts what-if `targets`; reports mark them `targetsRegistered: false`, and they can never meet the targets.

The panels file binds separately produced reports to the configuration they measure. Report and cost paths are relative to the panels file:

```json
{
  "rubricGeneration": [
    { "targetKind": "job", "configurationId": "generator", "report": "rubric-repeatability-job.json" },
    { "targetKind": "grade", "configurationId": "generator", "report": "rubric-repeatability-grade.json" }
  ],
  "fixedJudge": { "configurationId": "reviewer", "report": "judge-report.json" },
  "monotonicity": { "configurationId": "candidate", "report": "monotonicity.json" },
  "invariance": { "configurationId": "candidate", "report": "invariance.json" },
  "crossModel": { "leftConfigurationId": "candidate-mini", "rightConfigurationId": "candidate-luna" },
  "costs": { "attempts": "run\\model-attempts.jsonl", "ledger": "costs\\program.ledger.json" }
}
```

A missing panel leaves its checks `insufficient` with the note `panel-not-supplied`. Costs join each model attempt to its ledger entry; one unpriced attempt makes the mean cost unknown.

## Rubric-generation repeatability

`executeRubricGeneration` measures job-rubric generation separately from scoring. It calls the production `generateGroundedRubric` with the captured `jobRubric` task binding, its correction budget and the production `validateRealRubric` checks. A suite (`rubricRepeatabilitySuiteSchema`) binds each job document hash, real job ID, original content type, configuration settings hash and `score-rubric-generation-v1`. Preflight rejects stale documents, settings, missing prices and other algorithms before paid admission. Responding-model identity and costs use the shared attempt recorder, so a different model version stops the run with an unknown cost. Invalid generations become `failed` observations, never empty rubrics. Their private failure artifact keeps a bounded generator message (for example, the citation or weight check that failed) for diagnosis. `executeRubricRepeatabilitySuite` checkpoints repetition-major so partial runs stay balanced, and resumes only missing generations.

`summarizeRubricRepeatability` binds every completed observation to exactly one private rubric artifact by canonical hash and revalidates it against the frozen document. Criteria align only when they cite overlapping job text: same source paragraph and contained or at least 50% word-overlapping quotes. Labels that merely sound alike do not align. Reports give criterion counts, within-configuration repeat alignment, cited-paragraph Jaccard overlap, aligned weight differences, cross-configuration alignment and optional agreement with saved reference rubrics. Lexical anchor markers count guidance that uses performance-quality wording (supervision, errors, quality, routine, independently) or documentary-evidence wording. These are lexical diagnostics: they do not establish semantic equivalence, requirement coverage, anchor validity or rubric approval. Saved rubrics are comparison artifacts, not human truth. Production rubrics, jobs and historical scores are never rewritten.

A four-job development trial (mini low, Luna low and Luna high, four repeats each) found that regeneration is itself a material source of variation. Within one configuration, typically 30-90% of criteria cited the same job requirement between two repeats, and criterion counts varied by up to three. Different models overlapped less (about 25-60%). Two generations rejected a position description as "not a job posting". On the longest job document, exact-quote validation failed for most mini and Luna-low attempts, even after the allowed correction, while Luna high completed every attempt. Treat a saved job rubric as part of the scoring configuration: compare analyses only when they use the same saved rubric, and do not regenerate rubrics to "retry" a score. These are lexical development measurements on four documents, not a model selection or a validated rubric quality ranking.

### Running rubric and grade generation panels

`scripts\scoring-evaluation-run.mjs` also runs generation panels, with the same identity, deadlines, cost ledger and resumable checkpoints as scoring runs:

- A `"kind": "rubric-generation"` manifest supplies a `rubricRepeatabilitySuiteSchema` suite, `documents` (`[{ "sourceId", "document" }]`), `settings`, `prices` and an explicit `createdAt`.
- A `"kind": "grade-generation"` manifest supplies a `gradeGenerationSuiteSchema` suite (`score-grade-generation-v1`), `fixtures` (`[{ "sourceId", "fixture": { "ladder", "seed", "sourceSet", "documents" } }]`) and the same other fields. A fixture is a privately frozen copy of one confirmed ladder: its record, captured seed job and rubric, confirmed source set and extracted reference documents.

Preflight checks every frozen source hash, task binding, model version and price before any paid call. Each completed job writes a private `<hash>.rubric.json` or `<hash>.grades.json` artifact next to `observations.json`; failures keep a bounded private reason.

```powershell
node scripts\scoring-evaluation-run.mjs C:\private-evals\rubric-generation.json C:\private-evals\runs\rubrics --confirm-paid-inference
node scripts\scoring-evaluation.mjs rubric-report C:\private-evals\rubric-generation.json C:\private-evals\runs\rubrics C:\private-evals\reports\rubric-repeatability-job.json
node scripts\scoring-evaluation.mjs grade-report C:\private-evals\grade-generation.json C:\private-evals\runs\grades C:\private-evals\reports\rubric-repeatability-grade.json
```

Grade generation plans one competency set per repetition, then drafts every requested grade and runs the independent grade review on each draft. A grade counts as a valid generation only when its draft passes validation **and** the review returns `supported`; `needs-sources` outcomes and failures are counted separately. A broken frozen fixture stops the run instead of being recorded as a model failure. Report cells are one per job document, or one per ladder grade (`<ladder>:gs-<grade>`), and are the `rubricGeneration` panel inputs for `score-engineering-targets-v2`. Reports must be written outside the private run directory.

`createEvaluationSettings` accepts optional `tasks` bindings for `jobRubric`, `gradeCompetencies`, `gradeDraft` and `gradeReview`. Without them it produces exactly the same snapshot as before.

## Executor contract

Large offline scoring suites can be partitioned into bounded private runner manifests without buying inference:

```powershell
node scripts\scoring-evaluation.mjs prepare-shards C:\private-evals\manifest.json C:\private-evals\shards
node scripts\scoring-evaluation.mjs merge-shards C:\private-evals\shards\index.json C:\private-evals\shard-checkpoints.json C:\private-evals\merged.json
```

`prepare-shards` validates every exact source and captured model/configuration first. Each shard has at most the existing QC `planCases` limit (25) and each complete output manifest is checked against the existing 16-MiB artifact ceiling. Whole resume families stay together; a family larger than 25 cases must be explicitly narrowed, not silently split or truncated. Every parent case appears exactly once and keeps its split, saved exclusions and configuration. All shard manifests share the original `programId` and one explicit cost directory. Run them sequentially with the paid runner's existing shared program lock; these files do not create distributed ownership or permit overlapping writers. Output manifests and the final `index.json` are immutable; exact repeated preparation recovers partial writes, while changed existing bytes/content are rejected.

`shard-checkpoints.json` is an array of `{ "shardId": "<index shard id>", "suiteSha256": "<index shard hash>", "observations": [...] }` using the saved scoring observations from each shard. Provide at most one current prefix per shard. Merge validates the parent/index, exact partition, all source/configuration-derived shard hashes and every observation **before** rebinding validated observations to the parent suite hash. Missing shards, incomplete prefixes, failed comparisons and null criterion scores remain distinct. Its `complete` means all expected observations were recorded, not successful scoring or release readiness. `merged.json.observations` can feed the ordinary parent-suite reports/gates; the wrapper also contains shard-level coverage. Fixed-judge manifests require their proposal-bound executor and are rejected by this scoring-only partitioner.

These partitions mirror the current QC limits but are **not** saved `QcCasePack`s or admitted improvement plans. They do not bypass the QC plan requirement for actual submitted drafting feedback, alter legacy artifact shapes, create workspace authorization, or implement the unfinished hosted/QC lifecycle integration.

`executeScoringSuite` accepts an explicit callback and checkpoint writer. The caller owns:

- Verifying source and settings hashes, complete-source input validation and production-module invocation.
- Pricing/usage capture before paid requests, explicit paid-work admission and infrastructure quotas.
- Deadlines, cancellation, durable exclusive claims and atomic checkpoint writes.
- Converting known model/processing failures to structured failed observations without fabricating scores.

The executor runs at concurrency 1-8, passes cancellation, validates each observation before checkpointing and skips already recorded repetitions. It drains in-flight callbacks on failure before returning. Unexpected exceptions and checkpoint failures propagate, stopping further admission. Failed observations are not automatically rebought; an explicitly admitted follow-up suite is needed for a retry experiment. Use one exclusive owner of a suite checkpoint; this in-process executor is not a distributed lease service.

New paid-runner directories also bind startup fingerprints for the runner, compiled evaluation bundle, dependency lock, Node version, endpoint, prices and suite in `execution.json`. New bound runs archive exact runner/bundle/lock bytes privately under `execution-files`; existing archive files are verified, never overwritten. These are provenance copies, not an automatically executable environment with all dependencies. Resume refuses changed bindings rather than mixing implementations under one algorithm label. Fingerprints record startup files, not identical stochastic outputs or immutable service weights. Completed legacy observations can be read without new inference but remain `legacy-unverified`; partial legacy runs cannot silently resume under newer code. Keep their paid attempts and use a separately versioned, audited follow-up.

The paid runner bounds the batch with `maxDurationMilliseconds` (default four hours) and each comparison with `maxComparisonMilliseconds` (default 15 minutes). Values must be 1000-86400000 milliseconds. Deadline expiry aborts admission without fabricating a score; saved successful prefixes and all captured paid attempts remain available. An interrupted uncheckpointed request may be rebought on an explicitly resumed run, so reconcile ambiguous charges rather than assuming exactly-once inference.

Identity is explicit deployment configuration, never a feature switch. Local manifests default to `identity: { "kind": "azure-cli" }` and may specify a tenant UUID. Hosted manifests require `identity: { "kind": "managed-identity", "clientId": "<UUID>" }`; credentials are acquired only for the existing model transport scope. The runner does not create identities, grant roles, embed tokens, or provision compute. Managed identity construction can be checked offline, but a real hosted identity/resource boundary still requires scoped provisioning and live readiness verification.

## Compatible product admission controls

Existing human QC and evidence-correction features now have optional Admin switches: `features.qcReviews` and `features.analysisEvidenceCorrections`. They default on when absent without changing the compiled legacy baseline or materializing keys in old revisions/captures. Field metadata supplies the visible default; only explicit administrator edits persist a key. Availability combines deployment capability, the switch and runtime/new-work readiness in `effectiveFeatures`, with the same policy enforced by mutation handlers. QC browser controls follow `/api/features`; historical QC context, feedback, peer-exposure audits and cancellation remain available even when current policy cannot be read. A failed public-policy read is reported explicitly and disables only new changes.

These controls govern existing product operations, **not** the evidence-first candidate or an automatic disagreement queue. Accepted corrections, QC trials and their pinned readers keep their captured policy; no current switch rewrites earlier evidence or results. Reader compatibility still requires deploying the API and all five workers together through `scripts/deploy.ps1` before an administrator saves a new key. Do not roll workers back to builds that reject those keys.

## Costs and $100 milestones

Amounts are integer USD microdollars (`100000000` means $100). Use versioned applicable prices, not guessed rates. Prompt totals include cache reads and writes. For separately metered writes, subtract both from ordinary input and price each separately. Positive writes without an applicable write rate, or missing required cache counts, produce unknown cost rather than a guessed zero. A verified `cacheWriteBilling: "included-in-input"` tariff instead charges all non-read input at the ordinary input rate: its cost does not depend on a separate write count, which remains unknown when omitted. Never infer that tariff solely from missing usage. Output includes reasoning, which must not be charged twice; missing reasoning details do not hide otherwise known output charges. Missing usage/cost is null and increments the unknown-cost count.

The paid runner uses a program-wide ledger under `costDirectory` (default: `costs` beside its run directory), keyed by the hashed `programId`. Keep one program ID and cost directory across suites. An exclusive program lock prevents concurrent writers; run-level observations and attempts remain separate. Older per-run ledgers require explicit reconciliation into the program ledger before claiming cumulative spend. The offline `costs` command must not run against state while its paid-runner program lock is held.

Ledger events identify a logical cost item and its suite/category. One actual settlement replaces that item's estimate. Give separate transport attempts separate cost-item IDs; do not treat ambiguous billed attempts as free. Split aggregate Azure bills into nonoverlapping attributable cost items before reconciliation.

Initial private state:

```json
{
  "schemaVersion": 1,
  "programId": "score-quality",
  "reportedThroughUsdMicros": 0,
  "pending": []
}
```

`costs` advances the durable high-water mark and prints pending notification receipts at every crossed $100 threshold. A batch crossing $100, $200 and $300 creates all three receipts. Re-running does not create duplicate receipts; billing reconciliation cannot move the mark backwards.

This is an outbox, not a configured message delivery service. `reportedThroughUsdMicros` means a notification has been generated, not that a human received it. Unknown charges and unbilled estimates must accompany notices. No hard spending cap is implied.

After a notice has actually been delivered, the operator can record that delivery explicitly:

```powershell
node scripts\scoring-evaluation.mjs costs-ack C:\private-evals\costs\<program-hash>.state.json C:\private-evals\delivered-notice.json C:\private-evals\costs\delivery-receipts
```

The delivery input has this shape:

```json
{
  "schemaVersion": 1,
  "programId": "score-quality",
  "deliveredAt": "2026-10-07T12:00:00Z",
  "channel": "copilot-session",
  "deliveryReference": "The actual delivered message or operator record identifier",
  "milestones": [
    { "id": "score-quality-100000000", "thresholdUsdMicros": 100000000 }
  ]
}
```

Channels are `copilot-session` or `operator`. Copy only actually delivered IDs/thresholds from the pending outbox; do not create an acknowledgment from console output alone. The command uses the same state/program lock as the runner, rejects unknown notices, cross-program records and future delivery timestamps, archives an immutable content-hashed `.delivery.json` record **before** clearing the selected pending notices, and preserves the high-water mark. Exact replay recovers a crash between archiving and state publication without creating another receipt; changed archived content is rejected. Undelivered notices remain pending, including when a later bill reduces the estimated total. The command records an operator assertion, does not itself send a message, and cannot establish human receipt. A hosted automatic notifier and actual billing reconciliation remain separate unfinished integrations.

Cost tracking applies to explicitly supplied evaluation ledger events only. It is not yet wired to production inference, Azure billing exports or a chat notification channel. Reconstruct earlier investigation spend separately from new evaluation spend.

## Remaining program gates

Technical smoke trials can establish execution, not accuracy or fairness. Before model selection or production changes, complete independent reference generation, human calibration, four rubric signoffs, repeat panels, paired perturbation tests and release gates. Evaluate extraction and rubric generation separately from assessment and fixed-assessment review. Compare Luna, Terra and Sol by task with verified deployment/version/effort bindings; unsupported bindings fail before paid admission.

Evidence-first search is restricted to the supplied source. Retrieval must recover supporting and contradictory context before declaring evidence absent; it is not internet enrichment. Preserve exact source-passages and code-owned weighted totals.

Only a measured candidate can change internal scoring resolution. No score averaging, higher-score preference, repeated rejection until a lower score is accepted, historical rescore or new mandatory user disagreement flag is introduced here.

Use scale-to-zero Container Apps Jobs provisionally for trusted evaluations, comparing all-in VMSS costs before provisioning. Standard public Score CI remains on free GitHub-hosted runners. Separate evaluation deployment names allocate rate limits, not independent model judgment or extra subscription quota.

Later product controls must use compatible optional Admin settings fields and `effectiveFeatures`, not environment feature switches. Existing saved settings, snapshots and QC artifact versions remain unchanged.
