import type { PipelineDetail } from '../../../domain/quality-pipeline'
import type { QcPromptFamily } from '../../../domain/quality-improvement'

export const PIPELINE_STAGES = ['Evidence', 'Curate', 'Candidate', 'Evaluate', 'Activate', 'Future work'] as const
export const TASK_LABELS: Record<QcPromptFamily, string> = {
  jobRubric: 'Job rubric generation', gradeCompetencies: 'GS competency generation',
  gradeDraft: 'GS rubric drafting', assessment: 'Analysis assessment',
}
export const PIPELINE_NODES = [
  { id: 'results', column: 0, row: 1, title: 'Saved comparisons', description: 'Original results and frozen evidence.', detail: 'Start with an exact saved comparison, not today\'s documents or rubric. QC opinions never replace that published score.' },
  { id: 'feedback', column: 0, row: 2, title: 'Human QC reviews', description: 'Attributable submitted opinions.', detail: 'Reviewers record agreement, disagreement, or inability to judge. Opinions stay separate; popularity does not become ground truth.' },
  { id: 'sources', column: 0, row: 3, title: 'Job & GS source context', description: 'Saved rubrics and source references.', detail: 'Cases retain their original job or grade rubric and supporting evidence. New uploads do not automatically change saved rubrics or train a model.' },
  { id: 'curate', column: 1, row: 2, title: 'Curate exact cases', description: 'Choose feedback and case purposes.', detail: 'Explicitly include or exclude permitted submitted reviews. Keep drafting and holdout cases distinct, and preserve disagreements and curation choices.' },
  { id: 'pack', column: 1, row: 3, title: 'Frozen case pack', description: 'Evidence, reviews, and saved settings.', detail: 'The immutable case pack binds the exact selected results and reviews. The map shows its digest without downloading private source documents.' },
  { id: 'candidate', column: 2, row: 2, title: 'Guidance candidate', description: 'Drafting evidence; generalized guidance.', detail: 'A human can edit reusable task guidance. Private quotations, names, and reviewer prose must not become app-wide instructions. A proposal is not an activated bundle.' },
  { id: 'tasks', column: 2, row: 3, title: 'Affected AI tasks', description: 'Which guidance families could change.', detail: 'Only these four task-guidance families are editable through QC. A task relationship describes potential effects, not proof that a particular run used the candidate.' },
  { id: 'settings', column: 2, row: 4, title: 'Captured models & settings', description: 'The accepted baseline, not today\'s defaults.', detail: 'Trials retain the accepted model and processing settings. Ordinary settings publication is a separate workflow; it does not automatically pass through this map.' },
  { id: 'holdout', column: 3, row: 1, title: 'Holdout cases', description: 'Evaluation only, never planner drafting.', detail: 'Held-out evidence and human labels do not enter candidate planning. Trial models receive evidence and guidance, never reviewer opinions or curator reference decisions.' },
  { id: 'evaluation', column: 3, row: 2, title: 'Baseline vs candidate', description: 'Same frozen inputs and model settings.', detail: 'An explicit paid request compares the exact baseline and candidate. Saved outcomes are not population accuracy claims, automatic approval, or a new production assessment.' },
  { id: 'checks', column: 3, row: 3, title: 'Fixed validation & grounding', description: 'Protected contracts, not editable guidance.', detail: 'Citation, schema, scoring, privacy, qualification, and independent-grounding contracts remain fixed. Failed trials are failures, not successful zero scores.' },
  { id: 'activate', column: 4, row: 2, title: 'Admin review & activate', description: 'Explicit decision on the evaluated version.', detail: 'A member application admin reviews the exact trial and explicitly activates with a reason. The native action rechecks baseline, settings, lifecycle, and authorization. Score has no additional independent-approval stage.' },
  { id: 'active', column: 5, row: 2, title: 'Active prompt bundle', description: 'Current pointer, separate from a candidate.', detail: 'Activation publishes immutable guidance and an audit record. A previously activated candidate may no longer be the current bundle. Restoration is a separate authorized, audited action.' },
  { id: 'future', column: 5, row: 3, title: 'Future accepted work', description: 'Existing scores keep their saved versions.', detail: 'Activated guidance changes defaults for newly accepted work only. Saved scores, rubrics, accepted work, and ordinary retries retain their captured versions. This map never starts an analysis.' },
] as const
export type PipelineNodeId = typeof PIPELINE_NODES[number]['id']
export const PIPELINE_EDGES: { from: PipelineNodeId; to: PipelineNodeId; kind?: 'context' | 'future'; upper?: boolean }[] = [
  { from: 'results', to: 'curate' }, { from: 'feedback', to: 'curate' },
  { from: 'sources', to: 'pack' }, { from: 'curate', to: 'pack' },
  { from: 'pack', to: 'candidate' }, { from: 'pack', to: 'holdout', upper: true },
  { from: 'candidate', to: 'tasks' }, { from: 'candidate', to: 'evaluation' },
  { from: 'holdout', to: 'evaluation' }, { from: 'settings', to: 'evaluation', kind: 'context' },
  { from: 'checks', to: 'evaluation', kind: 'context' }, { from: 'evaluation', to: 'activate' },
  { from: 'activate', to: 'active' }, { from: 'active', to: 'future', kind: 'future' },
]
export function isPipelineNode(value: string | null): value is PipelineNodeId {
  return PIPELINE_NODES.some(node => node.id === value)
}
export function savedPipelineEdges(detail: PipelineDetail | null, currentBundleId?: string | null): Set<string> {
  const saved = new Set<string>()
  if (!detail) return saved
  const add = (from: PipelineNodeId, to: PipelineNodeId) => saved.add(`${from}:${to}`)
  if (detail.cases.length) {
    add('results', 'curate'); add('sources', 'pack'); add('curate', 'pack')
  }
  if (detail.cases.some(item => item.includedReviews > 0)) add('feedback', 'curate')
  if (detail.changedFamilies.length) { add('pack', 'candidate'); add('candidate', 'tasks') }
  if (detail.cases.some(item => item.purpose === 'holdout')) add('pack', 'holdout')
  if (detail.evaluation) {
    add('candidate', 'evaluation'); add('settings', 'evaluation'); add('checks', 'evaluation')
    if (detail.evaluation.holdoutTrials) add('holdout', 'evaluation')
  }
  if (detail.activatedBundleId) add('evaluation', 'activate')
  if (detail.activatedBundleId && detail.activatedBundleId === currentBundleId) add('activate', 'active')
  return saved
}
export function pipelineNextStep(detail: PipelineDetail | null): string {
  if (!detail) return 'Choose a saved improvement plan to inspect its next decision.'
  switch (detail.plan.status) {
    case 'planning': return 'QC worker: finish the explicitly requested planning work.'
    case 'evaluating': return 'QC worker: finish the explicitly requested paired trials.'
    case 'ready': return detail.evaluation?.eligibleAtCompletion
      ? 'Member application admin: inspect the exact evaluation before activation.'
      : 'Plan author: inspect the saved trial findings before another evaluation.'
    case 'activated': return 'Application admin: inspect the saved activation and current pointer.'
    case 'failed': return 'Plan author: inspect the failure before an explicit retry.'
    case 'cancelled': return 'Plan author: decide whether to explicitly retry cancelled work.'
    case 'invalidated': return 'Plan author: create a new plan from retained, authorized evidence.'
    case 'draft': return detail.changedFamilies.length
      ? 'Plan author: review the proposal before explicitly requesting paid evaluation.'
      : 'Plan author: inspect the frozen cases and prepare a generalized proposal.'
  }
}
