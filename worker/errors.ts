export interface ModelRetryMetadata {
  httpStatus?: number
  retryAt?: string
}

export interface WorkerErrorOptions extends ErrorOptions, ModelRetryMetadata {
  cancelled?: boolean
}

export class WorkerError extends Error {
  readonly httpStatus?: number
  readonly retryAt?: string
  readonly cancelled: boolean

  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly stage: 'download' | 'parsing' | 'rubric',
    options?: WorkerErrorOptions,
  ) {
    super(message, options)
    this.name = 'WorkerError'
    this.httpStatus = options?.httpStatus
    this.retryAt = options?.retryAt
    this.cancelled = options?.cancelled ?? false
  }

  get status(): number | undefined { return this.httpStatus }
}
