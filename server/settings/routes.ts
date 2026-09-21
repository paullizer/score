import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { MODEL_TASK_IDS, SettingsValidationError } from '../../src/domain/admin-settings'
import { settingsValidationError } from '../../src/domain/admin-settings-schema'
import { isApplicationAdmin } from '../auth'
import type { Config } from '../config'
import { forbidden, unavailable } from '../errors'
import { getPrincipal } from '../request-context'
import type { AdminSettingsService } from './service'

const restoreBody = z.strictObject({ revision: z.string().min(1).max(128) })
const importBody = z.strictObject({ document: z.unknown() })
const importApplyBody = importBody.extend({ confirm: z.literal(true) })
const testBody = z.strictObject({
  kind: z.enum(['connection', 'structured-output', 'task']), taskId: z.enum(MODEL_TASK_IDS).optional(),
  deploymentId: z.string().min(1).max(128).optional(), draft: z.unknown().optional(),
  confirmPaidProbe: z.boolean().default(false),
})
function body<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw settingsValidationError(result.error)
  return result.data
}

export function createAdminSettingsRouter(config: Config, service: AdminSettingsService | undefined): Router {
  const router = Router()
  router.use('/admin', (req, _res, next) => {
    if (!isApplicationAdmin(getPrincipal(req), config)) throw forbidden('Application administrator designation is required. Workspace ownership does not grant settings access.')
    next()
  })
  const settings = () => {
    if (!service) throw unavailable('Application settings storage is not configured or available. An operator must provision the isolated settings store.')
    return service
  }
  router.get('/admin/settings', async (_req, res) => {
    const result = await settings().read()
    res.setHeader('ETag', result.etag)
    res.json(result)
  })
  router.patch('/admin/settings', async (req, res) => {
    const result = await settings().patch(getPrincipal(req), req.body, req.header('if-match'))
    res.setHeader('ETag', result.etag)
    res.json(result)
  })
  router.get('/admin/settings/history', async (req, res) => {
    const query = body(z.strictObject({
      limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
      before: z.string().min(1).max(128).optional(),
    }), req.query)
    res.json(await settings().history(query.limit, query.before))
  })
  router.get('/admin/settings/revisions/:revision', async (req, res) => {
    res.json(await settings().revision(req.params.revision))
  })
  router.post('/admin/settings/restore', async (req, res) => {
    const input = body(restoreBody, req.body)
    const result = await settings().restore(getPrincipal(req), input.revision, req.header('if-match'))
    res.setHeader('ETag', result.etag)
    res.json(result)
  })
  router.get('/admin/settings/export', async (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="score-settings.json"')
    res.json(await settings().export())
  })
  router.post('/admin/settings/import-preview', async (req, res) => {
    const input = body(importBody, req.body)
    const result = await settings().previewImport(input.document, req.header('if-match'))
    res.setHeader('ETag', result.etag)
    res.json(result)
  })
  router.post('/admin/settings/import-apply', async (req, res) => {
    const input = body(importApplyBody, req.body)
    const result = await settings().applyImport(getPrincipal(req), input.document, req.header('if-match'), input.confirm)
    res.setHeader('ETag', result.etag)
    res.json(result)
  })
  router.get('/admin/deployments', async (_req, res) => {
    res.json(await settings().inventory())
  })
  router.post('/admin/deployments/refresh', async (req, res) => {
    body(z.strictObject({}), req.body)
    res.json(await settings().inventory())
  })
  router.post('/admin/deployments/test', async (req, res) => {
    res.json(await settings().test(body(testBody, req.body)))
  })
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SettingsValidationError) {
      const globalError = error.fields.find(field => field.path === '')
      res.status(400).json({ error: {
        code: 'invalid_request',
        message: globalError?.message ?? 'Review the indicated settings fields. Your draft has not been saved.',
        fields: error.fields,
      } })
      return
    }
    next(error)
  })
  return router
}
