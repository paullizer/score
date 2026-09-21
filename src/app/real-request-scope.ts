export type RealLoadState<T> =
  | { state: 'idle' | 'loading' }
  | { state: 'ready'; value: T; error?: string; refreshing?: boolean }
  | { state: 'error'; error: string }

interface Ticket {
  lifetime: number
  sequence: number
}

export interface RealReadTicket extends Ticket {
  key: string
  epoch: number
  controller: AbortController
}

export interface RealMutationTicket extends Ticket {
  key: string
}

// Reads are disposable. An acknowledged mutation must survive a closed dialog, but never a workspace switch.
export class RealRequestScope {
  private alive = true
  private lifetime = 0
  private epoch = 0
  private sequence = 0
  private reads = new Map<string, RealReadTicket>()
  private mutations = new Map<string, RealMutationTicket>()
  private accepted = new Map<string, number>()
  private authoritative = new Map<string, number>()

  activate() { this.alive = true }
  close() { this.alive = false; this.lifetime++; this.invalidateReads(); this.mutations.clear() }
  get isOpen() { return this.alive }
  get busy() { return this.mutations.size > 0 }
  pending(key: string) { return this.mutations.has(key) }
  reading(key: string) { return this.reads.has(key) }

  read(key: string): RealReadTicket | null {
    if (!this.alive || this.busy || this.reads.has(key)) return null
    const ticket = { key, lifetime: this.lifetime, epoch: this.epoch, sequence: ++this.sequence, controller: new AbortController() }
    this.reads.set(key, ticket)
    return ticket
  }

  current(ticket: RealReadTicket): boolean {
    return this.alive && ticket.lifetime === this.lifetime && ticket.epoch === this.epoch
      && !ticket.controller.signal.aborted && this.reads.get(ticket.key) === ticket
  }

  finish(ticket: RealReadTicket) {
    if (this.reads.get(ticket.key) === ticket) this.reads.delete(ticket.key)
  }

  accept(key: string, sequence: number): boolean {
    if (!this.canAccept(key, sequence)) return false
    this.accepted.set(key, sequence)
    return true
  }

  canAccept(key: string, sequence: number): boolean {
    return (this.accepted.get(key) ?? 0) <= sequence
      && [...this.authoritative].every(([prefix, stamp]) => !key.startsWith(prefix) || stamp <= sequence)
  }

  reconcile(prefix: string, sequence: number) {
    this.authoritative.set(prefix, Math.max(this.authoritative.get(prefix) ?? 0, sequence))
  }

  cancelReads(matches: (key: string) => boolean) {
    for (const [key, ticket] of this.reads) if (matches(key)) {
      ticket.controller.abort()
      this.reads.delete(key)
    }
  }

  mutate(key: string): RealMutationTicket {
    if (!this.alive) throw new Error('This workspace is no longer open.')
    if (this.mutations.has(key)) throw new Error('Wait for this request to be acknowledged before trying it again.')
    this.invalidateReads()
    const ticket = { key, lifetime: this.lifetime, sequence: ++this.sequence }
    this.mutations.set(key, ticket)
    return ticket
  }

  mutationCurrent(ticket: RealMutationTicket): boolean {
    return this.alive && ticket.lifetime === this.lifetime && this.mutations.get(ticket.key) === ticket
  }

  finishMutation(ticket: RealMutationTicket) {
    if (this.mutations.get(ticket.key) === ticket) this.mutations.delete(ticket.key)
  }

  private invalidateReads() {
    this.epoch++
    this.reads.forEach((ticket) => ticket.controller.abort())
    this.reads.clear()
  }
}

export function realRequestError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

// This schedules active reads only; request ownership and single-flight remain in RealRequestScope.
export class RealReadBackoff {
  private entries = new Map<string, { revision?: string; delay: number; nextAt: number }>()

  due(key: string, now = Date.now()) { return (this.entries.get(key)?.nextAt ?? 0) <= now }

  record(key: string, revision?: string, now = Date.now()) {
    const previous = this.entries.get(key)
    const changed = revision !== undefined && revision !== previous?.revision
    const delay = !previous || changed ? 3000 : Math.min(previous.delay * 2, 30000)
    this.entries.set(key, { revision: revision ?? previous?.revision, delay, nextAt: now + delay })
  }

  clear(matches: (key: string) => boolean) {
    for (const key of this.entries.keys()) if (matches(key)) this.entries.delete(key)
  }
}
