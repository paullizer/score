/** Protected record-size reserves, not editable operating limits. */
export const ADMIN_SETTINGS_STORAGE_LIMITS = Object.freeze({
  maxSettingsBytes: 16 * 1024,
  maxSnapshotBytes: 32 * 1024,
})

export function settingsJsonBytes(value: object): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
