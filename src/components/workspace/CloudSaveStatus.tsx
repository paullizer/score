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

  if (cloud.saveState === 'error') return <div className="storage-banner" role="alert">
    <span>Sample autosave: {cloud.saveError ?? 'The sample workspace could not be saved to the cloud.'} Real imports and analyses have separate server progress.</span>
    <Button size="sm" onClick={cloud.retrySave}>Retry saving</Button>
  </div>

  if (cloud.saveState !== 'conflict') return null

  return <>
    <div className="storage-banner" role="alert">
      <span>Sample autosave: {cloud.saveError ?? 'Another session saved newer sample content. Your sample changes are kept, but saving is paused until you choose how to continue.'} Real records are not overwritten by either option.</span>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setConfirmReload(true)}>Reload latest</Button>
        <Button size="sm" variant="danger" onClick={() => setConfirmKeepMine(true)}>Keep my changes</Button>
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
      description="This saves your current sample state, discarding the other session’s sample changes. It does not overwrite real records."
      footer={<>
        <Button disabled={busy} onClick={() => setConfirmKeepMine(false)}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={async () => { setBusy(true); await cloud.keepMineAndOverwrite(); setBusy(false); setConfirmKeepMine(false) }}>Overwrite with mine</Button>
      </>}>
      <p>The other browser’s sample changes will be replaced by this tab’s sample state. Server-owned real resumes, sources, rubrics, grade ladders, and analyses remain unchanged.</p>
    </Modal>
  </>
}
