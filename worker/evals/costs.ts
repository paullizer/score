import { z } from 'zod'

const identifier = z.string().min(1).max(160)
const micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const modelUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  cacheWriteInputTokens: z.number().int().nonnegative().nullable().optional(),
}).superRefine((usage, context) => {
  if (usage.cachedInputTokens > usage.inputTokens || usage.reasoningTokens !== null && usage.reasoningTokens > usage.outputTokens ||
    usage.cacheWriteInputTokens !== undefined && usage.cacheWriteInputTokens !== null &&
      usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens) {
    context.addIssue({ code: 'custom', message: 'Cached/reasoning counts must be included in input/output totals.' })
  }
})
export const modelPriceSchema = z.strictObject({
  version: identifier,
  currency: z.literal('USD'),
  inputUsdPerMillion: z.number().finite().nonnegative().max(100_000),
  cachedInputUsdPerMillion: z.number().finite().nonnegative().max(100_000),
  outputUsdPerMillion: z.number().finite().nonnegative().max(100_000),
  cacheWriteUsdPerMillion: z.number().finite().nonnegative().max(100_000).optional(),
  cacheWriteBilling: z.enum(['included-in-input', 'separately-metered']).optional(),
}).superRefine((price, context) => {
  if (price.cacheWriteBilling === 'included-in-input' && price.cacheWriteUsdPerMillion !== undefined &&
    price.cacheWriteUsdPerMillion !== price.inputUsdPerMillion) {
    context.addIssue({ code: 'custom', message: 'Input-included cache writes cannot have a different separate write tariff.' })
  }
})

export function estimateModelUsdMicros(rawUsage: unknown, rawPrice: unknown): number | null {
  const price = modelPriceSchema.parse(rawPrice)
  if (rawUsage === null) return null
  const usage = modelUsageSchema.parse(rawUsage)
  if (price.cacheWriteBilling !== 'included-in-input' &&
    (usage.cacheWriteInputTokens === null || usage.cacheWriteInputTokens === undefined)) return null
  const cacheWrites = price.cacheWriteBilling === 'included-in-input' ? 0 : usage.cacheWriteInputTokens ?? 0
  if (cacheWrites > 0 && price.cacheWriteUsdPerMillion === undefined) return null
  const amount = Math.ceil(
    (usage.inputTokens - usage.cachedInputTokens - cacheWrites) * price.inputUsdPerMillion +
    usage.cachedInputTokens * price.cachedInputUsdPerMillion +
    cacheWrites * (price.cacheWriteUsdPerMillion ?? 0) +
    usage.outputTokens * price.outputUsdPerMillion,
  )
  return micros.parse(amount)
}

export const costEntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: identifier, costItemId: identifier, suiteId: identifier,
  category: z.enum(['inference', 'document-intelligence', 'compute', 'storage', 'registry', 'logs', 'network', 'runner']),
  mode: z.enum(['estimate', 'actual']),
  amountUsdMicros: micros.nullable(),
  priceVersion: identifier,
  usage: modelUsageSchema.nullable(),
})

export function summarizeCosts(rawEntries: unknown) {
  const entries = costEntrySchema.array().max(100_000).parse(rawEntries)
  const ids = new Set<string>()
  const items = new Map<string, Partial<Record<'estimate' | 'actual', z.infer<typeof costEntrySchema>>>>()
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error('Duplicate cost event ID.')
    ids.add(entry.id)
    const item = items.get(entry.costItemId) ?? {}
    if (item[entry.mode]) throw new Error('Duplicate estimate or actual settlement for the same cost item.')
    const previous = item.actual ?? item.estimate
    if (previous && (previous.suiteId !== entry.suiteId || previous.category !== entry.category)) {
      throw new Error('A settlement cannot change cost attribution.')
    }
    item[entry.mode] = entry
    items.set(entry.costItemId, item)
  }
  let actualUsdMicros = 0, unbilledEstimateUsdMicros = 0, unknownCostItems = 0
  const byCategory: Record<string, number> = {}
  for (const item of items.values()) {
    const selected = item.actual ?? item.estimate
    if (!selected) throw new Error('Cost item has no observation.')
    if (selected.amountUsdMicros === null) { unknownCostItems++; continue }
    if (selected.mode === 'actual') actualUsdMicros += selected.amountUsdMicros
    else unbilledEstimateUsdMicros += selected.amountUsdMicros
    byCategory[selected.category] = (byCategory[selected.category] ?? 0) + selected.amountUsdMicros
  }
  const totalUsdMicros = micros.parse(actualUsdMicros + unbilledEstimateUsdMicros)
  return { actualUsdMicros, unbilledEstimateUsdMicros, totalUsdMicros, unknownCostItems, byCategory }
}

export const costMilestoneStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  programId: identifier.max(120),
  reportedThroughUsdMicros: micros.refine(value => value % 100_000_000 === 0),
  pending: z.array(z.strictObject({ id: identifier, thresholdUsdMicros: micros })).max(10_000),
}).superRefine((state, context) => {
  const ids = new Set<string>(), thresholds = new Set<number>()
  for (const pending of state.pending) {
    if (ids.has(pending.id) || thresholds.has(pending.thresholdUsdMicros) ||
      pending.thresholdUsdMicros < 100_000_000 || pending.thresholdUsdMicros % 100_000_000 !== 0 ||
      pending.thresholdUsdMicros > state.reportedThroughUsdMicros ||
      pending.id !== `${state.programId}-${pending.thresholdUsdMicros}`) {
      context.addIssue({ code: 'custom', message: 'Milestone outbox contains inconsistent or duplicated receipts.' })
    }
    ids.add(pending.id)
    thresholds.add(pending.thresholdUsdMicros)
  }
})

export function advanceCostMilestones(rawState: unknown, rawEntries: unknown) {
  const state = costMilestoneStateSchema.parse(rawState)
  const costs = summarizeCosts(rawEntries)
  const pending = [...state.pending]
  const threshold = 100_000_000
  const next = Math.floor(costs.totalUsdMicros / threshold) * threshold
  const added = Math.max(0, (next - state.reportedThroughUsdMicros) / threshold)
  if (pending.length + added > 10_000) throw new Error('Acknowledge delivered receipts before exceeding the bounded notification outbox.')
  for (let value = state.reportedThroughUsdMicros + threshold; value <= next; value += threshold) {
    pending.push({ id: `${state.programId}-${value}`, thresholdUsdMicros: value })
  }
  return {
    state: costMilestoneStateSchema.parse({
      ...state, reportedThroughUsdMicros: Math.max(state.reportedThroughUsdMicros, next), pending,
    }),
    costs,
  }
}

export const costDeliveryReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  programId: identifier.max(120),
  deliveredAt: z.string().datetime(),
  channel: z.enum(['copilot-session', 'operator']),
  deliveryReference: z.string().trim().min(1).max(1000),
  milestones: z.array(z.strictObject({ id: identifier, thresholdUsdMicros: micros })).min(1).max(10_000),
}).superRefine((receipt, context) => {
  const ids = new Set<string>()
  for (const milestone of receipt.milestones) {
    if (ids.has(milestone.id) || milestone.thresholdUsdMicros < 100_000_000 ||
      milestone.thresholdUsdMicros % 100_000_000 !== 0 ||
      milestone.id !== `${receipt.programId}-${milestone.thresholdUsdMicros}`) {
      context.addIssue({ code: 'custom', message: 'Delivery receipt contains invalid or duplicate milestone identities.' })
    }
    ids.add(milestone.id)
  }
})

export function acknowledgeCostMilestones(rawState: unknown, rawReceipt: unknown, rawArchivedReceipt?: unknown) {
  const state = costMilestoneStateSchema.parse(rawState)
  const receipt = costDeliveryReceiptSchema.parse(rawReceipt)
  const archived = rawArchivedReceipt === undefined ? undefined : costDeliveryReceiptSchema.parse(rawArchivedReceipt)
  if (receipt.programId !== state.programId ||
    archived !== undefined && JSON.stringify(archived) !== JSON.stringify(receipt)) {
    throw new Error('Cost delivery acknowledgment differs from its program or immutable archived receipt.')
  }
  for (const milestone of receipt.milestones) {
    const pending = state.pending.find(row => row.id === milestone.id)
    if (milestone.thresholdUsdMicros > state.reportedThroughUsdMicros ||
      pending && pending.thresholdUsdMicros !== milestone.thresholdUsdMicros ||
      !pending && !archived) {
      throw new Error('Cost delivery acknowledgment requires a generated pending milestone or its exact archived delivery receipt.')
    }
  }
  const delivered = new Set(receipt.milestones.map(row => row.id))
  return {
    receipt,
    state: costMilestoneStateSchema.parse({
      ...state, pending: state.pending.filter(row => !delivered.has(row.id)),
    }),
  }
}
