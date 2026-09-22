import { useState } from 'react'
import type { CloudWorkspaceStatus } from '../../app/workspace-context'
import { Button, Modal } from '../ui'

/** Small topbar pill mirroring the local demo's "Saved on this device" indicator, but reflecting the
 * real cloud save lifecycle: Saving / Saved / Error / Conflict. Never claims a save happened before
 * the server acknowledged it. */
export function CloudSaveIndicator({ cloud }: { cloud: CloudWorkspaceStatus }) {
  const label = cloud.saveState === 'saving' ? 'Saving samples\u2026'
    : cloud.saveState === 'saved' ? 'Samples saved'
      : cloud.saveState === 'conflict' ? 'Sample save conflict'
        : 'Samples not saved'
  const tone = cloud.saveState === 'saved' ? '' : cloud.saveState === 'saving' ? 'is-saving' : 'is-error'
  return <span className={`save-status ${tone}`.trim()}><span />{label}</span>
}

/**
 * Actionable banner shown only when saving is not simply in-progress or complete: a retryable error,
 * or an explicit conflict that requires the user to choose between reloading the server's latest
 * save (discarding local edits) or overwriting it with what is on screen (discarding the other
 * session's save). Neither happens silently or automatically.
 */
export function CloudSaveBanner({ cloud }: { cloud: CloudWorkspaceStatus }) {
  const [confirmReload, setConfirmReload] = useState(false)
  const [confirmKeepMine, setConfirmKeepMine] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [leaveError, setLeaveError] = useState('')
  const metadata = cloud.workspaces.find((item) => item.id === cloud.currentWorkspaceId)
  const unavailable = !metadata || metadata.deletedAt
  const readOnly = unavailable || metadata?.role === 'viewer' || metadata?.archivedAt

  if (unavailable) return <>
    <div className="storage-banner" role="alert"><span>This workspace was deleted elsewhere. Unsaved changes remain in this tab, but cannot recreate deleted records.</span>
      <Button size="sm" onClick={() => setConfirmLeave(true)}>Choose another workspace</Button></div>
    <Modal open={confirmLeave} onOpenChange={(open) => { if (!busy) setConfirmLeave(open) }} title="Discard unsaved changes and leave?"
      description="The deleted workspace cannot be restored. This explicitly discards sample changes kept only in this tab before opening the workspace picker."
      footer={<><Button disabled={busy} onClick={() => setConfirmLeave(false)}>Keep this tab</Button><Button variant="danger" disabled={busy} onClick={() => {
        setBusy(true); setLeaveError('')
        void cloud.leaveUnavailableWorkspace().then((result) => { if (!result.ok) setLeaveError(result.message) }).catch((error) => setLeaveError(error instanceof Error ? error.message : 'The workspace could not be left.')).finally(() => setBusy(false))
      }}>Discard local changes and leave</Button></>}>
      <p>Saved server data in other workspaces is not affected. Unsaved real-grade edits still require their separate leave confirmation.</p>
      {leaveError && <p role="alert">{leaveError}</p>}
    </Modal>
  </>

  if (cloud.saveState === 'error' && !readOnly) return <div className="storage-banner" role="alert">
    <span>Sample autosave: {cloud.saveError ?? 'The sample workspace could not be saved to the cloud.'} Real imports and analyses have separate server progress.</span>
    <Button size="sm" onClick={cloud.retrySave}>Retry saving</Button>
  </div>

  if (cloud.saveState !== 'conflict' && !(readOnly && cloud.saveState === 'error')) return null

  return <>
    <div className="storage-banner" role="alert">
      <span>Sample autosave: {cloud.saveError ?? 'Another session saved newer sample content. Your sample changes are kept, but saving is paused until you choose how to continue.'} Real records are not overwritten by either option.</span>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setConfirmReload(true)}>Reload latest</Button>
        {!readOnly && <Button size="sm" variant="danger" onClick={() => setConfirmKeepMine(true)}>Keep my changes</Button>}
      </div>
    </div>
    <Modal open={confirmReload} onOpenChange={(open) => { if (!busy) setConfirmReload(open) }} title="Reload the latest saved version?"
      description="This discards unsaved sample changes in this browser tab and loads the other session’s saved sample state. Real sources and analyses are separate."
      footer={<>
        <Button disabled={busy} onClick={() => setConfirmReload(false)}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={async () => { setBusy(true); await cloud.reloadFromServer(); setBusy(false); setConfirmReload(false) }}>Discard mine, reload</Button>
      </>}>
      <p>Sample jobs, fictional resumes, sample rubrics, and simulated analyses changed since the conflict will be replaced. Private real resumes, jobs, grade ladders, captures, and real analysis results are not changed.</p>
    </Modal>
    <Modal open={confirmKeepMine} onOpenChange={(open) => { if (!busy) setConfirmKeepMine(open) }} title="Overwrite with your changes?"
      description="This replaces ordinary sample edits from another session, never real records. Archive and deletion decisions remain protected; removed content cannot be restored by overwriting."
      footer={<>
        <Button disabled={busy} onClick={() => setConfirmKeepMine(false)}>Cancel</Button>
        <Button variant="danger" disabled={busy || Boolean(readOnly)} onClick={async () => { setBusy(true); await cloud.keepMineAndOverwrite(); setBusy(false); setConfirmKeepMine(false) }}>Overwrite with mine</Button>
      </>}>
      <p>If another session archived or deleted content, reload the latest workspace instead. Score will keep your unsaved state in this tab and reject an overwrite that would resurrect removed records.</p>
      <p>Server-owned real resumes, sources, rubrics, grade ladders, and analyses remain unchanged.</p>
    </Modal>
  </>
}
