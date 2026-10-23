import assert from 'node:assert/strict'
import { loadWorker } from './shared-model-loader.mjs'

const {
  redactModelResumeHeading, redactModelResumeText, redactModelResumeTitle, resumePiiFromSnapshot,
} = await loadWorker('../worker/analyses/pii-redaction.ts')

function resolvePii(piiOrSnapshot) {
  if (!piiOrSnapshot) return undefined
  if ('resume' in piiOrSnapshot || 'profile' in piiOrSnapshot || 'source' in piiOrSnapshot) {
    return resumePiiFromSnapshot(piiOrSnapshot)
  }
  return piiOrSnapshot
}

export function assertLosslessResume(view, source, piiOrSnapshot) {
  const pii = resolvePii(piiOrSnapshot)
  let nextPassageId = 1
  assert.equal(view.paragraphs.length, source.paragraphs.length)
  const expectedParagraphs = source.paragraphs.map(paragraph => ({
    ...paragraph,
    heading: redactModelResumeHeading(paragraph.heading, pii),
    text: redactModelResumeText(paragraph.text, pii),
  }))
  const expectedSource = {
    ...source,
    title: redactModelResumeTitle(source.title, pii),
    paragraphs: expectedParagraphs,
  }
  const paragraphs = view.paragraphs.map((paragraph, index) => {
    const { passages, ...metadata } = paragraph
    const { text, ...originalMetadata } = expectedSource.paragraphs[index]
    assert.deepEqual(metadata, originalMetadata)
    assert.ok(Array.isArray(passages) && passages.length > 0)
    if (source.paragraphs[index].text.length <= 4_000) assert.equal(passages.length, 1)
    for (const passage of passages) {
      assert.deepEqual(Object.keys(passage).sort(), ['passageId', 'text'])
      assert.equal(typeof passage.text, 'string')
      assert.ok(passage.text.length > 0 && passage.text.length <= 4_000)
      assert.equal(passage.passageId, passage.text.trim() ? nextPassageId++ : null)
    }
    return { ...metadata, text: passages.map(passage => passage.text).join('') }
  })
  assert.deepEqual({ ...view, paragraphs }, expectedSource)
  return nextPassageId - 1
}

export function assertLosslessModelInput(view, source, piiOrSnapshot) {
  const { resume, ...rest } = view
  const { resume: original, ...originalRest } = source
  assert.deepEqual(rest, originalRest)
  return assertLosslessResume(resume, original, piiOrSnapshot)
}

export function passageSelection(input, paragraphIndex = 0, passageIndex = 0) {
  const { passageId } = input.resume.paragraphs[paragraphIndex].passages[passageIndex]
  assert.ok(Number.isSafeInteger(passageId) && passageId > 0, 'Wire fixtures must select a citable source passage')
  return { passageId }
}
