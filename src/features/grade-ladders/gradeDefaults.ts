import type { GradeContext } from '../../domain/real-grades'
import type { PublicSettings } from '../../domain/admin-settings'

export function initialGradeContext(settings?: PublicSettings | null, seed?: { series: string; organization: string }): GradeContext {
  const defaults = settings?.grades.defaults
  return {
    series: seed && /^\d{4}$/.test(seed.series) ? seed.series : '',
    agency: seed?.organization.trim() || defaults?.agency || '',
    agencyType: defaults?.agencyType ?? 'unknown', supervision: defaults?.supervision ?? 'unknown',
    functions: [...(defaults?.functions ?? [])], specialty: defaults?.specialty ?? '',
    confirmed: false, answers: {},
  }
}

export function initialGradeLevels(settings?: PublicSettings | null): number[] {
  return [...(settings?.grades.defaults.levels ?? [])].filter(grade => grade >= 1 && grade <= 15 && settings?.grades.allowedLevels.includes(grade))
}
