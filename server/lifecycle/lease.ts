import { AsyncLocalStorage } from 'node:async_hooks'
import { StoreConflictError, type StateStore } from '../store'

interface MutationContext {
  workspaceId: string
  failure?: Error
}

const context = new AsyncLocalStorage<MutationContext>()

export function assertWorkspaceMutationLease(workspaceId: string): void {
  const current = context.getStore()
  if (!current) return
  if (current.workspaceId !== workspaceId) throw new Error('A workspace mutation cannot cross its lease scope.')
  if (current.failure) throw current.failure
}

export async function withWorkspaceMutationLease<T>(
  state: StateStore,
  workspaceId: string,
  operation: () => Promise<T>,
  options: { requireRelease?: boolean } = {},
): Promise<T> {
  if (context.getStore()) {
    assertWorkspaceMutationLease(workspaceId)
    return operation()
  }
  const lease = await state.acquireMutationLease(workspaceId)
  const current: MutationContext = { workspaceId }
  let releaseFailed = false
  let renewal = Promise.resolve()
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (current.failure) return
      try { await lease.renew() } catch (error) {
        current.failure = error instanceof Error ? error : new StoreConflictError('The workspace mutation lease could not be renewed.')
        console.error('Workspace mutation lease renewal failed:', { workspaceId, name: current.failure.name })
      }
    })
  }, 20_000)
  timer.unref()
  let result: T
  try {
    result = await context.run(current, async () => {
      const result = await operation()
      await renewal
      assertWorkspaceMutationLease(workspaceId)
      await lease.renew()
      return result
    })
  } finally {
    clearInterval(timer)
    await renewal
    current.failure ??= new StoreConflictError('The workspace mutation has finished.')
    try { await lease.release() } catch (error) {
      console.error('Workspace mutation lease release failed:', {
        workspaceId, name: error instanceof Error ? error.name : 'UnknownError',
      })
      releaseFailed = true
    }
  }
  if (releaseFailed && options.requireRelease) {
    throw new StoreConflictError('The upload was saved, but its workspace lock release could not be confirmed. Verify its saved state before retrying with the same import key.')
  }
  return result
}
