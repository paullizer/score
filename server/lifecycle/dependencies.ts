import type { LifecycleBlocker, LifecycleTarget } from '../../src/domain/lifecycle'
import { gradeHeadId } from '../../src/domain/real-grades'
import type { RealJobsDeps } from '../jobs/routes'
import type { RealGradesDeps } from '../grades/service'
import type { StateStore } from '../store'
import { decodeWorkspace } from '../repository'
import { unavailable } from '../errors'
import type { LifecycleDependencies } from './contracts'

export function createLifecycleDependencies(
  state: StateStore,
  jobs?: RealJobsDeps,
  grades?: RealGradesDeps,
  requireGrades = false,
): LifecycleDependencies {
  return {
    async impact(workspaceId: string, target: LifecycleTarget): Promise<LifecycleBlocker[]> {
      if (requireGrades && !grades && (target.kind === 'job' || target.kind === 'rubric')) {
        throw unavailable('The grade store is unavailable, so seed-ladder dependencies could not be checked.')
      }
      const entry = await state.getState(workspaceId)
      if (!entry) throw unavailable('The saved analyses could not be checked. Nothing has been deleted.')
      const workspace = decodeWorkspace(entry.content)
      const groups = new Set([target.id])
      if (target.kind === 'job') {
        for (const rubric of workspace.rubrics) if (rubric.jobId === target.id) groups.add(rubric.groupId)
        if (jobs) for (const rubric of await jobs.store.listRubrics(workspaceId, target.id)) groups.add(rubric.groupId)
      }
      if (target.kind === 'rubric') {
        for (const rubric of workspace.rubrics) if (rubric.id === target.id || rubric.groupId === target.id) groups.add(rubric.groupId)
        const real = jobs ? await jobs.store.getRubric(workspaceId, target.id) : undefined
        if (real) groups.add(real.groupId)
      }
      if (target.kind === 'ladder') {
        for (let grade = 1; grade <= 15; grade++) groups.add(gradeHeadId(target.id, grade))
      }
      const blockers: LifecycleBlocker[] = workspace.runs.filter(run => {
        if (target.kind === 'workspace') return true
        if (target.kind === 'resume') return run.resumes.some(item => item.resume.id === target.id)
        if (target.kind === 'analysis') return false
        return run.targets.some(item => (
          target.kind === 'job' && (item.job?.id === target.id || item.rubric.jobId === target.id)
        ) || groups.has(item.rubric.groupId) || groups.has(item.rubric.id))
      }).map(run => ({ kind: 'analysis', id: run.id, name: run.name, href: `/analyses/${encodeURIComponent(run.id)}` }))

      if (grades && (target.kind === 'job' || target.kind === 'rubric')) {
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
      return blockers
    },
  }
}
