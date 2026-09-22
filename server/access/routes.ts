import { Router } from 'express'
import { z } from 'zod'
import { invalidRequest, unavailable } from '../errors'
import { getPrincipal } from '../request-context'
import type { EligibleUserDirectory } from './directory'
import { CreationAccessService, requireApplicationAdmin, WorkspaceAccessService } from './service'

const lookupQuery = z.strictObject({
  query: z.string().max(160).default(''),
  continuation: z.string().min(1).max(4096).optional(),
})
const creationBody = z.strictObject({ canCreateWorkspaces: z.boolean() })
const memberBody = z.strictObject({ role: z.enum(['owner', 'editor', 'viewer']) })

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw invalidRequest('The access request contains missing, invalid, or unexpected fields.')
  return result.data
}

export function createAccessRouter(creation: CreationAccessService, workspaces: WorkspaceAccessService,
  users: EligibleUserDirectory | undefined): Router {
  const router = Router()
  const lookup = () => {
    if (!users) throw unavailable('The Entra directory is not configured. An administrator must complete directory consent.')
    return users
  }
  router.get('/admin/users', async (req, res) => {
    requireApplicationAdmin(getPrincipal(req))
    const query = parse(lookupQuery, req.query)
    res.json(await lookup().search(query.query, query.continuation))
  })
  router.get('/admin/users/:userId/workspace-creation', async (req, res) => {
    const result = await creation.read(getPrincipal(req), req.params.userId)
    res.setHeader('ETag', result.etag)
    res.json(result)
  })
  router.put('/admin/users/:userId/workspace-creation', async (req, res) => {
    requireApplicationAdmin(getPrincipal(req))
    const body = parse(creationBody, req.body)
    const result = await creation.set(getPrincipal(req), req.params.userId, body.canCreateWorkspaces, req.header('if-match'))
    res.setHeader('ETag', result.etag)
    res.json(result)
  })
  router.get('/workspaces/:workspaceId/share-candidates', async (req, res) => {
    await workspaces.requireOwner(getPrincipal(req), req.params.workspaceId)
    const query = parse(lookupQuery, req.query)
    res.json(await lookup().search(query.query, query.continuation))
  })
  router.get('/workspaces/:workspaceId/members', async (req, res) => {
    const result = await workspaces.list(getPrincipal(req), req.params.workspaceId)
    res.setHeader('ETag', result.etag)
    res.json(result)
  })
  router.put('/workspaces/:workspaceId/members/:userId', async (req, res) => {
    await workspaces.requireOwner(getPrincipal(req), req.params.workspaceId)
    const body = parse(memberBody, req.body)
    const result = await workspaces.change(getPrincipal(req), req.params.workspaceId, req.params.userId, body.role, req.header('if-match'))
    res.setHeader('ETag', result.etag)
    res.json(result)
  })
  router.delete('/workspaces/:workspaceId/members/:userId', async (req, res) => {
    const result = await workspaces.change(getPrincipal(req), req.params.workspaceId, req.params.userId, undefined, req.header('if-match'))
    res.setHeader('ETag', result.etag)
    res.json(result)
  })
  return router
}
