export interface AccessConfig {
  readonly container: string
  readonly servicePrincipalId: string
}

export interface CreationGrant {
  readonly id: string
  readonly tenantId: string
  readonly userId: string
  readonly canCreateWorkspaces: boolean
}

export interface AccessAudit {
  readonly id: string
  readonly tenantId: string
  readonly actorId: string
  readonly targetId: string
  readonly action: string
  readonly previous: string | boolean | null
  readonly next: string | boolean | null
  readonly createdAt: string
}

export interface AccessStore {
  getGrant(tenantId: string, userId: string): Promise<{ grant: CreationGrant; etag: string } | undefined>
  setGrant(grant: CreationGrant, expectedEtag: string | undefined, audit: AccessAudit): Promise<void>
}
