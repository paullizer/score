const globCache = new Map()

/** Converts a repo-relative glob (`**`, `*`, `?`) into an anchored regular expression. */
export function globToRegExp(glob) {
  let cached = globCache.get(glob)
  if (cached) return cached
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        const followedBySlash = glob[index + 2] === '/'
        source += followedBySlash ? '(?:.*/)?' : '.*'
        index += followedBySlash ? 2 : 1
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  cached = new RegExp(`^${source}$`)
  globCache.set(glob, cached)
  return cached
}

export function matchesAny(file, globs = []) {
  return globs.some(glob => globToRegExp(glob).test(file))
}

export function toPosix(file) {
  return file.replace(/\\/g, '/')
}

export function isTestPath(file) {
  return /(^|\/)(server|worker|renderer)-tests\//.test(file)
    || /\.test\.[cm]?[jt]sx?$/.test(file)
    || /(^|\/)(__tests__|fixtures)\//.test(file)
}

const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'xml', 'plist',
  'md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'csv', 'tsv',
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'svg', 'map',
  'bicep', 'bicepparam', 'tf', 'tfvars', 'hcl',
  'ps1', 'psm1', 'psd1', 'sh', 'bash', 'zsh', 'fish', 'cmd', 'bat',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'cs', 'php', 'pl', 'lua', 'sql', 'graphql', 'gql', 'proto',
  'lock', 'env', 'dockerfile', 'patch', 'diff',
])
const TEXT_BASENAMES = new Set([
  '.gitattributes', '.gitignore', '.gitmodules', '.gitkeep', '.mailmap', '.lfsconfig',
  '.npmrc', '.yarnrc', '.nvmrc', '.node-version', '.editorconfig', '.dockerignore', '.eslintignore', '.prettierignore',
  '.prettierrc', '.eslintrc', '.babelrc', '.browserslistrc', '.markdownlint', '.funcignore',
  'dockerfile', 'containerfile', 'makefile', 'procfile', 'license', 'licence', 'notice', 'readme', 'changelog', 'codeowners',
])

/**
 * Files that must be read as text however they look: source, config, scripts and docs.
 * Content in these is always analysed, even if it contains NUL bytes that make git call it binary.
 */
export function isTextPath(file) {
  const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
  if (TEXT_BASENAMES.has(base) || base.startsWith('.env') || /^(docker|container)file\./.test(base)) return true
  const dot = base.lastIndexOf('.')
  return dot > 0 && TEXT_EXTENSIONS.has(base.slice(dot + 1))
}

export function isDocPath(file) {
  return /^docs\//.test(file) || (/\.(md|markdown|txt)$/i.test(file) && !file.startsWith('.github/'))
}

/** Risk areas, first match wins. Used to group reports and to decide whether content rules are downgraded. */
export const RISK_AREAS = [
  { id: 'github', label: 'GitHub configuration and agent instructions', test: file => file.startsWith('.github/') || /^(AGENTS|CLAUDE)\.md$/i.test(file) },
  { id: 'security-tooling', label: 'Security tooling', test: file => file.startsWith('scripts/security/') },
  { id: 'dependencies', label: 'Dependency manifests', test: file => /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|\.npmrc|\.yarnrc(\.yml)?|yarn\.lock|pnpm-lock\.yaml)$/.test(file) },
  { id: 'tests', label: 'Tests and fixtures', test: isTestPath },
  { id: 'deployment', label: 'Infrastructure and deployment', test: file => file.startsWith('infra/') || file.startsWith('scripts/') || file === 'azure.yaml' || /(^|\/)Dockerfile[^/]*$/.test(file) || /\.dockerignore$/.test(file) },
  { id: 'server', label: 'Server (Express API)', test: file => file.startsWith('server/') },
  { id: 'browser', label: 'Browser (React SPA)', test: file => file.startsWith('src/') || file.startsWith('public/') || file === 'index.html' },
  { id: 'worker', label: 'Workers', test: file => file.startsWith('worker/') },
  { id: 'renderer', label: 'Renderer', test: file => file.startsWith('renderer/') },
  { id: 'docs', label: 'Documentation', test: isDocPath },
  { id: 'other', label: 'Other', test: () => true },
]

export function riskArea(file) {
  return RISK_AREAS.find(area => area.test(file)).id
}

export function riskAreaLabel(id) {
  return RISK_AREAS.find(area => area.id === id)?.label ?? id
}
