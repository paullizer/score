import { isMain, main } from './lib/runner.mjs'
import { checkAgents } from './review/agents.mjs'
import { checkBinary } from './review/binary.mjs'
import { checkContent } from './review/content.mjs'
import { checkDocker } from './review/docker.mjs'
import { checkInfra } from './review/infra.mjs'
import { checkLockfiles } from './review/lockfile.mjs'
import { checkPackageJson } from './review/manifest.mjs'
import { checkPathSafety } from './review/path-safety.mjs'
import { checkRegistryConfig } from './review/registry.mjs'
import { checkSensitive } from './review/sensitive.mjs'
import { checkUnicode } from './review/unicode.mjs'
import { checkWorkflows } from './review/workflows.mjs'

export function createReviewSpec({ fetch = globalThis.fetch, now = () => new Date() } = {}) {
  return {
    id: 'malicious-pr-review',
    script: 'scripts/security/malicious-pr-review.mjs',
    title: 'Malicious PR and supply-chain review',
    description: [
      'How to read this: Blockers must be fixed before merging. Reviews need a human look. Notes are informational.',
      'This reviewer runs from the base branch, so edits to reviewer rules in a PR take effect only after they merge.',
    ].join(' '),
    suppressions: false,
    showChangedFiles: true,
    options: {
      'verify-release-age': { type: 'boolean', default: false },
      'fail-on-unverified-release-age': { type: 'boolean', default: false },
      'release-age-days': { type: 'string', default: '7' },
    },
    usage: `Malicious PR options:
  --verify-release-age                Verify npm publish age for changed lockfile entries in diff mode.
  --fail-on-unverified-release-age    Treat unverifiable release age as a blocker.
  --release-age-days <n>              Minimum allowed npm package age in days (default: 7).`,
    async check(ctx) {
      const injected = { fetchImpl: fetch, now: now() }
      return [
        ...await checkLockfiles(ctx, injected),
        ...checkPathSafety(ctx),
        ...checkPackageJson(ctx),
        ...checkRegistryConfig(ctx),
        ...checkContent(ctx),
        ...checkUnicode(ctx),
        ...checkBinary(ctx),
        ...checkDocker(ctx),
        ...checkWorkflows(ctx),
        ...checkSensitive(ctx),
        ...checkAgents(ctx),
        ...checkInfra(ctx),
      ]
    },
  }
}

export const spec = createReviewSpec()

if (isMain(import.meta.url)) await main(spec)
