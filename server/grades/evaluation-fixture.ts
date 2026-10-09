import type { AuthenticatedPrincipal } from '../auth'
import type { WorkspaceRepository } from '../repository'
import type { GradeGenerationFixture } from '../../worker/evals/grade-generation'
import { GradeService, type RealGradesDeps } from './service'

/** Local maintenance tooling only: no API route, model calls or writes to the application. */
export async function captureGradeGenerationFixture(
  repository: WorkspaceRepository, grades: RealGradesDeps, principal: AuthenticatedPrincipal,
  workspaceId: string, ladderId: string,
): Promise<GradeGenerationFixture> {
  await repository.authorizeWorkspace(principal, workspaceId, 'members')
  const fixture = await new GradeService(grades).generationFixture(workspaceId, ladderId)
  await repository.authorizeWorkspace(principal, workspaceId, 'members')
  return fixture
}
