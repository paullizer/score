import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'

export function source(overrides = {}) {
  return {
    id: 'source-11111111-1111-4111-8111-111111111111',
    workspaceId: 'workspace-one', ladderId: 'ladder-11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-17T00:00:00Z', updatedAt: '2026-09-17T00:00:00Z',
    recordType: 'grade-source', origin: 'url', purpose: 'qualification',
    title: 'Public qualification reference', publisher: 'Supplied source',
    requestedUrl: 'https://agency.example/standard',
    redirects: [], discoveryPath: [], relatedLinks: [], selectedPages: [],
    coverage: { series: ['0801'], grades: [], functions: [], state: 'conditional', explanation: 'Needs source review.' },
    authorityStatus: 'supplied', status: 'extracting', documentId: 'reference-one', documentVersion: 1,
    completeness: 'pending', issues: [], inputFingerprint: 'fixture',
    ...overrides,
  }
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const htmlOriginal = (html, finalUrl = 'https://agency.example/standard') => ({
  bytes: Buffer.from(html), contentType: 'text/html', finalUrl, redirects: [],
})

export async function pdfFixture(count, links = []) {
  const pdf = await PDFDocument.create()
  for (let page = 1; page <= count; page += 1) pdf.addPage([400 + page, 800])
  for (const link of links) {
    const page = pdf.getPage(link.page - 1)
    const action = pdf.context.obj({ S: 'URI', URI: PDFString.of(link.url) })
    const annotation = pdf.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10],
      Contents: PDFString.of(link.label ?? link.url), A: action,
    })
    page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annotation)]))
  }
  return { bytes: await pdf.save(), contentType: 'application/pdf', redirects: [] }
}

export function immutableCache() {
  const values = new Map()
  const writes = []
  return {
    values, writes,
    readChunk: async key => {
      assert.match(key, /^[A-Za-z0-9._-]{1,120}$/)
      return values.get(key)
    },
    writeChunk: async (key, bytes, contentType) => {
      assert.match(key, /^[A-Za-z0-9._-]{1,120}$/)
      writes.push(key)
      if (!values.has(key)) values.set(key, { bytes, contentType, sha256: sha256(bytes), etag: `"${values.size}"` })
    },
  }
}

export function fakeDi(hooks = {}) {
  const submissions = []
  const operations = new Map()
  let now = 0
  let tokenCalls = 0
  const options = {
    endpoint: 'https://di.example',
    getToken: async () => { tokenCalls += 1; return 'test-token' },
    clock: { now: () => new Date(now), sleep: async ms => { now += ms } },
    pollTimeoutMilliseconds: 10_000,
    fetch: async (url, init) => {
      if (init.method === 'POST') {
        const pdf = await PDFDocument.load(init.body)
        const pages = pdf.getPages().map(page => page.getWidth() - 400)
        submissions.push(pages)
        const operationUrl = `https://di.example/documentintelligence/operations/${submissions.length}`
        operations.set(operationUrl, pages)
        await hooks.onSubmit?.(submissions.length, pages)
        return new Response('', { status: 202, headers: { 'operation-location': operationUrl } })
      }
      const pages = operations.get(url)
      if (!pages) throw new Error(`Unexpected operation ${url}`)
      const intercepted = await hooks.onPoll?.(url, pages)
      if (intercepted) return intercepted
      const result = hooks.result?.(pages) ?? {
        status: 'succeeded',
        analyzeResult: {
          pages: pages.map((_, index) => ({ pageNumber: index + 1 })),
          paragraphs: pages.map((page, index) => ({
            content: `Original page ${page}: minimum qualifications or grade-level work must be supported by this reference.`,
            spans: [{ offset: index * 120, length: 100 }], boundingRegions: [{ pageNumber: index + 1 }],
          })),
        },
      }
      return Response.json(result)
    },
  }
  return { options, submissions, operations, get tokenCalls() { return tokenCalls } }
}
