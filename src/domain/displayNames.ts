export const DISPLAY_NAME_MAX_LENGTH = 160

export function normalizeDisplayName(value: string): string {
  if (typeof value !== 'string') throw new Error('Display name must be text.')
  if (/[\p{Cc}\u2028\u2029]/u.test(value)) throw new Error('Display name must not contain control characters or line breaks.')
  const normalized = value.trim()
  if (!normalized) throw new Error('Display name must not be empty.')
  if (normalized.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new Error(`Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`)
  }
  return normalized
}

export function getDisplayName(value: { displayName?: string }, original: string): string {
  return value.displayName ?? original
}

export function defaultAnalysisName(resumeCount: number, targetLabels: readonly string[]): string {
  const count = Number.isFinite(resumeCount) ? Math.max(0, Math.floor(resumeCount)) : 0
  const resumes = `${count} ${count === 1 ? 'resume' : 'resumes'}`
  if (targetLabels.length === 1) {
    const label = targetLabels[0].replace(/[\p{Cc}\u2028\u2029]/gu, ' ').trim() || 'Selected target'
    const suffix = ` - ${resumes}`
    // Do not split a Unicode character at the title-length boundary.
    const prefix = label.slice(0, DISPLAY_NAME_MAX_LENGTH - suffix.length).replace(/[\uD800-\uDBFF]$/u, '').trimEnd()
    return `${prefix}${suffix}`
  }
  return targetLabels.length ? `${resumes} - ${targetLabels.length} targets` : `${resumes} - select targets`
}
