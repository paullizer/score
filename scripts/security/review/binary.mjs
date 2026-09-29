import { matchesAny } from '../lib/paths.mjs'
import { binaryAssetAllowlist } from '../policy/review.mjs'
import { BLOCKER, NOTE, REVIEW, addFinding, extension } from './common.mjs'

const EXEC_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.node', '.wasm', '.jar', '.pyc', '.class'])

function magic(buffer) {
  if (!buffer || buffer.length < 4) return null
  const hex4 = buffer.subarray(0, 4).toString('hex')
  const hex2 = buffer.subarray(0, 2).toString('hex')
  if (hex2 === '4d5a') return 'PE executable'
  if (hex4 === '7f454c46') return 'ELF executable'
  if (['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(hex4)) return 'Mach-O executable'
  if (hex4 === '0061736d') return 'WebAssembly module'
  return null
}

export function checkBinary(ctx) {
  const findings = []
  for (const file of ctx.files) {
    const buffer = file.content()
    const kind = magic(buffer)
    const executable = kind || EXEC_EXTENSIONS.has(extension(file.path))
    if (!file.binary && !executable) continue
    const allowlisted = matchesAny(file.path, binaryAssetAllowlist.map(item => item.glob))
    addFinding(findings, {
      rule: executable ? 'review/binary-executable' : (allowlisted ? 'review/binary-asset' : 'review/binary-file'),
      verdict: executable ? BLOCKER : (allowlisted ? NOTE : REVIEW),
      file: file.path,
      line: 1,
      message: executable ? `${kind ?? 'Executable or native-code file'} was added or changed.` : (allowlisted ? 'Binary asset was added or changed in an allowlisted asset path.' : 'Binary file was added or changed.'),
      hint: executable ? 'Do not add executable or native binary payloads in a PR.' : 'Confirm the binary is expected and reviewable.',
    })
  }
  return findings
}
