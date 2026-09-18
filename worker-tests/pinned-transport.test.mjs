import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { nodePinnedTransport } from '../dist-worker/runtime.mjs'

test('native Node transport uses exactly the pinned address rather than dual-stack DNS selection', async () => {
  const server = createServer((request, response) => {
    assert.ok(request.headers.host.startsWith('unresolved.example:'))
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<main>Pinned connection</main>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await nodePinnedTransport({
      url: new URL(`http://unresolved.example:${server.address().port}/job`),
      address: '127.0.0.1',
      method: 'GET',
      headers: {},
      timeoutMilliseconds: 5000,
      maxBytes: 4096,
    })
    assert.equal(result.status, 200)
    assert.equal(Buffer.from(result.body).toString(), '<main>Pinned connection</main>')
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
