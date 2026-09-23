import express, { type Request } from 'express'
import { invalidRequest, notFound } from '../errors'
import { getPrincipal } from '../request-context'
import { WorkspaceMembersService, type WorkspaceMembersDeps } from './service'

function param(req: Request, key: string): string {
  const value = req.params[key]
  if (typeof value !== 'string') throw notFound()
  return value
}

export function createWorkspaceMembersRouter(deps: WorkspaceMembersDeps) {
  const router = express.Router()
  const base = '/workspaces/:workspaceId/reviewers'
  const service = new WorkspaceMembersService(deps)
  router.use(base, (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (Object.keys(req.query).length) throw invalidRequest('Reviewer access does not accept query parameters.')
    next()
  })
  router.get(base, async (req, res) => {
    const access = await service.list(getPrincipal(req), param(req, 'workspaceId'))
    res.setHeader('ETag', access.etag)
    res.json(access)
  })
  router.post(base, async (req, res) => {
    const access = await service.add(getPrincipal(req), param(req, 'workspaceId'), req.body, req.header('If-Match'))
    res.setHeader('ETag', access.etag)
    res.status(201).json(access)
  })
  router.delete(`${base}/:objectId`, async (req, res) => {
    if (req.body !== undefined || req.header('Transfer-Encoding') !== undefined ||
      (req.header('Content-Length') !== undefined && !/^0+$/.test(req.header('Content-Length')!))) {
      throw invalidRequest('Removing reviewer access does not accept a request body.')
    }
    const access = await service.remove(getPrincipal(req), param(req, 'workspaceId'), param(req, 'objectId'), req.header('If-Match'))
    res.setHeader('ETag', access.etag)
    res.json(access)
  })
  return router
}
