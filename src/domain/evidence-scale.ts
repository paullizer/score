export const EVIDENCE_SCALE_VERSION = 'score-evidence-ladder-v1' as const
export type EvidenceScaleVersion = typeof EVIDENCE_SCALE_VERSION

export type EvidenceLevel = 0 | 1 | 2 | 3 | 4 | 5
export type ExampleLevel = 1 | 2 | 3 | 4 | 5

export const EVIDENCE_LEVELS = Object.freeze([0, 1, 2, 3, 4, 5] as const)
export const EXAMPLE_LEVELS = Object.freeze([1, 2, 3, 4, 5] as const)

type ReadonlyDeep<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly unknown[] ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
  : T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
  : T

function deepFreeze<T extends object>(value: T): ReadonlyDeep<T> {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child)
    }
  }
  return Object.freeze(value) as ReadonlyDeep<T>
}

export const EVIDENCE_SCALE_V1 = deepFreeze({
  version: EVIDENCE_SCALE_VERSION,
  levels: [
    {
      level: 0,
      label: 'No relevant evidence',
      description: 'The résumé shows no relevant evidence. This is a normal, neutral outcome, never a statement about ability.',
    },
    {
      level: 1,
      label: 'Mentioned only',
      description: 'Training, coursework or a listed skill, with no applied example.',
    },
    {
      level: 2,
      label: 'One applied example',
      description: 'One concrete example of doing the work.',
    },
    {
      level: 3,
      label: 'Repeated or ongoing work',
      description: 'Several examples, or a described ongoing duty.',
    },
    {
      level: 4,
      label: 'Broad or complex work',
      description: 'Independent responsibility, larger scope, or choosing or adapting methods.',
    },
    {
      level: 5,
      label: 'Leading or originating the work',
      description: 'Leading or originating the work, with described outcomes or organizational scale.',
    },
  ],
  tieRule: 'When evidence falls between two levels, choose the lower level.',
  basis: 'The level comes from the strongest cited evidence, plus how often and at what scope it appears.',
} as const)

export function evidenceScale(version: string) {
  if (version === EVIDENCE_SCALE_VERSION) return EVIDENCE_SCALE_V1
  throw new Error(`Unknown evidence scale version "${version}".`)
}

export function evidenceStatusForLevel(level: EvidenceLevel): 'missing' | 'partial' | 'supported' {
  if (!Number.isInteger(level) || !EVIDENCE_LEVELS.includes(level as EvidenceLevel)) {
    throw new Error('Evidence level must be an integer 0-5.')
  }
  if (level === 0) return 'missing'
  if (level <= 2) return 'partial'
  return 'supported'
}

export interface CriterionLevelExamples {
  level: ExampleLevel
  examples: string
}

export const LEVEL_EXAMPLE_LIMITS = Object.freeze({ maxCharacters: 600 } as const)

export type EvidenceScaleFindingCode =
  | 'invalid-levels'
  | 'invalid-level'
  | 'duplicate-level'
  | 'out-of-order'
  | 'blank-examples'
  | 'examples-too-long'
  | 'duplicate-examples'
  | 'work-quality'
  | 'error-rate'
  | 'supervision-need'
  | 'attitude'
  | 'level-reference'

export interface EvidenceScaleFinding {
  severity: 'error' | 'warning'
  code: EvidenceScaleFindingCode
  level: ExampleLevel | null
  message: string
  match?: string
}

type WarningCode = Extract<EvidenceScaleFindingCode,
  'work-quality' | 'error-rate' | 'supervision-need' | 'attitude' | 'level-reference'>

interface WarningRule {
  code: WarningCode
  patterns: readonly RegExp[]
}

const WARNING_RULES: readonly WarningRule[] = [
  {
    code: 'work-quality',
    patterns: [
      /\b(?:high[-\s]?quality|good quality|poor quality|low quality|excellent quality)\b/gi,
      /\b(?:acceptable|adequate|satisfactory|satisfactorily|competent|competently|well-written|accurate|accurately)\b/gi,
    ],
  },
  {
    code: 'error-rate',
    patterns: [
      /\berror[-\s]?free\b/gi,
      /\b(?:few|no|minimal|occasional|frequent)\s+(?:errors|mistakes)\b/gi,
      /\berror rates?\b/gi,
      /\brequires\s+(?:edits|corrections|rework)\b/gi,
      /\blapses\b/gi,
    ],
  },
  {
    code: 'supervision-need',
    patterns: [
      /\bwith\s+(?:minimal|limited|little|close|some|no)\s+supervision\b/gi,
      /\bunder\s+(?:close|direct|general)\s+supervision\b/gi,
      /\brequires\s+(?:supervision|guidance|oversight|review)\b/gi,
      /\bneeds\s+(?:supervision|guidance)\b/gi,
    ],
  },
  {
    code: 'attitude',
    patterns: [
      /\b(?:attitude|willing(?:ness)?|eager(?:ness)?|motivated|enthusiastic|enthusiasm|passionate|dedicated|hard[-\s]?working|team player)\b/gi,
    ],
  },
  {
    code: 'level-reference',
    patterns: [
      /\b(?:level\s+[0-5]|score\s+of\s+[0-5]|anchor\s+[0-5])\b/gi,
    ],
  },
]

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function normalizeComparable(value: string): string {
  return normalizeText(value).toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExampleLevel(value: unknown): value is ExampleLevel {
  return Number.isInteger(value) && EXAMPLE_LEVELS.includes(value as ExampleLevel)
}

function error(code: EvidenceScaleFindingCode, level: ExampleLevel | null, message: string): EvidenceScaleFinding {
  return { severity: 'error', code, level, message }
}

function warning(code: WarningCode, level: ExampleLevel, message: string, match: string): EvidenceScaleFinding {
  return { severity: 'warning', code, level, message, match }
}

function sourceContainsQuotedText(quotedText: string, sourceTexts: readonly string[]): boolean {
  const needle = normalizeComparable(quotedText)
  return needle.length > 0 && sourceTexts.some(source => normalizeComparable(source).includes(needle))
}

function matchIsQuotedSource(text: string, matchStart: number, matchEnd: number, sourceTexts: readonly string[]): boolean {
  if (!sourceTexts.length) return false
  const quotePairs: readonly (readonly [string, string])[] = [['"', '"'], ['“', '”']]
  for (const [open, close] of quotePairs) {
    let searchFrom = 0
    while (searchFrom < text.length) {
      const openIndex = text.indexOf(open, searchFrom)
      if (openIndex < 0) break
      const contentStart = openIndex + open.length
      const closeIndex = text.indexOf(close, contentStart)
      if (closeIndex < 0) break
      if (matchStart >= contentStart && matchEnd <= closeIndex) {
        return sourceContainsQuotedText(text.slice(contentStart, closeIndex), sourceTexts)
      }
      searchFrom = closeIndex + close.length
    }
  }
  return false
}

function firstUnquotedMatch(text: string, patterns: readonly RegExp[], sourceTexts: readonly string[]): string | null {
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const matchedText = match[0]
      const index = match.index ?? 0
      if (!matchIsQuotedSource(text, index, index + matchedText.length, sourceTexts)) return matchedText
    }
  }
  return null
}

function warningMessage(code: WarningCode, level: ExampleLevel, match: string): string {
  if (code === 'work-quality') {
    return `Level ${level} examples describe work quality ("${match}"), which a résumé can't show. Describe documented work instead.`
  }
  if (code === 'error-rate') {
    return `Level ${level} examples describe error rates or revisions ("${match}"), which a résumé can't show. Describe documented work instead.`
  }
  if (code === 'supervision-need') {
    return `Level ${level} examples describe supervision need ("${match}"), which a résumé can't show. Describe documented responsibility instead.`
  }
  if (code === 'attitude') {
    return `Level ${level} examples describe attitude or motivation ("${match}"), which a résumé can't show. Describe documented actions instead.`
  }
  return `Level ${level} examples reference evidence levels or scores ("${match}"). Keep examples job-specific and do not redefine the scale.`
}

export function checkCriterionLevels(
  levels: unknown,
  options: { sourceTexts?: readonly string[] } = {},
): EvidenceScaleFinding[] {
  const findings: EvidenceScaleFinding[] = []
  if (!Array.isArray(levels)) {
    return [error('invalid-levels', null, 'Criterion level examples must be an array with levels 1, 2, 3, 4 and 5.')]
  }

  if (levels.length !== EXAMPLE_LEVELS.length) {
    findings.push(error('invalid-levels', null, 'Criterion level examples must contain exactly five entries for levels 1, 2, 3, 4 and 5.'))
  }

  const seenLevels = new Set<ExampleLevel>()
  const seenExamples = new Map<string, ExampleLevel>()
  const validLevels: ExampleLevel[] = []
  const sourceTexts = options.sourceTexts ?? []

  levels.forEach((entry, index) => {
    const fallbackLevel: ExampleLevel | null = isExampleLevel(index + 1) ? index + 1 as ExampleLevel : null
    if (!isRecord(entry)) {
      findings.push(error('invalid-levels', fallbackLevel, `Level ${fallbackLevel ?? index + 1} entry must be an object with level and examples.`))
      return
    }

    const { level, examples } = entry
    const checkedLevel = isExampleLevel(level) ? level : null
    if (!checkedLevel) {
      findings.push(error('invalid-level', null, `Level entry ${index + 1} must use an integer level from 1 to 5.`))
    } else {
      validLevels.push(checkedLevel)
      if (seenLevels.has(checkedLevel)) {
        findings.push(error('duplicate-level', checkedLevel, `Level ${checkedLevel} is duplicated. Use each level from 1 to 5 exactly once.`))
      }
      seenLevels.add(checkedLevel)
    }

    if (typeof examples !== 'string') {
      findings.push(error('blank-examples', checkedLevel, `Level ${checkedLevel ?? index + 1} examples must be non-blank text. Describe documented work.`))
      return
    }

    const normalizedExamples = normalizeText(examples)
    if (!normalizedExamples) {
      findings.push(error('blank-examples', checkedLevel, `Level ${checkedLevel ?? index + 1} examples are blank. Describe documented work.`))
      return
    }

    if (normalizedExamples.length > LEVEL_EXAMPLE_LIMITS.maxCharacters) {
      findings.push(error(
        'examples-too-long',
        checkedLevel,
        `Level ${checkedLevel ?? index + 1} examples are too long. Keep examples to ${LEVEL_EXAMPLE_LIMITS.maxCharacters} characters or fewer.`,
      ))
    }

    const duplicateKey = normalizeComparable(examples)
    const originalLevel = seenExamples.get(duplicateKey)
    if (checkedLevel && originalLevel) {
      findings.push(error(
        'duplicate-examples',
        checkedLevel,
        `Level ${checkedLevel} examples duplicate level ${originalLevel}. Make each level's examples distinct.`,
      ))
    } else if (checkedLevel) {
      seenExamples.set(duplicateKey, checkedLevel)
    }

    if (checkedLevel) {
      for (const rule of WARNING_RULES) {
        const match = firstUnquotedMatch(examples, rule.patterns, sourceTexts)
        if (match) findings.push(warning(rule.code, checkedLevel, warningMessage(rule.code, checkedLevel, match), match))
      }
    }
  })

  if (
    validLevels.length === levels.length
    && (validLevels.length !== EXAMPLE_LEVELS.length || validLevels.some((level, index) => level !== EXAMPLE_LEVELS[index]))
  ) {
    findings.push(error('out-of-order', null, 'Criterion level examples must be in order as levels 1, 2, 3, 4 and 5.'))
  }

  return findings
}

export function renderEvidenceGuidance(
  levels: readonly CriterionLevelExamples[],
  scale = EVIDENCE_SCALE_V1,
): string {
  const examples = parseCriterionLevels(levels)
  const examplesByLevel = new Map<ExampleLevel, string>(examples.map(item => [item.level, item.examples]))
  const lines = scale.levels.map(item => {
    const base = `${item.level}: ${item.label}. ${item.description}`
    if (item.level === 0) return base
    return `${base} Examples: ${examplesByLevel.get(item.level) ?? ''}`
  })
  lines.push(`${scale.tieRule} ${scale.basis}`)
  return lines.join('\n')
}

export function parseCriterionLevels(value: unknown): CriterionLevelExamples[] {
  const findings = checkCriterionLevels(value)
  const errors = findings.filter(item => item.severity === 'error')
  if (errors.length) {
    throw new Error(errors.map(item => item.message).join(' '))
  }
  return (value as Record<string, unknown>[]).map(item => ({
    level: item.level as ExampleLevel,
    examples: normalizeText(item.examples as string),
  }))
}
