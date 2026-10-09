import type { RubricQaRecord } from '../../src/domain/rubric-approval'
import { WorkerError } from '../../worker/errors'
import { runJobRubricReview, type RubricReviewInput } from '../../worker/rubric-review'
import { RuntimeSettingsError } from '../../worker/settings'
import { HttpError, invalidRequest, tooManyRequests, unavailable } from '../errors'

export { rubricReviewPrompt, validateRubricReview, type RubricReviewInput } from '../../worker/rubric-review'

export class RubricReviewCancelledError extends Error {
  constructor() {
    super('The rubric check was cancelled.')
    this.name = 'RubricReviewCancelledError'
  }
}

/** On-demand checks and generated rubrics use the same versioned review and validation. */
export async function reviewJobRubric(input: RubricReviewInput): Promise<RubricQaRecord['review']> {
  try {
    return await runJobRubricReview(input)
  } catch (error) {
    if (input.signal.aborted || error instanceof DOMException && error.name === 'AbortError') {
      throw new RubricReviewCancelledError()
    }
    if (error instanceof RuntimeSettingsError) {
      throw error.code === 'model-context-limit'
        ? invalidRequest('This rubric is too large for the rubric check with the current model budget.')
        : unavailable('The rubric check is temporarily unavailable. Try again shortly.')
    }
    if (error instanceof WorkerError) {
      if (error.cancelled) throw new RubricReviewCancelledError()
      if (error.httpStatus === 429) {
        const parsed = error.retryAt ? Date.parse(error.retryAt) : Number.NaN
        const seconds = Number.isFinite(parsed) ? Math.max(1, Math.ceil((parsed - (input.now ?? Date.now)()) / 1000)) : 30
        throw tooManyRequests(`The model is busy right now (rate limited). Run the rubric check again in about ${seconds} seconds.`, seconds)
      }
      if (error.httpStatus === 401 || error.httpStatus === 403) {
        throw unavailable('The rubric check\'s model access is misconfigured. Contact an administrator.')
      }
      if (error.code === 'request-timeout') throw unavailable('The rubric check took too long. Try again.')
      if (error.code === 'model-refused') throw new HttpError(502, 'unavailable', 'The model declined to check this rubric.')
      if (error.code === 'model-context-limit') {
        throw invalidRequest('This rubric is too large for the rubric check with the current model budget.')
      }
      if (error.code === 'rubric-review-invalid-output') throw new HttpError(502, 'unavailable', `${error.message} Try again.`)
      throw unavailable('The rubric check is temporarily unavailable. Try again shortly.')
    }
    throw error
  }
}
