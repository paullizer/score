import type { QueryIterator } from '@azure/cosmos'

export async function fetchCosmosPage<T>(
  iterator: Pick<QueryIterator<T>, 'fetchNext'>,
): Promise<{ resources: T[]; continuationToken?: string }> {
  // ORDER BY can emit progress-only responses before a data page or exhaustion.
  for (let progress = 0; progress < 100; progress++) {
    const response = await iterator.fetchNext()
    if (Array.isArray(response.resources)) {
      if (!response.resources.length && response.hasMoreResults === true && !response.continuationToken) continue
      return {
        resources: response.resources,
        ...(response.continuationToken ? { continuationToken: response.continuationToken } : {}),
      }
    }
    if (response.resources !== undefined || typeof response.hasMoreResults !== 'boolean') {
      throw new Error('Cosmos returned an invalid query page.')
    }
    if (!response.hasMoreResults) {
      if (response.continuationToken) throw new Error('Cosmos returned inconsistent query progress.')
      return { resources: [] }
    }
  }
  throw new Error('Cosmos query exceeded its progress-page limit.')
}

export async function fetchCosmosCount(
  iterator: Pick<QueryIterator<unknown>, 'fetchNext'>,
): Promise<number> {
  const tokens = new Set<string>()
  // Aggregate iterators may report progress, but only one terminal scalar is a complete count.
  for (let progress = 0; progress < 100; progress++) {
    const { resources, hasMoreResults, continuationToken } = await iterator.fetchNext()
    if ((hasMoreResults !== undefined && typeof hasMoreResults !== 'boolean') ||
      (continuationToken !== undefined && (typeof continuationToken !== 'string' || continuationToken.length > 16 * 1024)) ||
      (hasMoreResults === false && continuationToken)) {
      throw new Error('Cosmos returned invalid aggregate progress.')
    }
    if (continuationToken) {
      if (tokens.has(continuationToken)) throw new Error('Cosmos aggregate continuation did not advance.')
      tokens.add(continuationToken)
    }
    const more = hasMoreResults === true || Boolean(continuationToken)
    if ((resources === undefined || Array.isArray(resources) && resources.length === 0) && more) continue
    if (!Array.isArray(resources) || resources.length !== 1 || more ||
      typeof resources[0] !== 'number' || !Number.isSafeInteger(resources[0]) || resources[0] < 0) {
      throw new Error('Cosmos returned an invalid aggregate count.')
    }
    return resources[0]
  }
  throw new Error('Cosmos aggregate exceeded its progress-page limit.')
}
