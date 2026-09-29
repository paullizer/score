import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { BLOCKER, NOTE, REVIEW } from './lib/findings.mjs'
import { createRepo, runSpec } from './lib/testing.mjs'
import { analyzeAccessControl, extractRoutes, spec } from './check-access-control.mjs'

const repos = []
after(() => repos.forEach(repo => repo.cleanup()))
function repo(options) {
  const created = createRepo(options)
  repos.push(created)
  return created
}

function analyze(path, text, options = {}) {
  return analyzeAccessControl([{ path, text, addedLines: options.addedLines ?? new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) }], options).findings
}

describe('route guard analysis', () => {
  test('accepts direct handler guards and flags unguarded routes', () => {
    const findings = analyze('server/demo.ts', `
      import express from 'express'
      const router = express.Router()
      router.get('/safe', authorize(repo, 'read'), (_req, res) => res.json({ ok: true }))
      router.post('/unsafe', (_req, res) => res.json({ ok: true }))
    `)
    assert.equal(findings.filter(item => item.rule === 'access/unguarded-route').length, 1)
    assert.match(findings.find(item => item.rule === 'access/unguarded-route').message, /POST \/api\/unsafe/)
  })

  test('accepts router.use prefix guards and same-file wrapper functions', () => {
    const findings = analyze('server/demo.ts', `
      import express from 'express'
      const router = express.Router()
      const base = '/workspaces/:workspaceId/items'
      function secure(handler) { getPrincipal({} as any); return handler }
      router.use(base, authorize)
      router.get(base, (_req, res) => res.json({ ok: true }))
      router.post(\`\${base}/:id\`, secure((_req, res) => res.json({ ok: true })))
    `)
    assert.equal(findings.filter(item => item.verdict === BLOCKER).length, 0)
  })

  test('extracts chained router.route registrations', () => {
    const routes = extractRoutes([{ path: 'server/demo.ts', text: `
      import express from 'express'
      const router = express.Router()
      router.route('/things/:id').get(getPrincipal).delete(requireApplicationAdmin)
    ` }])
    assert.deepEqual(routes.map(route => `${route.method} ${route.fullPath}`), ['DELETE /api/things/:id', 'GET /api/things/:id'])
  })

  test('blocks direct app routes except healthz', () => {
    const findings = analyze('server/app.ts', `
      import express from 'express'
      const app = express()
      app.get('/healthz', (_req, res) => res.json({ status: 'ready' }))
      app.get('/api/direct', (_req, res) => res.json({ ok: true }))
    `)
    assert.equal(findings.filter(item => item.rule === 'access/direct-app-route').length, 1)
  })

  test('notes new getPrincipal-only routes without failing', () => {
    const findings = analyze('server/demo.ts', `
      import express from 'express'
      const router = express.Router()
      router.get('/me', (req, res) => res.json(getPrincipal(req)))
    `, { fullScan: false, addedLines: new Set([4]) })
    assert.equal(findings.find(item => item.rule === 'access/get-principal-only')?.verdict, NOTE)
  })
})

describe('whole-file invariant rules', () => {
  test('checks app wiring order', () => {
    const findings = analyze('server/app.ts', `
      export function createApp() {
        api.use(telemetryMiddleware('score.auth', createAuthMiddleware(config)))
        api.use(noStore)
      }
    `)
    assert.ok(findings.some(item => item.rule === 'access/app-wiring-order'))
  })

  test('blocks principal header reads outside auth boundary', () => {
    const findings = analyze('server/feature.ts', `
      export function read(req) {
        return req.header('x-ms-client-principal')
      }
    `)
    assert.ok(findings.some(item => item.rule === 'access/principal-header-read'))
    assert.equal(analyze('server/auth.ts', `req.header('x-ms-client-principal')`).some(item => item.rule === 'access/principal-header-read'), false)
  })

  test('blocks permissive CORS patterns', () => {
    const findings = analyze('server/cors.ts', `
      import cors from 'cors'
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    `)
    assert.equal(findings.filter(item => item.rule === 'access/permissive-cors').length, 4)
  })

  test('blocks dev principal header guard removal', () => {
    const findings = analyze('server/auth.ts', `
      export function parseDevHeaderPrincipal(devPrincipalHeader, config) {
        if (config.authMode !== 'dev-header') throw new Error('no')
      }
    `)
    assert.ok(findings.some(item => item.rule === 'access/dev-header-production-guard'))
  })
})

describe('review rules', () => {
  test('reviews interpolated query text but not parameterized literals', () => {
    const findings = analyze('server/store.ts', `
      container.items.query({ query: \`SELECT * FROM c WHERE c.id = \${id}\` })
      container.items.query({ query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] })
    `)
    assert.equal(findings.filter(item => item.rule === 'access/query-interpolation').length, 1)
  })

  test('reviews healthz handler changes on added lines', () => {
    const findings = analyze('server/app.ts', `
      const app = express()
      app.get('/healthz', noStore, async (_req, res) => {
        res.json({ status: 'ready' })
      })
    `, { addedLines: new Set([3]) })
    assert.equal(findings.find(item => item.rule === 'access/healthz-change')?.verdict, REVIEW)
  })
})

describe('runner integration', () => {
  test('scopes reviews to added lines and keeps blockers as whole-file invariants', async () => {
    const fixture = repo({
      base: { 'server/demo.ts': `
        import express from 'express'
        const router = express.Router()
        container.items.query({ query: \`SELECT * FROM c WHERE c.id = \${id}\` })
      ` },
      head: { 'server/demo.ts': `
        import express from 'express'
        const router = express.Router()
        container.items.query({ query: \`SELECT * FROM c WHERE c.id = \${id}\` })
        router.get('/unsafe', (_req, res) => res.json({ ok: true }))
      ` },
    })
    const result = await runSpec(spec, fixture)
    assert.equal(result.exitCode, 1)
    assert.ok(result.findings.some(item => item.rule === 'access/unguarded-route'))
    assert.equal(result.findings.some(item => item.rule === 'access/query-interpolation'), false)
  })

  test('honors suppressions and full scan', async () => {
    const fixture = repo({ head: { 'server/demo.ts': `
      import express from 'express'
      const router = express.Router()
      // security-reviewed: access/unguarded-route -- synthetic test route is intentionally open
      router.get('/unsafe', (_req, res) => res.json({ ok: true }))
    ` } })
    const suppressed = await runSpec(spec, fixture)
    assert.equal(suppressed.exitCode, 0)
    assert.equal(suppressed.suppressed.length, 1)
    const full = await runSpec(spec, fixture, ['--full-scan', '--head', fixture.headSha])
    assert.equal(full.ctx.mode, 'full')
  })

  test('reports guard helper edits', async () => {
    const fixture = repo({
      base: { 'server/request-context.ts': `export function getPrincipal(req) { return req.principal }\n` },
      head: { 'server/request-context.ts': `export function getPrincipal(req) {\n  if (!req.principal) throw new Error('missing')\n  return req.principal\n}\n` },
    })
    const result = await runSpec(spec, fixture)
    assert.ok(result.findings.some(item => item.rule === 'access/guard-helper-change'))
  })
})

describe('real route inventory', () => {
  test('extracts guarded routes from the current server', () => {
    const routes = extractRoutes(process.cwd())
    assert.ok(routes.length >= 100)
    for (const expected of ['GET /api/features', 'GET /api/session', 'POST /api/workspaces', 'GET /api/workspaces/:workspaceId/jobs']) {
      assert.ok(routes.some(route => `${route.method} ${route.fullPath}` === expected), expected)
    }
    assert.deepEqual(routes.filter(route => route.fullPath.startsWith('/api/') && !route.guarded), [])
  })
})
