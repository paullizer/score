import { BLOCKER, REVIEW, addFinding, lineMatcher } from './common.mjs'

const LIFECYCLE = new Set(['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'])
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

function parseManifest(text, file, findings) {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    addFinding(findings, { rule: 'review/package-json', verdict: BLOCKER, file, line: 1, message: 'package.json is not valid JSON.' })
    return {}
  }
}

function changed(base, head, key) {
  return JSON.stringify(base?.[key] ?? null) !== JSON.stringify(head?.[key] ?? null)
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function flattenedOverrides(value, prefix = []) {
  if (!isObject(value)) return []
  const result = []
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') result.push([[...prefix, key].join(' > '), child])
    else if (isObject(child)) result.push(...flattenedOverrides(child, [...prefix, key]))
  }
  return result
}

function specProblem(spec) {
  const value = String(spec ?? '').trim()
  if (!value || ['*', 'latest', 'x', 'X'].includes(value)) return 'uses an unbounded dependency specifier'
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|link:|npm:)/i.test(value)) return 'uses a non-registry dependency specifier'
  if (/^[\w.-]+\/[\w.-]+(?:#.+)?$/.test(value)) return 'uses repository shorthand instead of a registry range'
  return null
}

function addedOrChanged(base = {}, head = {}) {
  const result = []
  for (const [key, value] of Object.entries(head ?? {})) {
    if (JSON.stringify(base?.[key]) !== JSON.stringify(value)) result.push([key, value])
  }
  return result
}

export function checkPackageJson(ctx) {
  const findings = []
  for (const file of ctx.files.filter(item => /(^|\/)package\.json$/.test(item.path))) {
    const headText = file.text() ?? ''
    const base = parseManifest(file.baseText(), file.path, findings)
    const head = parseManifest(headText, file.path, findings)
    const lineOf = lineMatcher(headText)
    for (const [name] of addedOrChanged(base.scripts, head.scripts)) {
      if (ctx.fullScan && !LIFECYCLE.has(name)) continue
      const verdict = LIFECYCLE.has(name) ? BLOCKER : REVIEW
      addFinding(findings, {
        rule: LIFECYCLE.has(name) ? 'review/package-lifecycle-script' : 'review/package-script-changed',
        verdict,
        file: file.path,
        line: lineOf(`"${name}"`),
        message: `${name} script was added or changed.`,
        hint: verdict === BLOCKER ? 'Install-time scripts run during dependency installation and need removal or strong justification.' : 'Review changed package scripts before merging.',
      })
    }
    for (const section of DEP_SECTIONS) {
      for (const [name, spec] of Object.entries(head[section] ?? {})) {
        const problem = specProblem(spec)
        if (problem) {
          addFinding(findings, {
            rule: 'review/package-dependency-specifier',
            verdict: BLOCKER,
            file: file.path,
            line: lineOf(`"${name}"`),
            message: `${section}.${name} ${problem}.`,
            hint: 'Use an npm registry semver range.',
          })
        } else if (!ctx.fullScan && !(name in (base[section] ?? {}))) {
          addFinding(findings, {
            rule: 'review/package-new-dependency',
            verdict: REVIEW,
            file: file.path,
            line: lineOf(`"${name}"`),
            message: `${name} is a new direct dependency in ${section}.`,
            hint: 'Review the package purpose, maintainer and lockfile entry.',
          })
        }
      }
    }
    for (const [name, spec] of flattenedOverrides(head.overrides)) {
      const problem = specProblem(spec)
      if (problem) {
        addFinding(findings, {
          rule: 'review/package-dependency-specifier',
          verdict: BLOCKER,
          file: file.path,
          line: lineOf(`"${name.split(' > ').at(-1)}"`),
          message: `override ${name} ${problem}.`,
          hint: 'Use an npm registry semver range.',
        })
      }
    }
    if (!ctx.fullScan && changed(base, head, 'overrides')) addFinding(findings, { rule: 'review/package-overrides-changed', verdict: REVIEW, file: file.path, line: lineOf('"overrides"'), message: 'Package overrides changed.', hint: 'Review dependency substitution risk.' })
    if (!ctx.fullScan && changed(base, head, 'bin')) addFinding(findings, { rule: 'review/package-bin-changed', verdict: REVIEW, file: file.path, line: lineOf('"bin"'), message: 'Package bin entries changed.', hint: 'Review newly exposed commands.' })
  }
  return findings
}
