import { useState } from 'react'
import type { CloudWorkspaceStatus } from '../../app/workspace-context'
import { Button, Modal } from '../ui'

/** Small topbar pill mirroring the local demo's "Saved on this device" indicator, but reflecting the
 * real cloud save lifecycle: Saving / Saved / Error / Conflict. Never claims a save happened before
 * the server acknowledged it. */
export function CloudSaveIndicator({ cloud }: { cloud: CloudWorkspaceStatus }) {
  const label = cloud.saveState === 'saving' ? 'Saving to the cloud\u2026'
    : cloud.saveState === 'saved' ? 'Saved to the cloud'
      : cloud.saveState === 'conflict' ? 'Save conflict'
        : 'Not saved'
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
    <span>{cloud.saveError ?? 'This workspace could not be saved to the cloud.'}</span>
    <Button size="sm" onClick={cloud.retrySave}>Retry saving</Button>
  </div>

  if (cloud.saveState !== 'conflict') return null

  return <>
    <div className="storage-banner" role="alert">
      <span>{cloud.saveError ?? 'Another session already saved a newer version of this workspace. Your changes here are kept, but saving is paused until you choose how to continue.'}</span>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setConfirmReload(true)}>Reload latest</Button>
        <Button size="sm" variant="danger" onClick={() => setConfirmKeepMine(true)}>Keep my changes</Button>
      </div>
    </div>
    <Modal open={confirmReload} onOpenChange={(open) => { if (!busy) setConfirmReload(open) }} title="Reload the latest saved version?"
      description="This discards your unsaved changes in this browser tab and loads what the other session last saved to the cloud."
      footer={<>
        <Button disabled={busy} onClick={() => setConfirmReload(false)}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={async () => { setBusy(true); await cloud.reloadFromServer(); setBusy(false); setConfirmReload(false) }}>Discard mine, reload</Button>
      </>}>
      <p>Any jobs, resumes, rubrics, or analyses changed here since the conflict was detected will be lost. The other session's saved version will replace them.</p>
    </Modal>
    <Modal open={confirmKeepMine} onOpenChange={(open) => { if (!busy) setConfirmKeepMine(open) }} title="Overwrite with your changes?"
      description="This saves exactly what you see here now, discarding whatever the other session saved in the meantime."
      footer={<>
        <Button disabled={busy} onClick={() => setConfirmKeepMine(false)}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={async () => { setBusy(true); await cloud.keepMineAndOverwrite(); setBusy(false); setConfirmKeepMine(false) }}>Overwrite with mine</Button>
      </>}>
      <p>Whatever the other browser or device saved in the meantime will be replaced by this workspace's current content.</p>
    </Modal>
  </>
}
