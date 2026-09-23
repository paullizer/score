import type { LifecycleBlocker, LifecycleTarget } from '../../src/domain/lifecycle'
import type { RealJobsDeps } from '../jobs/routes'
import type { RealGradesDeps } from '../grades/service'
import { unavailable } from '../errors'
import type { LifecycleDependencies } from './contracts'
import type { RealAnalysesDeps } from '../analyses/store'
import { realAnalysisDependencyBlockers } from '../analyses/library-lifecycle'

/** Retained-dependency checks against the real feature stores only. */
export function createLifecycleDependencies(
  jobs?: RealJobsDeps,
  grades?: RealGradesDeps,
  requireGrades = false,
  analyses?: RealAnalysesDeps,
  requireAnalyses = false,
): LifecycleDependencies {
  return {
    async impact(workspaceId: string, target: LifecycleTarget): Promise<LifecycleBlocker[]> {
      if (requireAnalyses && !analyses) {
        throw unavailable('The analysis store is unavailable, so retained analysis dependencies could not be checked.')
      }
      if (requireGrades && !grades && (target.kind === 'job' || target.kind === 'rubric')) {
        throw unavailable('The grade store is unavailable, so seed-ladder dependencies could not be checked.')
      }
      const blockers: LifecycleBlocker[] = []
      if (grades && (target.kind === 'job' || target.kind === 'rubric')) {
        const groups = new Set([target.id])
        if (target.kind === 'rubric') {
          const real = jobs ? await jobs.store.getRubric(workspaceId, target.id) : undefined
          if (real) groups.add(real.groupId)
        }
        let continuationToken: string | undefined
        const tokens = new Set<string>()
        do {
          const page = await grades.store.list(workspaceId, { recordType: 'grade-ladder', limit: 100, continuationToken })
          for (const item of page.items) {
            if (item.record.recordType !== 'grade-ladder' || item.record.workspaceId !== workspaceId) {
              throw unavailable('The ladder dependency query returned invalid ownership.')
            }
            const ladder = item.record
            let matches = target.kind === 'job' ? ladder.seedJobId === target.id : groups.has(ladder.seedRubricId)
            if (!matches && target.kind === 'rubric' && jobs) {
              const seedVersions = await jobs.store.listRubrics(workspaceId, ladder.seedJobId)
              matches = seedVersions.some(rubric => rubric.id === ladder.seedRubricId &&
                rubric.version === ladder.seedRubricVersion && groups.has(rubric.groupId))
            }
            if (matches) blockers.push({
              kind: 'ladder', id: ladder.id, name: ladder.name, href: `/grade-ladders/${encodeURIComponent(ladder.id)}`,
            })
          }
          continuationToken = page.continuationToken
          if (continuationToken && tokens.has(continuationToken)) throw unavailable('Ladder dependency pagination did not advance.')
          if (continuationToken) tokens.add(continuationToken)
        } while (continuationToken)
      }
      if (analyses) blockers.push(...await realAnalysisDependencyBlockers(analyses, workspaceId, target))
      return blockers
    },
  }
}
