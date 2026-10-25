/** How many writes a bulk route keeps in flight against the DAV server at once. */
export const DAV_WRITE_CONCURRENCY = 6

/** Runs `fn` over `items` with at most `limit` asynchronous invocations in flight concurrently. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let nextIdx = 0
  const workerCount = Math.min(limit, items.length)
  if (workerCount === 0) return results
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++
      results[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return results
}
