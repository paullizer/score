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
