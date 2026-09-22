import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Clock3, Layers3, RefreshCw, Settings, ShieldCheck, Users } from 'lucide-react'
import type { CloudUser, WorkspaceSummary } from '../../domain/cloud'
import { ThemeControl } from '../../app/ThemeControl'
import { ApplicationPolicyBanners } from '../../app/ApplicationPolicyBanners'
import { usePublicSettings } from '../../app/public-settings-context'
import { AccountPanel } from '../../components/workspace/AccountPanel'
import { WorkspaceCreateButton, WorkspaceDirectory, type WorkspaceDirectoryActions } from '../../components/workspace/WorkspaceDirectory'
import { LifecycleDialogProvider } from '../../components/lifecycle/LifecycleControls'
import { Button, InlineError, PageHeader } from '../../components/ui'
import { isActiveWorkspace, type RecentWorkspace } from '../../services/workspaceRecents'
import { useWorkspaceCounts, type WorkspaceCountsState } from './useWorkspaceCounts'

export function WorkspaceHomePage({ user, directory, recents, directoryRevision, directoryError, directoryReady, applicationAdmin, openAdminSettings, openAdminUsers, signOut, onAuthError }: {
  user: CloudUser
  directory: WorkspaceDirectoryActions
  recents: RecentWorkspace[]
  directoryRevision: number
  directoryError: string | null
  directoryReady: boolean
  applicationAdmin: boolean
  openAdminSettings: () => Promise<void>
  openAdminUsers: () => Promise<void>
  signOut: () => Promise<void>
  onAuthError: (message: string) => void
}) {
  const policy = usePublicSettings()
  const [visibleIds, setVisibleIds] = useState<string[]>([])
  const [directoryBusy, setDirectoryBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const main = useRef<HTMLElement>(null)
  useEffect(() => { main.current?.querySelector('h1')?.focus() }, [])
  const { states, retryCounts } = useWorkspaceCounts(JSON.stringify([user.tenantId, user.id]), directory.workspaces, visibleIds, directoryRevision, onAuthError)
  const title = policy.settings?.appearance.applicationTitle ?? 'Score'
  const active = directory.workspaces.filter(isActiveWorkspace)
  const recent = active.length > 1 ? recents.flatMap((entry) => {
    const workspace = active.find((item) => item.id === entry.id)
    return workspace ? [{ ...entry, workspace }] : []
  }).slice(0, 3) : []
  const busy = directoryBusy || creating || opening

  async function openRecent(id: string) {
    if (busy) return
    setOpening(true); setError('')
    try {
      const result = await directory.switchWorkspace(id)
      if (!result.ok) setError(result.message)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'This workspace could not be opened. Try again.')
    } finally { setOpening(false) }
  }

  return <LifecycleDialogProvider><div className="workspace-home">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="workspace-home-header">
      <a href={policy.hostTheme ? `/?scoutTheme=${policy.hostTheme}` : '/'} className="brand" aria-label={`${title} home`}><span className="brand-mark"><Layers3 size={22} strokeWidth={2} /></span><span>{title}</span></a>
      <div className="workspace-home-utilities">
        {applicationAdmin && <Button variant="ghost" icon={Settings} disabled={busy} onClick={() => {
          void openAdminSettings().catch((caught) => setError(caught instanceof Error ? caught.message : 'Application settings could not be opened.'))
        }}>Application settings</Button>}
        {applicationAdmin && <Button variant="ghost" icon={Users} disabled={busy} onClick={() => {
          void openAdminUsers().catch((caught) => setError(caught instanceof Error ? caught.message : 'User access could not be opened.'))
        }}>Users / user access</Button>}
        <ThemeControl /><AccountPanel user={user} signOut={signOut} />
      </div>
    </header>
    <ApplicationPolicyBanners />
    <main ref={main} id="main-content" className="workspace-home-main">
      <PageHeader eyebrow="YOUR WORK, ORGANIZED" title="My workspaces" description="Choose a workspace to pick up where you left off, or make room for something new."
        actions={<WorkspaceCreateButton primary cloud={directory} disabled={!directoryReady || directoryBusy || opening} onBusyChange={setCreating} />} />
      {directoryError && <div className="mb-5"><InlineError>{directoryError}<Button size="sm" disabled={busy} icon={RefreshCw}
        onClick={() => { void directory.refreshWorkspaces().catch((caught) => setError(caught instanceof Error ? caught.message : 'The workspace directory could not be refreshed.')) }}>Retry workspace list</Button></InlineError></div>}
      {error && <div className="mb-5"><InlineError>{error}</InlineError></div>}
      {recent.length > 0 && <section className="workspace-recent-section" aria-labelledby="recent-workspaces-heading">
        <div className="workspace-section-heading"><h2 id="recent-workspaces-heading"><Clock3 size={16} aria-hidden="true" />Recent workspaces</h2><span>Opened in this browser</span></div>
        <ul className="workspace-recent-grid">{recent.map((entry) => <li key={entry.id}>
          <button className="workspace-recent-link" type="button" disabled={busy} onClick={() => void openRecent(entry.id)} aria-label={`Open recent workspace ${entry.workspace.name}`}>
            <span className="workspace-monogram" aria-hidden="true">{entry.workspace.name.trim().slice(0, 1).toUpperCase()}</span>
            <span className="workspace-recent-label"><strong>{entry.workspace.name}</strong><span>{entry.lastOpenedAt
              ? <time dateTime={entry.lastOpenedAt}>{new Date(entry.lastOpenedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
              : 'Previously selected'}</span></span><ArrowRight size={17} aria-hidden="true" />
          </button>
        </li>)}</ul>
      </section>}
      {!directoryReady && <p role="status" className="text-muted">{directoryError ? 'The workspace list is unavailable. Retry to load your existing workspaces.' : 'Loading your workspaces...'}</p>}
      {directoryReady && <section aria-labelledby="all-workspaces-heading">
        <div className="workspace-section-heading"><h2 id="all-workspaces-heading">All workspaces</h2>
          <Button variant="ghost" size="sm" icon={RefreshCw} disabled={busy} onClick={() => {
            setError('')
            void directory.refreshWorkspaces().catch((caught) => setError(caught instanceof Error ? caught.message : 'The workspace directory could not be refreshed.'))
          }}>Refresh</Button></div>
        <WorkspaceDirectory cloud={directory} cards initialFilter={active.length ? 'default' : 'all'} disabled={creating || opening} showCreate={false} onBusyChange={setDirectoryBusy} onVisibleChange={setVisibleIds}
          renderDetails={(item) => <WorkspaceCardCounts workspace={item} state={states[item.id]} retry={() => retryCounts(item.id)} />} />
      </section>}
      <footer className="workspace-home-footer">
        <span><ShieldCheck size={14} aria-hidden="true" />Access-controlled workspaces. Clear criteria. A human makes the decision.</span>
        <div>{policy.settings?.help.supportUrl && <a className="text-link" href={policy.settings.help.supportUrl} target="_blank" rel="noopener noreferrer">Support</a>}
          {policy.settings?.help.documentationUrl && <a className="text-link" href={policy.settings.help.documentationUrl} target="_blank" rel="noopener noreferrer">Documentation</a>}</div>
      </footer>
    </main>
  </div></LifecycleDialogProvider>
}

function WorkspaceCardCounts({ workspace, state, retry }: { workspace: WorkspaceSummary; state?: WorkspaceCountsState; retry: () => void }) {
  if (!isActiveWorkspace(workspace)) return <p className="workspace-card-note">Retained work is read-only. Active counts are not shown.</p>
  if (state?.status === 'error') return <div className="workspace-count-error"><p role="alert">{state.message}</p><Button size="sm" variant="ghost" onClick={retry}>Retry counts</Button></div>
  const counts = state?.status === 'ready' ? state.value : null
  const unavailable = counts && [counts.jobs, counts.resumes, counts.analyses].some((value) => value.status === 'unavailable')
  return <div className="workspace-card-counts">
    <dl aria-label={`Active real work in ${workspace.name}`} aria-busy={!counts}>
      {(['jobs', 'resumes', 'analyses'] as const).map((kind) => {
        const value = counts?.[kind]
        return <div key={kind}><dt>{kind[0].toUpperCase() + kind.slice(1)}</dt><dd>{!value ? <span aria-label="Loading">...</span>
          : value.status === 'ready' ? value.count.toLocaleString() : <span className="workspace-count-unavailable" title={value.message}>Unavailable</span>}</dd></div>
      })}
    </dl>
    {!counts && <span className="sr-only" role="status">Loading workspace counts</span>}
    {unavailable && <div className="workspace-count-error"><p>{[counts.jobs, counts.resumes, counts.analyses].flatMap((value) => value.status === 'unavailable' ? [value.message] : []).filter((message, index, messages) => messages.indexOf(message) === index).join(' ')}</p>
      <Button size="sm" variant="ghost" onClick={retry}>Retry counts</Button></div>}
  </div>
}
