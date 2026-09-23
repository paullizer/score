import type { Rubric } from './types'

const WEIGHT_TOLERANCE = 0.000001

/** Editor-side checks shared by every rubric edit before it is sent to the server. */
export function validateRubric(rubric: Rubric): string[] {
  const errors: string[] = []
  if (!rubric.name.trim()) errors.push('Give the rubric a name.')
  if (!rubric.description.trim()) errors.push('Add a rubric description.')
  if (!rubric.criteria.length) errors.push('Add at least one criterion.')

  const ids = new Set<string>()
  rubric.criteria.forEach((criterion, index) => {
    const label = `Criterion ${index + 1}${criterion.label.trim() ? ` (${criterion.label})` : ''}`
    if (!criterion.id.trim()) errors.push(`${label} needs an ID.`)
    if (ids.has(criterion.id)) errors.push(`${label} has a duplicate criterion ID.`)
    ids.add(criterion.id)
    if (!criterion.label.trim()) errors.push(`${label} needs a label.`)
    if (!criterion.description.trim()) errors.push(`${label} needs a description.`)
    if (!criterion.guidance.trim()) errors.push(`${label} needs score guidance.`)
    if (!Number.isFinite(criterion.weight) || criterion.weight < 0 || criterion.weight > 100) {
      errors.push(`${label} must have a finite weight between 0 and 100.`)
    }
  })

  const total = rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  if (!Number.isFinite(total) || Math.abs(total - 100) > WEIGHT_TOLERANCE) {
    errors.push(`Criterion weights must total 100; the current total is ${Number.isFinite(total) ? Number(total.toFixed(6)) : 'invalid'}.`)
  }
  return errors
}