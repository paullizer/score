import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

/** Offline predeployment contract check of the same auth middleware bundled into the image. */
export async function verifyAdmissionCode() {
  const result = await build({
    stdin: {
      contents: "export * from './server/auth'; export * from './server/middleware'",
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', write: false,
  })
  const { parseEasyAuthPrincipal, isApplicationAdmin, createAuthMiddleware, APPLICATION_ADMISSION_VERSION } =
    await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
  assert.equal(APPLICATION_ADMISSION_VERSION, 'entra-roles-v1')
  const tenantId = '00000000-0000-4000-8000-000000000001'
  const oid = '00000000-0000-4000-8000-000000000002'
  const config = { authMode: 'easyauth', tenantId, isProduction: true, isAppService: true,
    allowedUserIds: new Set(), adminUserIds: new Set([oid]) }
  function header(roles, roleType = 'roles', tenant = tenantId, extras = []) {
    return Buffer.from(JSON.stringify({ auth_typ: 'aad', role_typ: roleType, claims: [
      { typ: 'tid', val: tenant }, { typ: 'oid', val: oid }, ...roles.map(val => ({ typ: roleType, val })), ...extras,
    ] })).toString('base64')
  }
  for (const roleType of ['roles', 'role', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role']) {
    for (const roles of [['Score.User'], ['Score.Admin'], ['Score.User', 'Score.Admin']]) {
      const principal = parseEasyAuthPrincipal(header(roles, roleType), undefined, config)
      assert.equal(isApplicationAdmin(principal), roles.includes('Score.Admin'))
      const middleware = createAuthMiddleware(config)
      for (const route of ['/api/session', '/']) {
        const headers = new Map()
        let error
        middleware({ path: route, header: name => name === 'x-ms-client-principal' ? header(roles, roleType) : undefined },
          { setHeader: (name, value) => headers.set(name, value) }, value => { error = value })
        assert.equal(error, undefined)
        assert.equal(headers.get('X-Score-Admission-Version'), 'entra-roles-v1')
      }
    }
  }
  for (const roles of [[], ['User'], ['Admin'], ['score.admin'], ['Score.User Score.Admin']]) {
    assert.throws(() => parseEasyAuthPrincipal(header(roles), undefined, { ...config, allowedUserIds: new Set([oid]) }))
  }
  assert.throws(() => parseEasyAuthPrincipal(header(['Score.Admin'], 'roles', oid), undefined, config))
  assert.throws(() => parseEasyAuthPrincipal(header(['Score.Admin'], 'roles', tenantId, [{ typ: 'idtyp', val: 'app' }]), undefined, config))
  assert.equal(isApplicationAdmin({ oid, tenantId, applicationRoles: [] }, config), false)
  assert.throws(() => createAuthMiddleware({ ...config, authMode: 'dev-header' }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyAdmissionCode().then(() => console.log('Role-based API/SPA admission contract passed.')).catch(error => {
    console.error(error instanceof Error ? error.message : 'Admission verification failed.')
    process.exitCode = 1
  })
}
