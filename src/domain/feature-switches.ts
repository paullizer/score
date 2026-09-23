import type { AdminSettings } from './admin-settings'

/**
 * Product feature switches live in Admin settings (`features.*`), never in environment variables.
 * Switches added after earlier revisions were saved are optional, so an absent key means the documented default.
 */

/** On unless an administrator turned it off; revisions saved before the switch existed omit the key. */
export function rubricAssistantEnabled(settings: Pick<AdminSettings, 'features'>): boolean {
  return settings.features.rubricAssistant !== false
}
