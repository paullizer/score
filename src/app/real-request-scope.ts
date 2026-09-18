export type RealLoadState<T> =
  | { state: 'idle' | 'loading' }
  | { state: 'ready'; value: T; error?: string }
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
    if ((this.accepted.get(key) ?? 0) > sequence) return false
    this.accepted.set(key, sequence)
    return true
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
