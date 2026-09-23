export const LEGACY_MODEL_TASK_IDS = [
  'jobRubric', 'resumeProfile', 'gradeCompetencies', 'gradeDraft', 'gradeReview',
  'assessment', 'assessmentReview', 'candidateSummary', 'targetSummary', 'summaryReduction', 'summaryReview',
] as const
export const MODEL_TASK_IDS = [...LEGACY_MODEL_TASK_IDS, 'qcPlan'] as const
