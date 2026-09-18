import { createHash } from 'node:crypto'

// Preserve the v1/v2 identity algorithm so archived discovery issues can be reconciled without refetching.
export function opmDiscoveryIssueId(code: string, target: string, grade?: number): string {
  return `opm-${createHash('sha256').update(`${code}:${target}:${grade ?? ''}`).digest('hex').slice(0, 20)}`
}
