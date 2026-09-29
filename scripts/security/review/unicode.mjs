import { BLOCKER, REVIEW, addFinding } from './common.mjs'

const BIDI_OR_TAG = /[\u202a-\u202e\u2066-\u2069]|[\u{e0000}-\u{e007f}]/u
const ZERO_WIDTH = /[\u200b\u200c\u2060\u180e]|\u200d|\ufeff/gu

function isEmojiJoiner(text, index) {
  if (text.codePointAt(index) !== 0x200d) return false
  const before = text.codePointAt(index - 2) ?? text.codePointAt(index - 1)
  const after = text.codePointAt(index + 1)
  return before >= 0x1f000 && after >= 0x1f000
}

export function checkUnicode(ctx) {
  const findings = []
  for (const file of ctx.files) {
    const text = file.text()
    if (text === null) continue
    for (const { line, text: lineText } of file.addedLines) {
      if (BIDI_OR_TAG.test(lineText)) {
        addFinding(findings, {
          rule: 'review/hidden-unicode-bidi',
          verdict: BLOCKER,
          file: file.path,
          line,
          message: 'Hidden Unicode bidi or tag characters were added.',
          hint: 'Remove invisible direction-changing characters.',
        })
      }
      for (const match of lineText.matchAll(ZERO_WIDTH)) {
        if (match[0] === '\u200d' && isEmojiJoiner(lineText, match.index)) continue
        if (match[0] === '\ufeff' && line === 1 && match.index === 0) continue
        addFinding(findings, {
          rule: 'review/hidden-unicode-zero-width',
          verdict: REVIEW,
          file: file.path,
          line,
          message: 'Zero-width or BOM character was added.',
          hint: 'Remove invisible characters unless they are required.',
        })
        break
      }
    }
  }
  return findings
}
