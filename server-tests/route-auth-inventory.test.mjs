import assert from 'node:assert/strict'
import test from 'node:test'
import { extractRoutes } from '../scripts/security/check-access-control.mjs'
import { APP_ORIGIN, CSRF_HEADER, authHeaders, startTestServer } from './helpers.mjs'

const PARAM_VALUES = new Map([
  ['workspaceId', 'workspace-aaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ['id', 'workspace-aaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ['jobId', 'job-11111111-1111-4111-8111-111111111111'],
  ['ladderId', 'ladder-11111111-1111-4111-8111-111111111111'],
  ['sourceId', 'source-11111111-1111-4111-8111-111111111111'],
  ['sourceSetId', 'source-set-11111111-1111-4111-8111-111111111111'],
  ['grade', '7'],
  ['resumeId', 'resume-11111111-1111-4111-8111-111111111111'],
  ['runId', 'analysis-run-11111111-1111-4111-8111-111111111111'],
  ['comparisonId', 'analysis-comparison-11111111-1111-4111-8111-111111111111'],
  ['documentId', 'document-11111111-1111-4111-8111-111111111111'],
  ['kind', 'candidate'],
  ['subjectId', 'analysis-comparison-11111111-1111-4111-8111-111111111111'],
  ['revision', 'current'],
  ['userId', '11111111-1111-4111-8111-111111111111'],
  ['objectId', '11111111-1111-4111-8111-111111111111'],
])

function materialize(routePath) {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, (_match, name) => PARAM_VALUES.get(name) ?? 'sample')
}

async function fetchRoute(server, route, options = {}) {
  return fetch(`${server.baseUrl}${materialize(route.fullPath)}`, {
    method: route.method,
    redirect: 'manual',
    ...options,
  })
}

function routesForRuntime() {
  const routes = extractRoutes(process.cwd()).filter(route => route.fullPath.startsWith('/api/'))
  assert.ok(routes.length > 0, 'route inventory must not be empty')
  for (const expected of ['GET /api/features', 'GET /api/session', 'POST /api/workspaces', 'GET /api/workspaces/:workspaceId/jobs']) {
    assert.ok(routes.some(route => `${route.method} ${route.fullPath}` === expected), `route inventory includes ${expected}`)
  }
  return routes
}

async function assertCloudError(response, expected, label) {
  const body = await response.json()
  assert.deepEqual(body, { error: expected }, label)
}

test('route inventory enforces auth and CSRF before handlers', async () => {
  const routes = routesForRuntime()
  const server = await startTestServer()
  try {
    for (const route of routes) {
      const response = await fetchRoute(server, route)
      assert.equal(response.status, 401, `${route.method} ${route.fullPath} requires identity`)
      await assertCloudError(response, { code: 'unauthorized', message: 'Missing identity header.' }, `${route.method} ${route.fullPath} returns auth error`)
    }

    const mutating = routes.filter(route => MUTATING_METHODS.has(route.method))
    assert.ok(mutating.length > 0, 'route inventory includes mutating routes')
    const adminHeaders = authHeaders({ roles: ['Score.User', 'Score.Admin'] })
    for (const route of mutating) {
      const wrongOrigin = await fetchRoute(server, route, {
        headers: { ...adminHeaders, ...CSRF_HEADER, origin: 'https://not-score.example.invalid', 'content-type': 'application/json' },
        body: route.method === 'GET' || route.method === 'HEAD' ? undefined : '{}',
      })
      assert.equal(wrongOrigin.status, 403, `${route.method} ${route.fullPath} rejects wrong Origin`)
      await assertCloudError(wrongOrigin, {
        code: 'forbidden',
        message: 'This request is not permitted from this origin.',
      }, `${route.method} ${route.fullPath} returns origin CSRF error`)

      const missingHeader = await fetchRoute(server, route, {
        headers: { ...adminHeaders, origin: APP_ORIGIN, 'content-type': 'application/json' },
        body: route.method === 'GET' || route.method === 'HEAD' ? undefined : '{}',
      })
      assert.equal(missingHeader.status, 403, `${route.method} ${route.fullPath} rejects missing X-Score-Request`)
      await assertCloudError(missingHeader, {
        code: 'forbidden',
        message: 'This request must include the x-score-request: workspace header.',
      }, `${route.method} ${route.fullPath} returns header CSRF error`)
    }

    const validCsrfInvalidBody = await fetch(`${server.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { ...adminHeaders, ...CSRF_HEADER, origin: APP_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ unexpected: true }),
    })
    assert.equal(validCsrfInvalidBody.status, 400, 'valid CSRF headers reach the handler')
    await assertCloudError(validCsrfInvalidBody, {
      code: 'invalid_request',
      message: 'Request body has unexpected field(s): unexpected.',
    }, 'valid CSRF headers do not produce a CSRF error')
  } finally {
    await server.close()
  }
})

test('only healthz is anonymously reachable outside the API', async () => {
  const server = await startTestServer()
  try {
    const health = await fetch(`${server.baseUrl}/healthz`)
    assert.ok([200, 503].includes(health.status), '/healthz answers without identity')
    await health.arrayBuffer()

    for (const route of ['/', '/workspaces/workspace-aaaaaaaaaaaaaaaaaaaaaaaaaa', '/assets/missing.js']) {
      const response = await fetch(`${server.baseUrl}${route}`, { redirect: 'manual' })
      assert.equal(response.status, 401, `${route} requires identity`)
      await response.arrayBuffer()
    }
  } finally {
    await server.close()
  }
})

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
