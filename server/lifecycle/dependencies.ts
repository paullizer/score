import type { LifecycleBlocker } from '../../src/domain/lifecycle'
import type { RealJobsDeps } from '../jobs/routes'
import type { RealGradesDeps } from '../grades/service'
import type { LifecycleDependencies } from './contracts'
import type { RealAnalysesDeps } from '../analyses/store'

/** Deletions are never blocked by retained analyses or seed ladders. */
export function createLifecycleDependencies(
  _jobs?: RealJobsDeps,
  _grades?: RealGradesDeps,
  _requireGrades?: boolean,
  _analyses?: RealAnalysesDeps,
  _requireAnalyses?: boolean,
): LifecycleDependencies {
  void [_jobs, _grades, _requireGrades, _analyses, _requireAnalyses]
  return {
    async impact(): Promise<LifecycleBlocker[]> {
      return []
    },
  }
}
