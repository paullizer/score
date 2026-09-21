export type Theme = 'light' | 'dark' | 'system'

export function resolveTheme(saved: Theme | null, administratorDefault: Theme = 'system', host?: string | null): Theme {
  return host === 'dark' || host === 'light' ? host : saved ?? administratorDefault
}
