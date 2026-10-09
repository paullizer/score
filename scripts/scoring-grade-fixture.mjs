import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { link, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { client, environment, identifier, required } from './azure-common.mjs'

const exec = promisify(execFile)
const MAX_FIXTURE_BYTES = 32 * 1024 * 1024

function fixedAzureEndpoint(value, suffix, name) {
  let url
  try { url = new URL(value) } catch { throw new Error(`${name} must be a fixed Azure HTTPS account endpoint.`) }
  const account = url.hostname.slice(0, -suffix.length)
  if (url.protocol !== 'https:' || !url.hostname.endsWith(suffix) || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(account) ||
    url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be a fixed Azure HTTPS account endpoint.`)
  }
  return url.origin
}

export function fixtureDeployment(env) {
  const endpoint = fixedAzureEndpoint(required(env, 'COSMOS_ENDPOINT'), '.documents.azure.com', 'COSMOS_ENDPOINT')
  const accountUrl = fixedAzureEndpoint(required(env, 'STORAGE_ACCOUNT_URL'), '.blob.core.windows.net', 'STORAGE_ACCOUNT_URL')
  const database = env.COSMOS_DATABASE || 'score'
  const workspaceContainer = env.COSMOS_CONTAINER || 'workspaces'
  const gradeContainer = env.GRADE_RECORDS_CONTAINER || 'grade-records'
  const stateContainer = env.WORKSPACE_BLOB_CONTAINER || 'workspace-state'
  const sourceContainer = env.GRADE_SOURCE_CONTAINER || 'grade-sources'
  for (const value of [database, workspaceContainer, gradeContainer, stateContainer, sourceContainer]) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(value)) throw new Error('Invalid evaluation storage resource name.')
  }
  if (workspaceContainer === gradeContainer || stateContainer === sourceContainer) {
    throw new Error('Evaluation grade storage must not alias workspace metadata or state.')
  }
  return {
    cosmos: { endpoint, database, container: workspaceContainer },
    storage: { accountUrl, containerName: stateContainer },
    grades: { cosmosEndpoint: endpoint, database, container: gradeContainer, storageAccountUrl: accountUrl, blobContainer: sourceContainer },
  }
}

/** Claims are read only from the same Azure CLI token used by the SDK, never from a caller-supplied object ID. */
export function fixtureIdentity(token, tenantId, now = Date.now()) {
  identifier(tenantId, 'Tenant')
  let claims
  try {
    const parts = token?.token?.split('.')
    if (parts?.length !== 3) throw new Error('Not an Entra access token.')
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch { throw new Error('Azure CLI did not return a readable Entra identity token.') }
  if (!claims || typeof claims.tid !== 'string' || claims.tid.toLowerCase() !== tenantId.toLowerCase() ||
    typeof claims.oid !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(claims.oid ?? '') ||
    !['https://cosmos.azure.com', 'https://cosmos.azure.com/'].includes(claims.aud) ||
    !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now ||
    !Number.isFinite(token.expiresOnTimestamp) || token.expiresOnTimestamp <= now) {
    throw new Error('Azure CLI identity must be a current Cosmos token for the configured tenant.')
  }
  return { tenantId: claims.tid.toLowerCase(), oid: claims.oid.toLowerCase() }
}

export async function privateFixtureDestination(file) {
  const requested = resolve(file)
  let ancestor = dirname(requested)
  for (;;) {
    try { await realpath(ancestor); break } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw new Error('The private output has no existing parent directory.')
      ancestor = parent
    }
  }
  const actual = await realpath(ancestor)
  const gitEnv = { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES']) delete gitEnv[key]
  try {
    await exec('git', ['-C', actual, 'rev-parse', '--show-toplevel'], { env: gitEnv })
  } catch (error) {
    if (error.code !== 128 ||
      error.stderr?.trim() !== 'fatal: not a git repository (or any of the parent directories): .git') {
      throw new Error('Git could not verify that the fixture output is outside a checkout.')
    }
    return resolve(actual, relative(ancestor, requested))
  }
  throw new Error('Evaluation fixtures contain private captured evidence and must be written outside every Git checkout.')
}

export async function writePrivateGradeFixture(file, fixture) {
  const serialized = JSON.stringify(fixture)
  if (serialized === undefined) throw new Error('The evaluation fixture is not JSON serializable.')
  const content = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`)
  if (content.byteLength > MAX_FIXTURE_BYTES) throw new Error('The complete fixture exceeds the 32 MiB export limit; no sources were omitted.')
  const output = await privateFixtureDestination(file)
  await mkdir(dirname(output), { recursive: true })
  await privateFixtureDestination(output)
  const temporary = `${output}.${randomUUID()}.tmp`
  let created = false
  try {
    const handle = await open(temporary, 'wx', 0o600)
    created = true
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await link(temporary, output)
  } finally {
    if (created) await unlink(temporary)
  }
  return { file: output, bytes: content.byteLength, fixtureSha256: createHash('sha256').update(serialized).digest('hex') }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts\\scoring-grade-fixture.mjs <workspace-id> <ladder-id> <private-output.json>')
    return
  }
  if (args.length !== 3) throw new Error('Provide one workspace, one ladder and one private output JSON path. Use --help for usage.')
  const [workspaceId, ladderId, output] = args
  await privateFixtureDestination(output)
  const api = await import('../dist-server/app.mjs')
  if (!api.isValidWorkspaceId(workspaceId) || !/^ladder-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(ladderId)) {
    throw new Error('Invalid workspace or ladder identity.')
  }
  const env = environment()
  const deployment = fixtureDeployment(env)
  const credential = client(env)
  const token = await credential.getToken('https://cosmos.azure.com/.default')
  const identity = fixtureIdentity(token, required(env, 'AZURE_TENANT_ID'))
  const principal = {
    ...identity, principalKey: api.principalKeyFor(identity.tenantId, identity.oid),
    name: 'Local evaluation exporter', email: '', applicationRoles: [],
  }
  const repository = new api.WorkspaceRepository({
    directory: api.createAzureDirectoryStore(deployment.cosmos, credential),
    state: api.createAzureStateStore(deployment.storage, credential),
  })
  const fixture = await api.captureGradeGenerationFixture(repository, {
    store: api.createAzureGradeStore(deployment.grades, credential),
    blobs: api.createAzureGradeBlobStore(deployment.grades, credential),
  }, principal, workspaceId, ladderId)
  const result = await writePrivateGradeFixture(output, fixture)
  console.log(JSON.stringify({ event: 'grade-fixture-exported', ...result, sourceSetId: fixture.sourceSet.id, grades: fixture.sourceSet.grades }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error('Grade fixture export failed:', error instanceof Error ? error.message : 'Unexpected export failure.')
    process.exitCode = 1
  })
}
