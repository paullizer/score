import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { deploymentManifest, sourceReleaseId } from './deployment-release.mjs'

const before = await sourceReleaseId()
const run = args => execFileSync(process.execPath, args, { stdio: 'inherit' })
run(['node_modules/typescript/bin/tsc', '-b'])
run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.worker.json'])
run(['scripts/build-server.mjs'])
run(['scripts/build-worker.mjs'])
run(['--test', '--test-concurrency=2', 'server-tests/prompt-registry.test.mjs', 'server-tests/admin-settings.test.mjs',
  'server-tests/resume-analysis-deployment.test.mjs', 'server-tests/route-auth-inventory.test.mjs',
  'worker-tests/runtime-settings.test.mjs', 'worker-tests/settings-reader-bootstrap.test.mjs',
  'src/services/adminSettings.frontend.integration.test.mjs', 'src/services/workspaceHome.integration.test.mjs'])
run(['scripts/security/check-all.mjs'])
const manifest = await deploymentManifest()
if (manifest.releaseId !== before) throw new Error('Sources changed during deployment checks. Run the deployment again.')
await writeFile('.score-deployment-checks.json', JSON.stringify({ ...manifest, passed: true }))
console.log('Deployment regressions and security checks passed for this exact release.')
