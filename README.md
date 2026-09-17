# Score

A jobs-first workspace for comparing resumes against clear criteria, with every score connected to its supporting evidence.

**This is an interactive UI prototype, not a production evaluator.** Job descriptions, resumes, GS rubrics, and scores are fictional examples. There is no LLM, document parser, crawler, or backend.

## Run locally

Use Node.js 20.19+ or 22.12+ and npm.

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite, normally `http://127.0.0.1:5173`.

```powershell
npm run build
npm run lint
npm run preview
```

The application uses React 18, TypeScript, Vite, Tailwind CSS, React Router, and accessible Radix dialog primitives. Styling is custom: restrained glass surfaces, a warm light theme, and a charcoal dark theme. Theme colors are centralized in `index.html` as Clawpilot CSS variables. Light, Dark, and System preferences are supported; the host's `scoutTheme` query parameter takes precedence when supplied.

## Explore the workflow

1. **Jobs:** Inspect a job beside its linked rubric. Add individual or batch PDF sources, direct URLs, or simulated website discoveries. The OPM preset and discovery-depth controls produce sample findings, not live postings.
2. **Resumes:** Browse fictional profiles, preview their documents, select several, or simulate a batch import.
3. **Rubrics:** Review job-specific criteria and reusable GS grade rubrics. Edit descriptions, scoring guidance, and weights. Weights must total 100; saving creates a new version.
4. **Analyses:** Select resumes and job rubrics, standalone grade rubrics, or both. Each resume/target pairing gets a separate result.
5. **Evidence:** Open a comparison to inspect 0-5 criterion scores, a weighted 0-100 overall score, an explanation, and exact resume citations. Citation buttons locate the quoted passage in the saved document snapshot.

Use the import and analysis **Demo scenario** controls to explore failures, partial results, cancellation, and retry. Successful items remain available when another item fails.

New custom criteria have no fixture assessment. They are explicitly marked not assessed, and the overall score is withheld rather than invented. Other mock scores follow synthetic evidence profiles; editing criterion wording does not invoke a real assessment.

GS examples are illustrative, not official OPM guidance or eligibility determinations. Missing resume evidence does not prove a person lacks a skill. Do not use these demo scores to make employment decisions.

## Local storage and privacy

The prototype reads selected file **names**, not PDF contents. It never uploads files, fetches submitted URLs, or sends documents to an AI service. Imported records explicitly use fictional replacement content. Source links can be opened manually in a separate tab.

Demo records, source labels, rubric edits, and analysis snapshots are stored under `score-demo-workspace-v1` in this browser's local storage. Theme preference uses `score-theme`. Real selected document bytes are never read or stored.

**Reset demo workspace** replaces only Score's synthetic workspace, after confirmation. It keeps theme preference and unrelated browser data. A storage failure is shown explicitly with a retry action. Corrupt or unsupported saved data is not silently replaced; the recovery screen offers a reset.

Reloading during a simulation recovers unfinished work into an explicit interrupted/cancelled state that can be retried. Historical results retain their original rubric and document snapshots even after later edits.

## Code organization

| Directory | Responsibility |
| --- | --- |
| `src\app` | Navigation, themes, shared workspace state, and operation lifecycles |
| `src\components` | Accessible UI primitives and source document/citation viewing |
| `src\domain` | Typed documents, jobs, rubrics, resumes, and analysis snapshots |
| `src\data` | Coherent fictional fixtures |
| `src\services` | Deterministic mock operations and validated local persistence |
| `src\features` | Jobs, resumes, rubrics, and analysis screens |
| `src\styles` | Token-based visual system and responsive layouts |

Live PDF extraction/OCR, Playwright/Chromium ingestion, model-generated rubrics, production scoring, authentication, and multi-user storage are deliberately deferred. The typed service boundary is the replacement point for those future integrations.

When hosting the built `dist` directory, configure SPA fallback to `index.html` so direct links to job, rubric, and analysis routes work.
