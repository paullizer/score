import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../dist-server/app.mjs'

const oid = '00000000-0000-4000-8000-000000000002'
const env = {
  AZURE_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  COSMOS_ENDPOINT: 'https://cosmos.example.com',
  STORAGE_ACCOUNT_URL: 'https://storage.example.com',
  APP_ORIGIN: 'https://score.example.com',
}

test('Easy Auth needs no runtime user roster and ignores obsolete privilege configuration during migration', () => {
  const config = loadConfig({ ...env, NODE_ENV: 'production', SCORE_ALLOWED_USER_IDS: 'obsolete',
    SCORE_ADMIN_USER_IDS: oid, SCORE_DEV_USER_ROLES: JSON.stringify({ [oid]: ['Score.Admin'] }) })
  assert.equal(config.allowedUserIds, undefined)
  assert.equal(config.adminUserIds, undefined)
  assert.equal(config.devUserRoles, undefined)
})

test('access config requires a complete validated service-principal/container pair', () => {
  assert.equal(loadConfig(env).access, undefined)
  const pair = { SCORE_ACCESS_CONTAINER: 'application-access', SCORE_ENTRA_SERVICE_PRINCIPAL_ID: oid }
  assert.deepEqual(loadConfig({ ...env, ...pair }).access, { container: 'application-access', servicePrincipalId: oid })
  for (const invalid of [
    { SCORE_ACCESS_CONTAINER: 'application-access' },
    { SCORE_ENTRA_SERVICE_PRINCIPAL_ID: oid },
    { ...pair, SCORE_ENTRA_SERVICE_PRINCIPAL_ID: 'not-a-guid' },
    { ...pair, SCORE_ACCESS_CONTAINER: 'path/access' },
  ]) assert.throws(() => loadConfig({ ...env, ...invalid }), /SCORE_ACCESS_CONTAINER|SCORE_ENTRA_SERVICE_PRINCIPAL_ID/)
})

test('the access store cannot alias workspace, settings, or inactive feature stores', () => {
  for (const name of ['workspaces', 'application-settings', 'job-records', 'grade-records', 'resume-records', 'analysis-records']) {
    assert.throws(() => loadConfig({ ...env, SCORE_ACCESS_CONTAINER: name, SCORE_ENTRA_SERVICE_PRINCIPAL_ID: oid }), /must be separate/)
  }
  assert.throws(() => loadConfig({ ...env, COSMOS_CONTAINER: 'application-access' }), /must be separate/)
  assert.throws(() => loadConfig({ ...env, SCORE_SETTINGS_CONTAINER: 'custom', SCORE_ACCESS_CONTAINER: 'custom', SCORE_ENTRA_SERVICE_PRINCIPAL_ID: oid }), /must be separate/)
})

test('developer identity roles require explicit local-only GUID-to-role configuration', () => {
  const local = { ...env, SCORE_AUTH_MODE: 'dev-header' }
  for (const value of [undefined, '', 'broken', '[]', '{}', JSON.stringify({ [oid]: [] }), JSON.stringify({ [oid]: ['Admin'] }),
    JSON.stringify({ invalid: ['Score.User'] })]) {
    assert.throws(() => loadConfig({ ...local, SCORE_DEV_USER_ROLES: value }), /SCORE_DEV_USER_ROLES/)
  }
  const roles = JSON.stringify({ [oid]: ['Score.Admin'], [env.AZURE_TENANT_ID]: ['Score.User'] })
  assert.deepEqual([...loadConfig({ ...local, SCORE_DEV_USER_ROLES: roles }).devUserRoles],
    [[oid, ['Score.Admin']], [env.AZURE_TENANT_ID, ['Score.User']]])
  for (const deployment of [{ NODE_ENV: 'production' }, { WEBSITE_SITE_NAME: 'score' }, { WEBSITE_INSTANCE_ID: 'instance' }]) {
    assert.throws(() => loadConfig({ ...local, ...deployment, SCORE_DEV_USER_ROLES: roles }), /prohibited/)
  }
})

test('developer auth permits only loopback http origins while Easy Auth still requires https', () => {
  const roles = JSON.stringify({ [oid]: ['Score.User'] })
  for (const APP_ORIGIN of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://[::1]:5173']) {
    const config = loadConfig({ ...env, APP_ORIGIN, SCORE_AUTH_MODE: 'dev-header', SCORE_DEV_USER_ROLES: roles })
    assert.equal(config.appOrigin, APP_ORIGIN)
  }
  assert.throws(() => loadConfig({
    ...env, APP_ORIGIN: 'http://example.com', SCORE_AUTH_MODE: 'dev-header', SCORE_DEV_USER_ROLES: roles,
  }), /APP_ORIGIN must use https, or http on a loopback host/)
  assert.throws(() => loadConfig({ ...env, APP_ORIGIN: 'http://127.0.0.1:5173' }), /APP_ORIGIN must use https/)
})
