import assert from 'node:assert/strict'
import { AzureCliCredential } from '@azure/identity'

AzureCliCredential.prototype.getToken = async scope => {
  assert.equal(scope, 'https://cognitiveservices.azure.com/.default')
  return { token: 'synthetic-offline-token', expiresOnTimestamp: Date.now() + 3_600_000 }
}

globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://test-account.openai.azure.com/openai/v1/chat/completions')
  const request = JSON.parse(init.body)
  assert.equal(request.model, 'reviewer')
  const data = JSON.parse(request.messages[1].content)
  let output
  if (request.response_format.json_schema.name === 'offline_narrow_verification') {
    const selected = data.scope.criteria.filter(row => row.selected)
    output = {
      inspectedPassageIds: data.scope.completeSourcePassageIds,
      citations: selected.flatMap(row => row.citations.map(item => ({ criterionId: row.criterionId, citationId: item.citationId, verdict: 'relevant' }))),
      claims: selected.flatMap(row => row.claims.map(item => ({ criterionId: row.criterionId, claimId: item.claimId, verdict: 'supported', passageIds: [2] }))),
      omittedEvidence: selected.filter(row => row.omittedEvidenceScan).map(row => ({ criterionId: row.criterionId, outcome: 'none-found' })),
      findings: [],
    }
  } else {
    assert.equal(request.response_format.json_schema.name, 'resume_rubric_grounding_review')
    assert.equal(data.assessment.criteria[0].score, 2)
    output = { outcome: 'supported', issues: [] }
  }
  return Response.json({
    model: 'gpt-5-mini-2025-08-07',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
  })
}
