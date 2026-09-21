export class WorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly stage: 'download' | 'parsing' | 'rubric',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'WorkerError'
  }
}
