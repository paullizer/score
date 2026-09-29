import { isTextPath } from '../lib/paths.mjs'
import { BLOCKER, addFinding } from './common.mjs'

const UNSAFE_PATH_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u

function basename(file) {
  return file.slice(file.lastIndexOf('/') + 1)
}

function escapedChar(char) {
  switch (char) {
    case '\n': return '\\n'
    case '\r': return '\\r'
    case '\t': return '\\t'
    case '\0': return '\\0'
    default: {
      const code = char.codePointAt(0)
      return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`
    }
  }
}

function escapePath(file) {
  return [...file].map(char => UNSAFE_PATH_CHARACTER.test(char) ? escapedChar(char) : char).join('')
}

function firstNulLine(text) {
  const index = text.indexOf('\0')
  if (index < 0) return 1
  return text.slice(0, index).split('\n').length
}

export function checkPathSafety(ctx) {
  const findings = []
  for (const entry of ctx.allChangedFiles ?? []) {
    const paths = [entry.path]
    if (entry.oldPath && entry.oldPath !== entry.path) paths.push(entry.oldPath)
    const gitattributesPaths = paths.filter(path => basename(path) === '.gitattributes')
    // A full scan lists every file as added, so only a real change to .gitattributes is reported.
    if (gitattributesPaths.length && !ctx.fullScan) {
      addFinding(findings, {
        rule: 'review/gitattributes-changed',
        verdict: BLOCKER,
        file: entry.status === 'D' ? entry.path : gitattributesPaths[0],
        line: 1,
        message: `.gitattributes changed; attributes can hide changes from reviewers and tools${entry.oldPath ? ` (old path: ${entry.oldPath})` : ''}.`,
        hint: 'Explain the attributes change in the PR; a maintainer must confirm it before merging.',
        side: entry.status === 'D' ? 'base' : 'head',
      })
    }
    for (const path of paths) {
      if (UNSAFE_PATH_CHARACTER.test(path)) {
        const escaped = escapePath(path)
        addFinding(findings, {
          rule: 'review/unsafe-path-characters',
          verdict: BLOCKER,
          file: escaped,
          line: 1,
          message: `Path contains control or invisible characters: ${escaped}.`,
          hint: 'Rename the file so its path uses visible printable characters only.',
          side: entry.status === 'D' || path === entry.oldPath ? 'base' : 'head',
        })
      }
    }
  }
  for (const file of ctx.files) {
    if (!isTextPath(file.path) || !file.hasNulByte) continue
    const text = file.text() ?? ''
    addFinding(findings, {
      rule: 'review/nul-byte',
      verdict: BLOCKER,
      file: file.path,
      line: firstNulLine(text),
      message: 'Text file contains a NUL byte that can hide its diff from reviewers.',
      hint: 'Remove the NUL byte so GitHub and local tools show the text diff.',
    })
  }
  return findings
}
