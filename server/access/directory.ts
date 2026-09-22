import type { EligibleUser, EligibleUserPage } from '../../src/domain/access'

export interface EligibleUserDirectory {
  search(query: string, continuation?: string): Promise<EligibleUserPage>
  get(userId: string): Promise<EligibleUser | undefined>
}
