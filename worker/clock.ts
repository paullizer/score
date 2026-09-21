import { setTimeout as delay } from 'node:timers/promises'

export interface Clock {
  now(): Date
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
}
