import { createInitialWorkspace } from '../data/fixtures'
import type { Workspace } from '../domain/types'
import { recoverInterrupted, validateWorkspace, WorkspaceValidationError } from '../domain/workspace-validation'
import { workspaceLifecycleTransitionErrors } from '../domain/lifecycle'

export const WORKSPACE_STORAGE_KEY = 'score-demo-workspace-v1'

function storage(): Storage {
  const localStorage = globalThis.localStorage
  if (!localStorage) throw new DOMException('Browser local storage is unavailable.', 'NotSupportedError')
  return localStorage
}

function invalidSavedData(detail: string): { workspace: null; error: string } {
  return {
    workspace: null,
    error: `The saved Score demo is corrupt or uses an unsupported format. ${detail} Your saved data has not been changed. Use Reset demo to replace only Score's demo records, or restore a valid version-1 copy before trying again.`,
  }
}

export function loadWorkspace(): { workspace: Workspace | null; error: string | null } {
  let serialized: string | null
  try {
    serialized = storage().getItem(WORKSPACE_STORAGE_KEY)
  } catch (error) {
    if (!(error instanceof DOMException)) throw error
    return {
      workspace: null,
      error: 'Score cannot access browser storage. Allow local storage for this site or try a browser profile with storage enabled, then try again. No saved data has been replaced; Reset demo can open fresh synthetic records, but saving still requires storage access.',
    }
  }
  if (serialized === null) return { workspace: createInitialWorkspace(), error: null }
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return invalidSavedData('The stored value is not valid JSON.')
  }
  try {
    return { workspace: recoverInterrupted(validateWorkspace(value)), error: null }
  } catch (error) {
    if (!(error instanceof WorkspaceValidationError)) throw error
    return invalidSavedData(error.message)
  }
}

export function saveWorkspace(workspace: Workspace): void {
  let validated: Workspace
  try {
    validated = validateWorkspace(workspace)
  } catch (error) {
    if (!(error instanceof WorkspaceValidationError)) throw error
    throw new Error(`Cannot save invalid Score demo data: ${error.message}`)
  }
  const target = storage()
  const serialized = target.getItem(WORKSPACE_STORAGE_KEY)
  let previous: Workspace | undefined
  if (serialized !== null) {
    try {
      previous = validateWorkspace(JSON.parse(serialized))
    } catch (error) {
      // An explicit recovery reset may replace unreadable data; valid states retain their tombstones.
      if (!(error instanceof SyntaxError) && !(error instanceof WorkspaceValidationError)) throw error
    }
  }
  if (previous) {
    const errors = workspaceLifecycleTransitionErrors(previous, validated)
    if (errors.length) throw new WorkspaceValidationError(errors[0])
  }
  target.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(validated))
}
