/**
 * How many resumes or job targets a single request freezes or checks at once. Each one can hold a
 * captured original of up to 10 MiB in memory, so this also bounds a request's working set.
 */
export const ANALYSIS_SOURCE_CONCURRENCY = 8

/**
 * How many GS grade targets resolve at once. A resolved grade holds its whole approved reference set,
 * up to 15 documents of up to 2 million characters each, so grades get a smaller share of the pool.
 */
export const ANALYSIS_GRADE_CONCURRENCY = 2

/**
 * Runs `task` for every item with at most `limit` tasks in flight, starting items in order.
 * After a failure no further items start. Tasks already in flight finish, then the failure with
 * the lowest index is thrown. Every lower index has already started by then, so callers see the
 * same error a sequential loop would have reported.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('The concurrency limit must be a positive integer.')
  const results = new Array<R>(items.length)
  const failures: { index: number; error: unknown }[] = []
  let next = 0
  const worker = async () => {
    while (!failures.length && next < items.length) {
      const index = next++
      try {
        results[index] = await task(items[index], index)
      } catch (error) {
        failures.push({ index, error })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failures.length) throw failures.reduce((lowest, failure) => failure.index < lowest.index ? failure : lowest).error
  return results
}

/** Splits `items` into consecutive chunks of at most `size`, preserving order. */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('The chunk size must be a positive integer.')
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

/**
 * Splits analysis target selections into consecutive chunks that resolve together: at most
 * {@link ANALYSIS_SOURCE_CONCURRENCY} targets, of which at most {@link ANALYSIS_GRADE_CONCURRENCY} are GS grades.
 */
export function analysisTargetChunks<T extends { kind: string }>(targets: readonly T[]): T[][] {
  const chunks: T[][] = []
  let chunk: T[] = []
  let grades = 0
  for (const target of targets) {
    const grade = target.kind === 'grade'
    if (chunk.length === ANALYSIS_SOURCE_CONCURRENCY || (grade && grades === ANALYSIS_GRADE_CONCURRENCY)) {
      chunks.push(chunk)
      chunk = []
      grades = 0
    }
    chunk.push(target)
    if (grade) grades++
  }
  if (chunk.length) chunks.push(chunk)
  return chunks
}
