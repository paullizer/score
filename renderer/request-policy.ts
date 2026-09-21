import { z } from 'zod'
import type { HostRule } from '../src/domain/admin-settings'

const bounded = (maximum: number, minimum = 1) => z.number().int().min(minimum).max(maximum)
const host = z.strictObject({
  hostname: z.string().min(1).max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i),
  includeSubdomains: z.boolean(),
})
export const renderRequestPolicySchema = z.strictObject({
  rendering: z.strictObject({
    timeoutMilliseconds: bounded(30_000, 1000), settleMilliseconds: bounded(2_000, 0),
    maxRequests: bounded(80), maxAggregateBytes: bounded(8 * 1024 * 1024), maxDomBytes: bounded(2 * 1024 * 1024),
  }),
  urls: z.strictObject({
    requireHttps: z.boolean(), allowedHosts: z.array(host).max(100), blockedHosts: z.array(host).max(100),
    timeoutMilliseconds: bounded(30_000, 1000), maxResponseBytes: bounded(12 * 1024 * 1024),
    maxRedirects: bounded(5, 0),
  }),
}).superRefine((policy, context) => {
  if (policy.rendering.settleMilliseconds >= policy.rendering.timeoutMilliseconds) {
    context.addIssue({ code: 'custom', path: ['rendering', 'settleMilliseconds'], message: 'Settle time must be shorter than the render deadline.' })
  }
  if (policy.rendering.maxDomBytes > policy.rendering.maxAggregateBytes) {
    context.addIssue({ code: 'custom', path: ['rendering', 'maxDomBytes'], message: 'DOM bytes must fit the aggregate render budget.' })
  }
  if (policy.rendering.timeoutMilliseconds > policy.urls.timeoutMilliseconds) {
    context.addIssue({ code: 'custom', path: ['rendering', 'timeoutMilliseconds'], message: 'Rendering must fit the URL operation deadline.' })
  }
})

export type RenderRequestPolicy = z.infer<typeof renderRequestPolicySchema>
export type RuntimeUrlPolicy = Pick<RenderRequestPolicy['urls'], 'requireHttps' | 'allowedHosts' | 'blockedHosts'>

function matches(hostname: string, rule: HostRule): boolean {
  const actual = hostname.toLowerCase().replace(/\.$/, '')
  const expected = rule.hostname.toLowerCase().replace(/\.$/, '')
  return actual === expected || rule.includeSubdomains && actual.endsWith(`.${expected}`)
}

/** Business policy only; DNS pinning and public-address validation are still mandatory. */
export function urlMatchesPolicy(value: string, policy?: RuntimeUrlPolicy): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))) return false
  if (!policy) return true
  return !(policy.requireHttps && url.protocol !== 'https:') &&
    !policy.blockedHosts.some(rule => matches(url.hostname, rule)) &&
    (!policy.allowedHosts.length || policy.allowedHosts.some(rule => matches(url.hostname, rule)))
}
