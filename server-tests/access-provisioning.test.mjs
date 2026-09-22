import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  APPLICATION_ADMISSION_VERSION, DIRECTORY_PERMISSIONS, GRAPH_APPLICATION_ID, SCORE_ROLES, SCORE_ADMIN_ROLE_ID,
  SCORE_USER_ROLE_ID, admissionStage, bootstrapAdministrators, directoryPermissionDefinitions, graphValues,
  mergeApplicationRoles, validateEasyAuth, validateRuntimeAccessSettings, verifyRoleAwareDeployment,
} from '../scripts/azure-access.mjs'
import { ensureDirectoryConsent, ensureRoleAssignments, ensureSignInConsent, transitionIngress, verifyEntraProvisioning } from '../scripts/azure-auth.mjs'
import { verifyAdmissionCode } from '../scripts/verify-admission.mjs'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const env = {
  AZURE_TENANT_ID: id(1), AZURE_SUBSCRIPTION_ID: id(2), AZURE_ALLOWED_USER_ID: id(3),
  AZURE_BOOTSTRAP_ADMIN_USER_IDS: id(4), AZURE_PRINCIPAL_ID: id(5),
  AZURE_AUTH_CLIENT_ID: id(6), AZURE_AUTH_SP_OBJECT_ID: id(7),
  AZURE_MANAGED_IDENTITY_CLIENT_ID: id(8), AZURE_MANAGED_IDENTITY_PRINCIPAL_ID: id(9),
  AZURE_JOB_WORKER_PRINCIPAL_ID: id(10), AZURE_RESOURCE_GROUP: 'score-test',
  AZURE_APP_SERVICE_NAME: 'score-test', AZURE_APP_SERVICE_URL: 'https://score-test.azurewebsites.net/',
  AZURE_CONTAINER_REGISTRY_ENDPOINT: 'score.azurecr.io',
}
const image = 'score.azurecr.io/score:verified-build'
const graphPrincipal = {
  id: id(50), appRoles: [...DIRECTORY_PERMISSIONS, 'Member.Read.Hidden', 'Directory.ReadWrite.All'].map((value, index) => ({
    id: id(100 + index), value, isEnabled: true, allowedMemberTypes: ['Application'],
  })),
}

function easyAuth(stage = 'guarded') {
  return {
    platform: { enabled: true },
    globalValidation: { requireAuthentication: true, excludedPaths: ['/healthz'] },
    httpSettings: { requireHttps: true },
    login: { tokenStore: { enabled: false } },
    identityProviders: { azureActiveDirectory: {
      enabled: true,
      registration: { clientId: env.AZURE_AUTH_CLIENT_ID, openIdIssuer: `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/v2.0`,
        clientSecretSettingName: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET' },
      validation: { allowedAudiences: [env.AZURE_AUTH_CLIENT_ID, `api://${env.AZURE_AUTH_CLIENT_ID}`],
        ...(stage === 'guarded' ? { defaultAuthorizationPolicy: { allowedPrincipals: { identities: [env.AZURE_ALLOWED_USER_ID] } } } : {}) },
    } },
  }
}
function runtimeSettings() {
  return {
    SCORE_AUTH_MODE: 'easyauth', AZURE_TENANT_ID: env.AZURE_TENANT_ID, AZURE_CLIENT_ID: env.AZURE_MANAGED_IDENTITY_CLIENT_ID,
    SCORE_ENTRA_SERVICE_PRINCIPAL_ID: env.AZURE_AUTH_SP_OBJECT_ID, SCORE_ACCESS_CONTAINER: 'application-access',
    COSMOS_CONTAINER: 'workspaces', SCORE_SETTINGS_CONTAINER: 'application-settings',
  }
}

function graphFixture() {
  const writes = []
  const assignments = [{
    id: 'existing-admin-assignment', principalId: env.AZURE_BOOTSTRAP_ADMIN_USER_IDS, principalType: 'User',
    resourceId: env.AZURE_AUTH_SP_OBJECT_ID, appRoleId: SCORE_ADMIN_ROLE_ID,
  }]
  const consent = []
  const graph = async (path, method = 'GET', body) => {
    if (method !== 'GET') {
      writes.push({ path, method, body })
      const value = { ...body, id: `assignment-${writes.length}`, principalType: 'User' }
      if (path.endsWith('/appRoleAssignments')) consent.push(value)
      else if (path.endsWith('/appRoleAssignedTo')) assignments.push(value)
      return value
    }
    if (path.startsWith('/servicePrincipals?$filter=')) return { value: [graphPrincipal] }
    if (path.startsWith(`/servicePrincipals/${env.AZURE_MANAGED_IDENTITY_PRINCIPAL_ID}?`)) {
      return { id: env.AZURE_MANAGED_IDENTITY_PRINCIPAL_ID, appId: env.AZURE_MANAGED_IDENTITY_CLIENT_ID, servicePrincipalType: 'ManagedIdentity' }
    }
    if (path.startsWith(`/servicePrincipals/${env.AZURE_AUTH_SP_OBJECT_ID}?`)) {
      return { id: env.AZURE_AUTH_SP_OBJECT_ID, appId: env.AZURE_AUTH_CLIENT_ID, appRoleAssignmentRequired: true, appRoles: SCORE_ROLES }
    }
    if (path === `/servicePrincipals/${env.AZURE_AUTH_SP_OBJECT_ID}/appRoleAssignedTo`) return { value: assignments }
    if (path === `/servicePrincipals/${env.AZURE_MANAGED_IDENTITY_PRINCIPAL_ID}/appRoleAssignments`) return { value: consent }
    const target = path.match(/^\/(?:users|groups)\/([^?]+)\?\$select=id$/)
    if (target) return { id: target[1] }
    throw new Error(`Unexpected provisioning call ${path}`)
  }
  return { graph, writes, assignments, consent }
}

function proofResponse(url) {
  if (url.endsWith('/healthz')) {
    return new Response(JSON.stringify({ status: 'ready' }), {
      headers: { 'x-score-access-control': APPLICATION_ADMISSION_VERSION },
    })
  }
  const headers = { 'x-score-admission-version': APPLICATION_ADMISSION_VERSION, 'x-score-application-roles': 'Score.Admin' }
  return new Response(url.endsWith('/api/session') ? JSON.stringify({ user: { id: env.AZURE_BOOTSTRAP_ADMIN_USER_IDS, tenantId: env.AZURE_TENANT_ID } }) : '<html></html>', { headers })
}

test('role preparation preserves the Score.User UUID, unrelated definitions and existing assignment IDs', () => {
  assert.equal(SCORE_USER_ROLE_ID, 'e859daa1-e9fa-426a-b79d-6d136d459222')
  const unrelated = { id: id(80), value: 'Other.Role', isEnabled: true, allowedMemberTypes: ['User'] }
  const existing = [structuredClone(SCORE_ROLES[0]), unrelated]
  const roles = mergeApplicationRoles(existing)
  assert.deepEqual(roles.slice(0, 2), existing)
  assert.equal(roles[2].id, SCORE_ADMIN_ROLE_ID)
  assert.deepEqual(mergeApplicationRoles(roles), roles)
  assert.equal(existing.length, 2)
  for (const changed of [
    { ...SCORE_ROLES[0], id: id(81) }, { ...SCORE_ROLES[0], value: 'Wrong' },
    { ...SCORE_ROLES[0], isEnabled: false }, { ...SCORE_ROLES[0], allowedMemberTypes: ['Application', 'User'] },
  ]) assert.throws(() => mergeApplicationRoles([changed]), /incompatible/)
})

test('bootstrap admins must be explicit and user/group app-role additions are idempotent', async () => {
  assert.throws(() => bootstrapAdministrators({ AZURE_ALLOWED_USER_ID: id(1), AZURE_PRINCIPAL_ID: id(1), AZURE_ADMIN_USER_IDS: id(1) }), /explicit/)
  const f = graphFixture()
  const requested = { ...env, AZURE_SCORE_USER_GROUP_IDS: id(60), AZURE_SCORE_ADMIN_GROUP_IDS: id(61), AZURE_SCORE_USER_IDS: id(62) }
  await ensureRoleAssignments(requested, env.AZURE_AUTH_SP_OBJECT_ID, f.graph)
  assert.equal(f.writes.length, 3)
  assert.equal(f.assignments.find(item => item.appRoleId === SCORE_ADMIN_ROLE_ID && item.principalId === env.AZURE_BOOTSTRAP_ADMIN_USER_IDS).id,
    'existing-admin-assignment')
  assert.ok(f.writes.some(write => write.body.principalId === id(60) && write.body.appRoleId === SCORE_USER_ROLE_ID))
  assert.ok(f.writes.some(write => write.body.principalId === id(61) && write.body.appRoleId === SCORE_ADMIN_ROLE_ID))
  assert.ok(f.writes.every(write => write.body.principalId !== env.AZURE_PRINCIPAL_ID))
  await ensureRoleAssignments(requested, env.AZURE_AUTH_SP_OBJECT_ID, f.graph)
  assert.equal(f.writes.length, 3)
})

test('runtime consent resolves exact current read-only permission definitions, with no blanket fallback', async () => {
  assert.deepEqual(directoryPermissionDefinitions(graphPrincipal).map(role => role.name), DIRECTORY_PERMISSIONS)
  assert.throws(() => directoryPermissionDefinitions({ ...graphPrincipal,
    appRoles: graphPrincipal.appRoles.filter(role => role.value !== 'GroupMember.ReadBasic.All') }), /No broader permission/)
  const f = graphFixture()
  await ensureDirectoryConsent(env, f.graph)
  assert.equal(f.writes.length, 3)
  assert.deepEqual(f.writes.map(write => write.body.appRoleId), graphPrincipal.appRoles.slice(0, 3).map(role => role.id))
  assert.ok(f.writes.every(write => write.body.principalId === env.AZURE_MANAGED_IDENTITY_PRINCIPAL_ID))
  await ensureDirectoryConsent(env, f.graph)
  assert.equal(f.writes.length, 3)
  await verifyEntraProvisioning(env, f.graph)
  f.consent.pop()
  await assert.rejects(() => verifyEntraProvisioning(env, f.graph), /Consent\/propagation/)
})

test('hidden membership consent is explicit, worker consent and preexisting write grants are refused', async () => {
  const f = graphFixture()
  await ensureDirectoryConsent({ ...env, AZURE_SCORE_CONSENT_HIDDEN_MEMBERSHIP: 'true' }, f.graph)
  assert.equal(f.writes.length, 4)
  await assert.rejects(() => ensureDirectoryConsent(env, f.graph), /unapproved/)
  await assert.rejects(() => ensureDirectoryConsent({ ...env, AZURE_SCORE_CONSENT_HIDDEN_MEMBERSHIP: 'yes' }, f.graph), /explicitly/)
  await assert.rejects(() => ensureDirectoryConsent({ ...env, AZURE_JOB_WORKER_PRINCIPAL_ID: env.AZURE_MANAGED_IDENTITY_PRINCIPAL_ID }, f.graph), /never a document worker/)
  const broad = graphFixture()
  broad.consent.push({ resourceId: graphPrincipal.id, appRoleId: graphPrincipal.appRoles.at(-1).id })
  await assert.rejects(() => ensureDirectoryConsent(env, broad.graph), /unapproved/)
  assert.equal(broad.writes.length, 0)
})

test('Graph failures do not mark consent or bootstrap verification complete', async () => {
  const f = graphFixture()
  await assert.rejects(() => ensureDirectoryConsent(env, async (path, method, body) => {
    if (method === 'POST') throw new Error('Consent requires a privileged operator')
    return f.graph(path, method, body)
  }), /privileged operator/)
  f.assignments.splice(0)
  await assert.rejects(() => verifyEntraProvisioning(env, f.graph), /bootstrap administrator/)
})

test('sign-in consent covers only basic identity scopes and preserves previous permission IDs', async () => {
  const writes = [], grants = []
  const application = { id: id(70), requiredResourceAccess: [{ resourceAppId: id(71), resourceAccess: [{ id: id(72), type: 'Scope' }] }] }
  const graph = async (path, method = 'GET', body) => {
    if (method !== 'GET') {
      writes.push({ path, method, body })
      if (path === '/oauth2PermissionGrants') grants.push({ id: id(90), ...body })
      if (path.startsWith('/applications/')) application.requiredResourceAccess = body.requiredResourceAccess
      return {}
    }
    if (path.startsWith('/servicePrincipals?')) return { value: [{ id: graphPrincipal.id,
      oauth2PermissionScopes: ['openid', 'profile', 'email'].map((value, index) => ({ value, id: id(200 + index), isEnabled: true })) }] }
    if (path.startsWith('/oauth2PermissionGrants?')) return { value: grants }
    throw new Error('Unexpected consent call')
  }
  await ensureSignInConsent(graph, application, env.AZURE_AUTH_SP_OBJECT_ID)
  assert.equal(grants[0].scope, 'openid profile email')
  assert.equal(grants[0].consentType, 'AllPrincipals')
  assert.deepEqual(application.requiredResourceAccess[0], { resourceAppId: id(71), resourceAccess: [{ id: id(72), type: 'Scope' }] })
  assert.equal(application.requiredResourceAccess[1].resourceAppId, GRAPH_APPLICATION_ID)
  await ensureSignInConsent(graph, application, env.AZURE_AUTH_SP_OBJECT_ID)
  assert.equal(writes.length, 2)
})

test('provisioning pagination checks the origin and resource before following Graph links', async () => {
  let calls = 0
  const path = `/servicePrincipals/${env.AZURE_AUTH_SP_OBJECT_ID}/appRoleAssignedTo`
  const values = await graphValues(async () => ++calls === 1 ? {
    value: ['first'], '@odata.nextLink': `https://graph.microsoft.com/v1.0${path}?$skiptoken=two`,
  } : { value: ['second'] }, path)
  assert.deepEqual(values, ['first', 'second'])
  for (const link of ['https://attacker.test/v1.0/next', 'https://graph.microsoft.com/v1.0/users',
    `https://name:secret@graph.microsoft.com/v1.0${path}`]) {
    await assert.rejects(() => graphValues(async () => ({ value: [], '@odata.nextLink': link }), path), /unsafe/)
  }
})

test('deployment gates check the complete auth model in both guarded and released stages', () => {
  validateEasyAuth(env, easyAuth())
  validateRuntimeAccessSettings(env, runtimeSettings())
  assert.equal(admissionStage(env), 'guarded')
  const released = { ...env, AZURE_SCORE_ADMISSION_STAGE: 'roles', AZURE_SCORE_ROLE_VERIFIED_IMAGE: image,
    AZURE_SCORE_ROLE_VERIFIED_AT: '2026-09-20T12:00:00Z' }
  validateEasyAuth(released, easyAuth('roles'))
  assert.throws(() => validateEasyAuth(released, easyAuth()), /migration stage/)
  assert.throws(() => validateEasyAuth(env, easyAuth('roles')), /migration stage/)
  assert.throws(() => admissionStage({ ...env, AZURE_SCORE_ADMISSION_STAGE: 'roles' }), /verified deployment/)
  for (const change of [
    value => { value.globalValidation.excludedPaths.push('/api') },
    value => { value.identityProviders.azureActiveDirectory.registration.openIdIssuer = 'https://login.microsoftonline.com/common/v2.0' },
    value => { value.identityProviders.azureActiveDirectory.validation.allowedAudiences.push('another-api') },
    value => { value.httpSettings.requireHttps = false },
    value => { value.login.tokenStore.enabled = true },
    value => { value.identityProviders.google = { enabled: true } },
  ]) {
    const value = easyAuth()
    change(value)
    assert.throws(() => validateEasyAuth(env, value))
  }
  for (const change of [
    { SCORE_ADMIN_USER_IDS: id(3) }, { SCORE_DEV_USER_ROLES: '{}' }, { SCORE_AUTH_MODE: 'dev-header' },
    { SCORE_ACCESS_CONTAINER: 'workspaces' }, { SCORE_ENTRA_SERVICE_PRINCIPAL_ID: id(99) },
  ]) assert.throws(() => validateRuntimeAccessSettings(env, { ...runtimeSettings(), ...change }))
})

test('role verification requires real successful API and SPA role claims, never saved cookies or redirects', async () => {
  await assert.rejects(() => verifyRoleAwareDeployment(env, image, { cookie: '' }), /operator process/)
  for (const response of [
    () => new Response('', { status: 302, headers: { location: '/.auth/login/aad' } }),
    () => new Response('{}'),
    () => new Response('{}', { headers: { 'x-score-admission-version': APPLICATION_ADMISSION_VERSION, 'x-score-application-roles': 'Admin' } }),
  ]) await assert.rejects(() => verifyRoleAwareDeployment(env, image, {
    cookie: 'AppServiceAuthSession=test', fetch: url => url.endsWith('/healthz') ? proofResponse(url) : response(),
  }))
  const urls = []
  const proof = await verifyRoleAwareDeployment(env, image, {
    cookie: 'AppServiceAuthSession=test',
    fetch: async (url, options) => {
      urls.push(url)
      assert.equal(options.redirect, 'manual')
      if (url.endsWith('/healthz')) assert.equal(options.headers, undefined)
      else assert.equal(options.headers.Cookie, 'AppServiceAuthSession=test')
      return proofResponse(url)
    },
  })
  assert.equal(proof.image, image)
  assert.deepEqual(urls, [
    'https://score-test.azurewebsites.net/healthz', 'https://score-test.azurewebsites.net/api/session',
    'https://score-test.azurewebsites.net/',
  ])
  assert.doesNotMatch(JSON.stringify(proof), /AppServiceAuthSession/)
})

test('a missing marker, failed readiness or health redirect blocks ingress proof before authenticated requests', async () => {
  for (const response of [
    () => new Response(JSON.stringify({ status: 'ready' })),
    () => new Response(JSON.stringify({ status: 'unavailable' }), { headers: { 'x-score-access-control': APPLICATION_ADMISSION_VERSION } }),
    () => new Response('', { status: 503, headers: { 'x-score-access-control': APPLICATION_ADMISSION_VERSION } }),
    () => new Response('', { status: 302, headers: { 'x-score-access-control': APPLICATION_ADMISSION_VERSION } }),
  ]) {
    let calls = 0
    await assert.rejects(() => verifyRoleAwareDeployment(env, image, {
      cookie: 'AppServiceAuthSession=test', fetch: async url => {
        calls++
        assert.ok(url.endsWith('/healthz'))
        return response()
      },
    }), /readiness|health marker/)
    assert.equal(calls, 1)
  }
})

test('ingress is released only after verified roles, consent and both deployed entry paths; restore precedes rollback', async () => {
  const f = graphFixture()
  await ensureDirectoryConsent(env, f.graph)
  let properties = easyAuth()
  const saves = [], actions = []
  const dependencies = {
    credential: {}, graph: f.graph, cookie: 'AppServiceAuthSession=test',
    fetch: async url => { actions.push('proof'); return proofResponse(url) },
    save: (key, value) => saves.push([key, value]),
    arm: async (url, method, body) => {
      if (url.includes('/authsettingsV2')) {
        if (method === 'PUT') { actions.push('write-ingress'); properties = structuredClone(body.properties) }
        return { properties: structuredClone(properties) }
      }
      if (url.includes('/appsettings/list')) return { properties: runtimeSettings() }
      if (url.includes('/config/web?')) return { properties: { linuxFxVersion: `DOCKER|${image}` } }
      throw new Error('Unexpected ARM call')
    },
  }
  await transitionIngress(env, 'release-ingress', dependencies)
  assert.deepEqual(actions, ['proof', 'proof', 'proof', 'write-ingress'])
  assert.equal(saves.at(-1)[0], 'AZURE_SCORE_ADMISSION_STAGE')
  assert.equal(saves.at(-1)[1], 'roles')
  assert.ok(!properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy)
  await transitionIngress({ ...env, ...Object.fromEntries(saves) }, 'restore-guard', dependencies)
  assert.deepEqual(properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy.allowedPrincipals.identities, [env.AZURE_ALLOWED_USER_ID])
  assert.equal(Object.fromEntries(saves).AZURE_SCORE_ADMISSION_STAGE, 'guarded')
  assert.equal(Object.fromEntries(saves).AZURE_SCORE_ROLE_VERIFIED_IMAGE, '')
  properties = easyAuth()
  actions.length = 0
  await assert.rejects(() => transitionIngress(env, 'release-ingress', { ...dependencies, fetch: async () => new Response('', { status: 403 }) }))
  assert.equal(actions.length, 0)
  assert.deepEqual(properties, easyAuth())
})

test('offline predeploy verification executes the current role-aware parser and shared middleware', async () => {
  await verifyAdmissionCode()
})

test('infrastructure provisions isolated tenant grants for the API and persists an explicit ingress stage', async () => {
  const resources = await readFile(new URL('../infra/resources.bicep', import.meta.url), 'utf8')
  const parameters = JSON.parse(await readFile(new URL('../infra/main.parameters.json', import.meta.url), 'utf8'))
  const hooks = await readFile(new URL('../azure.yaml', import.meta.url), 'utf8')
  assert.match(resources, /name: 'application-access'[\s\S]*?paths: \['\/tenantId'\]/)
  assert.match(resources, /resource applicationAccess[\s\S]*?principalId: runtimeIdentity\.properties\.principalId[\s\S]*?colls\/\$\{accessContainer\.name\}/)
  assert.match(resources, /defaultAuthorizationPolicy: admissionStage == 'guarded' \?/)
  assert.equal(parameters.parameters.admissionStage.value, '${AZURE_SCORE_ADMISSION_STAGE}')
  assert.equal(parameters.parameters.authServicePrincipalId.value, '${AZURE_AUTH_SP_OBJECT_ID}')
  assert.equal(parameters.parameters.adminUserIds, undefined)
  assert.match(hooks, /azure-auth\.mjs consent-directory/)
  assert.doesNotMatch(hooks, /release-ingress/)
  assert.doesNotMatch(resources, /SCORE_ADMIN_USER_IDS/)
  for (const file of ['ingestion.bicep', 'grades.bicep', 'private-processing.bicep']) {
    const worker = await readFile(new URL(`../infra/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(worker, /application-access|SCORE_ACCESS_CONTAINER|SCORE_ENTRA_SERVICE_PRINCIPAL_ID/)
  }
})
