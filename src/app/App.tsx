import { useRef, useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { ArrowUpRight, BarChart3, BriefcaseBusiness, Check, ChevronRight, CircleHelp, Files, FlaskConical, Layers3, LogOut, Menu, Plus, RotateCcw, Settings, ShieldCheck, Users, X } from 'lucide-react'
import { useWorkspace } from './workspace-context'
import { ThemeControl } from './ThemeControl'
import { Badge, Button, EmptyState, InlineError, Modal } from '../components/ui'
import { WorkspaceSwitcher } from '../components/workspace/WorkspaceSwitcher'
import { CloudSaveBanner, CloudSaveIndicator } from '../components/workspace/CloudSaveStatus'
import { JobsPage, JobDetail } from '../features/jobs/JobsPage'
import { ResumesPage } from '../features/resumes/ResumesPage'
import { RubricsPage } from '../features/rubrics/RubricsPage'
import { AnalysesPage, AnalysisSetup, AnalysisDetail } from '../features/analyses/AnalysesPage'
import { latestRubrics } from '../domain/selectors'
import { ANALYSIS_LIMITS } from '../domain/real-analyses'
import { RESUME_IMPORT_LIMITS } from '../domain/real-resumes'
import { JOB_IMPORT_LIMITS } from '../domain/real-jobs'
import { useGradeLadders } from './grade-ladders-context'
import { CreateGradeLadder } from '../features/grade-ladders/CreateGradeLadder'
import { GradeLadderPage } from '../features/grade-ladders/GradeLadderPage'
import { isEntityArchived, isEntityRemoved } from '../domain/lifecycle'
import { EntityLifecycleActions, LifecycleBanner, LifecycleDialogProvider, LifecycleOperationBanner } from '../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../components/lifecycle/useLifecycleAccess'
import { useRealResumes } from './real-resumes-context'
import { useRealAnalyses } from './real-analyses-context'
import { RealResumeImportActivity } from '../features/resumes/RealAddResumesDialog'
import { GradeNavigationProtectionProvider, GradeRouterProtection } from './GradeNavigationProtection'
import { useGradeLeaveGuard, type GradeLeaveProtectionApi } from './grade-navigation-context'
import { LibraryViewStateProvider } from './LibraryViewStateProvider'
import { clientAdmissionReason, usePublicSettings } from './public-settings-context'
import { useApplicationNavigation } from './application-navigation-context'
import { defaultApplicationPage } from '../services/publicSettings'

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { workspace } = useWorkspace()
  const gradeLadders = useGradeLadders()
  const realResumes = useRealResumes()
  const realAnalyses = useRealAnalyses()
  const location = useLocation()
  const realGrades = gradeLadders?.summaries.reduce((count, family) => count + family.levels.filter((level) => level.head.latestVersionId && !isEntityRemoved(workspace, { kind: 'rubric', id: level.head.id }) && !isEntityArchived(workspace, { kind: 'rubric', id: level.head.id })).length, 0) ?? 0
  const items = [
    { to: '/jobs', label: 'Jobs', icon: BriefcaseBusiness, count: workspace.jobs.filter((job) => !isEntityArchived(workspace, { kind: 'job', id: job.id }) && !isEntityRemoved(workspace, { kind: 'job', id: job.id })).length },
    { to: '/resumes', label: 'Resumes', icon: Files, count: [...workspace.resumes, ...(realResumes?.summaries.map((item) => item.resume) ?? [])].filter((resume) => !isEntityArchived(workspace, { kind: 'resume', id: resume.id }) && !isEntityRemoved(workspace, { kind: 'resume', id: resume.id })).length },
    { to: '/rubrics', label: 'Rubrics', icon: Layers3, count: latestRubrics(workspace).filter((rubric) => !(rubric.kind === 'grade' && rubric.dataKind === 'real') && !isEntityArchived(workspace, { kind: 'rubric', id: rubric.groupId })).length + realGrades },
    { to: '/analyses', label: 'Analyses', icon: BarChart3, count: [...workspace.runs, ...(realAnalyses?.summaries.map((item) => item.run) ?? [])].filter((run) => !isEntityArchived(workspace, { kind: 'analysis', id: run.id }) && !isEntityRemoved(workspace, { kind: 'analysis', id: run.id })).length },
  ]
  return <nav className="main-nav" aria-label="Main navigation">{items.map(({ to, label, icon: Icon, count }) =>
    <NavLink key={to} to={to} onClick={onNavigate} className={({ isActive }) => isActive || (to === '/rubrics' && location.pathname.startsWith('/grade-ladders')) ? 'nav-item is-active' : 'nav-item'}>
      <Icon size={18} strokeWidth={1.7} /><span>{label}</span><span className="nav-count">{count}</span>
    </NavLink>)}</nav>
}

/** Signed-in identity + sign-out, shown only in cloud mode. Used in both the sidebar and mobile nav. */
function AccountPanel({ cloud }: { cloud: NonNullable<ReturnType<typeof useWorkspace>['cloud']> }) {
  const [signingOut, setSigningOut] = useState(false)
  return <div className="account-panel">
    <span className="avatar avatar-small" aria-hidden="true">{cloud.user.name.trim().slice(0, 1).toUpperCase() || 'U'}</span>
    <div className="min-w-0"><strong className="block truncate text-[12px] font-medium">{cloud.user.name}</strong><span className="block truncate text-[10px] text-muted">{cloud.user.email}</span></div>
    <Button size="sm" variant="ghost" className="icon-button" aria-label="Sign out" icon={LogOut} disabled={signingOut}
      onClick={() => { setSigningOut(true); void cloud.signOut().finally(() => setSigningOut(false)) }} />
  </div>
}

export function App() {
  const { workspace, cloud } = useWorkspace()
  const leaveRef = useRef<GradeLeaveProtectionApi | null>(null)
  if (cloud) return <AppContent />
  const workspaceId = workspace.lifecycle?.epoch ?? 'workspace'
  return <LibraryViewStateProvider scopeKey={`local:${workspaceId}`}>
    <GradeNavigationProtectionProvider workspaceId={workspaceId} routePrefix="/" apiRef={leaveRef}>
      <GradeRouterProtection><AppContent /></GradeRouterProtection>
    </GradeNavigationProtectionProvider>
  </LibraryViewStateProvider>
}

function AppContent() {
  const { workspace, storageError, retrySave, notice, clearNotice, resetDemo, cloud } = useWorkspace()
  const realResumes = useRealResumes()
  const realAnalyses = useRealAnalyses()
  const [showReset, setShowReset] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const policy = usePublicSettings()
  const application = useApplicationNavigation()
  const title = policy.settings?.appearance.applicationTitle ?? 'Score'
  const samplesVisible = !cloud || policy.settings?.features.samplesVisible !== false
  const resumeLimits = realResumes?.features?.resumeLimits ?? RESUME_IMPORT_LIMITS
  const jobLimits = cloud?.realJobs.features?.limits ?? JOB_IMPORT_LIMITS
  const newAnalysisMode = samplesVisible && new URLSearchParams(location.search).get('data') === 'samples' ? 'samples' : 'real'
  const analysisPolicyReason = clientAdmissionReason(policy, 'newAnalyses')
  const section = location.pathname.startsWith('/grade-ladders') ? 'rubrics' : location.pathname.split('/')[1] || 'jobs'
  const isDetail = location.pathname.split('/').filter(Boolean).length > 1
  const currentWorkspaceName = cloud?.workspaces.find((item) => item.id === cloud.currentWorkspaceId)?.name
  const { canEdit } = useLifecycleAccess()
  const leaveGuard = useGradeLeaveGuard(false, false, 'Workspace changes')
  const localRemoved = !cloud && isEntityRemoved(workspace, { kind: 'workspace', id: 'workspace' })

  if (!cloud && /^\/admin\/(?:settings|users)\/?$/.test(location.pathname)) return <main className="recovery-page"><div className="panel recovery-card">
    <h1>Application settings require a cloud administrator</h1><p>This standalone workspace is a fictional local demo. It cannot read or save cloud settings, designate administrators, or run model tests.</p>
    <Button onClick={() => navigate('/jobs')}>Back to demo workspace</Button>
  </div></main>

  if (localRemoved) return <main className="recovery-page"><div className="panel recovery-card">
    <h1>{storageError ? 'Workspace deletion is not saved' : 'Your local workspace was deleted'}</h1>
    <p>{storageError ? 'The change exists only in this tab. Keep it open and retry saving before leaving or creating another workspace.' : 'Its content was permanently removed. No samples are recreated automatically. You can explicitly create a fresh demo workspace.'}</p>
    {storageError && <><InlineError>{storageError}</InlineError><Button onClick={retrySave}>Retry saving deletion</Button></>}
    <Button variant="primary" icon={Plus} disabled={Boolean(storageError)} onClick={() => { void leaveGuard.leave(() => { resetDemo(); navigate('/jobs') }) }}>Create demo workspace</Button>
  </div></main>

  return <LifecycleDialogProvider><div className="app-layout">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <Link to={defaultApplicationPage(policy.settings)} className="brand" aria-label={`${title} home`}><span className="brand-mark"><Layers3 size={22} strokeWidth={2} /></span><span>{title}</span></Link>
      {cloud ? <WorkspaceSwitcher cloud={cloud} /> : <div className="workspace-label"><span className="workspace-monogram">S</span><div><strong>My workspace</strong><span>Personal / local</span></div><span className="workspace-online" /></div>}
      {!cloud && <div className="mb-4"><EntityLifecycleActions target={{ kind: 'workspace', id: 'workspace' }} name="My workspace" compact /></div>}
      <div className="nav-heading">WORKSPACE</div>
      <Navigation />
      {application?.applicationAdmin && <Button variant="ghost" icon={Settings} onClick={() => void application.openAdminSettings()}>Application settings</Button>}
      {application?.applicationAdmin && <Button variant="ghost" icon={Users} onClick={() => void application.openAdminUsers()}>Users / user access</Button>}
      <div className="sidebar-bottom">
        <div className="sidebar-note"><span className="small-symbol"><ShieldCheck size={19} /></span><strong>Evidence, not impressions.</strong><p>Clear criteria. Traceable matches.<br />A human makes the decision.</p>
          <button className="text-link" onClick={() => setShowAbout(true)}>About this preview <ArrowUpRight size={13} /></button>
          {policy.settings?.help.supportUrl && <a className="text-link" href={policy.settings.help.supportUrl} target="_blank" rel="noopener noreferrer">Support <ArrowUpRight size={13} /></a>}
          {policy.settings?.help.documentationUrl && <a className="text-link" href={policy.settings.help.documentationUrl} target="_blank" rel="noopener noreferrer">Documentation <ArrowUpRight size={13} /></a>}
        </div>
        <div className="sidebar-utility"><span>Appearance</span><ThemeControl /></div>
        {cloud && <AccountPanel cloud={cloud} />}
        {samplesVisible && <button className="reset-button" disabled={!canEdit} onClick={() => setShowReset(true)}><RotateCcw size={14} />Reset {cloud ? 'samples' : 'demo workspace'}</button>}
        <div className="sidebar-version">{title} / UI PREVIEW <span>V0.1</span></div>
      </div>
    </aside>
    <div className="app-body">
      <header className="topbar">
        <div className="flex items-center gap-3"><Button variant="ghost" icon={Menu} className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileNav(true)} />
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={12} /><Link to={`/${section}`}>{section[0].toUpperCase() + section.slice(1)}</Link>{isDetail && <><ChevronRight size={12} /><span>Review</span></>}</div>
        </div>
        <div className="topbar-actions">
          {cloud ? <CloudSaveIndicator cloud={cloud} /> : <span className={`save-status ${storageError ? 'is-error' : ''}`}><span />{storageError ? 'Changes not saved' : 'Saved on this device'}</span>}
          <button className="demo-chip" onClick={() => setShowAbout(true)}><FlaskConical size={13} />{cloud ? samplesVisible ? 'Real & sample workflows' : 'About this application' : 'Demo workspace'}</button>
          <Button variant="primary" size="sm" icon={Plus} title={analysisPolicyReason ?? undefined} disabled={!canEdit || Boolean(cloud && newAnalysisMode === 'real' && (analysisPolicyReason || !realAnalyses?.canWrite || realAnalyses.phase !== 'ready' || !realAnalyses.features?.realAnalyses))}
            onClick={() => navigate(cloud ? `/analyses/new?data=${newAnalysisMode}` : '/analyses/new')}>New analysis</Button>
        </div>
      </header>
      {policy.settings?.appearance.announcement.enabled && <aside className={`application-announcement ${policy.settings.appearance.announcement.tone === 'warning' ? 'is-warning' : ''}`} role="status">{policy.settings.appearance.announcement.text}</aside>}
      {policy.settings?.maintenance.pauseNewWork && <aside className="application-announcement is-warning" role="status">New work is paused. {policy.settings.maintenance.explanation} Saved records remain available.</aside>}
      {policy.phase === 'error' && <div className="storage-banner" role="alert"><span>Current application policy could not be checked. New actions are disabled; saved evidence is unchanged.</span><Button size="sm" onClick={() => void policy.refresh()}>Refresh application policy</Button></div>}
      {cloud ? <CloudSaveBanner cloud={cloud} /> : storageError && <div className="storage-banner" role="alert"><span>{storageError}</span><Button size="sm" onClick={retrySave}>Retry saving</Button></div>}
      <main id="main-content" className="main-content">
        <LifecycleBanner />
        <LifecycleOperationBanner />
        {cloud && <RealResumeImportActivity />}
        <Routes>
          <Route path="/" element={<Navigate to={defaultApplicationPage(policy.settings)} replace />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="/resumes" element={<ResumesPage />} />
          <Route path="/resumes/:id" element={<ResumesPage />} />
          <Route path="/rubrics" element={<RubricsPage />} />
          <Route path="/rubrics/:id" element={<RubricsPage />} />
          <Route path="/grade-ladders/new" element={<CreateGradeLadder />} />
          <Route path="/grade-ladders/:id" element={<GradeLadderPage />} />
          <Route path="/analyses" element={<AnalysesPage />} />
          <Route path="/analyses/new" element={<AnalysisSetup key={location.key} />} />
          <Route path="/analyses/:id" element={<AnalysisDetail key={location.pathname} />} />
          <Route path="*" element={<EmptyState title="This page is not in your workspace" description="Return to the jobs library to find your next review." action={<Button onClick={() => navigate('/jobs')}>Go to jobs</Button>} />} />
        </Routes>
        <footer className="workspace-footer">
          <span><ShieldCheck size={13} />{cloud ? 'Real sources and analyses are private server records. Samples stay fictional. A human makes the decision.' : 'Private by design. This preview stays in your browser.'}</span>
          <span>{workspace.jobs.filter((job) => !isEntityArchived(workspace, { kind: 'job', id: job.id }) && !isEntityRemoved(workspace, { kind: 'job', id: job.id })).length} active jobs / {[...workspace.resumes, ...(realResumes?.summaries.map((item) => item.resume) ?? [])].filter((resume) => !isEntityArchived(workspace, { kind: 'resume', id: resume.id }) && !isEntityRemoved(workspace, { kind: 'resume', id: resume.id })).length} active resumes{cloud && samplesVisible && ' · includes samples'}</span>
        </footer>
      </main>
    </div>
    {notice && <div className="toast" role="status"><span className="toast-icon"><Check size={16} /></span><p>{notice}</p><Button variant="ghost" className="icon-button" size="sm" icon={X} aria-label="Dismiss notification" onClick={clearNotice} /></div>}
    <Modal open={mobileNav} onOpenChange={setMobileNav} title="Your workspace" description="Explore your jobs, resumes, rubrics, and analyses." drawer>
      {cloud && <div className="mb-5 space-y-3"><WorkspaceSwitcher cloud={cloud} /><AccountPanel cloud={cloud} /></div>}
      {!cloud && <EntityLifecycleActions target={{ kind: 'workspace', id: 'workspace' }} name="My workspace" />}
      <Navigation onNavigate={() => setMobileNav(false)} /><div className="mobile-appearance"><span>Appearance</span><ThemeControl /></div>
      {application?.applicationAdmin && <Button icon={Settings} onClick={() => { setMobileNav(false); void application.openAdminSettings() }}>Application settings</Button>}
      {application?.applicationAdmin && <Button icon={Users} onClick={() => { setMobileNav(false); void application.openAdminUsers() }}>Users / user access</Button>}
      {policy.settings?.help.supportUrl && <a className="text-link" href={policy.settings.help.supportUrl} target="_blank" rel="noopener noreferrer">Support</a>}
      {policy.settings?.help.documentationUrl && <a className="text-link" href={policy.settings.help.documentationUrl} target="_blank" rel="noopener noreferrer">Documentation</a>}
      {samplesVisible && <Button icon={RotateCcw} disabled={!canEdit} onClick={() => { setMobileNav(false); setShowReset(true) }}>Reset {cloud ? 'samples' : 'demo workspace'}</Button>}
    </Modal>
    <Modal open={showReset} onOpenChange={setShowReset}
      title={cloud ? 'Reset sample content?' : 'A fresh starting point'}
      description={cloud ? `Reset only the fictional preview content in ${currentWorkspaceName ?? 'this workspace'}?` : 'Reset your demo workspace?'}
      footer={<><Button onClick={() => setShowReset(false)}>Keep my workspace</Button><Button variant="danger" icon={RotateCcw} disabled={!canEdit} onClick={() => { void leaveGuard.leave(() => { resetDemo(); setShowReset(false); navigate('/jobs') }) }}>Reset {cloud ? 'samples' : 'demo'}</Button></>}>
      {cloud ? <>
        <p>This resets only the legacy sample imports, rubric edits, and simulated analysis history in <strong>{currentWorkspaceName ?? 'this workspace'}</strong>. Server-owned real resumes, original captures, analyses and their frozen inputs/results, jobs, grade ladders, reference captures, approvals, and all their versions are not deleted or changed.</p>
        <p className="mt-4 text-muted">Your other workspaces are not affected.</p>
      </> : <>
        <p>This replaces demo imports, rubric edits, and analysis history with the original fictional examples. It cannot be undone.</p>
        <p className="mt-4 text-muted">Your theme preference and all browser data outside Score are kept.</p>
      </>}
    </Modal>
    <Modal open={showAbout} onOpenChange={setShowAbout} title="A clearer way to see the fit" description="Score / interactive UI preview"
      footer={<Button variant="primary" onClick={() => setShowAbout(false)}>Back to the workspace</Button>}>
      <div className="about-illustration"><BriefcaseBusiness /><ChevronRight /><Layers3 /><ChevronRight /><BarChart3 /></div>
      <h3 className="mb-3 text-lg font-semibold">A job. A rubric. The evidence.</h3>
      <p>{cloud ? 'Import real resumes, inspect captured sources, then explicitly compare ready resumes against real jobs or exact approved GS versions. Real analyses use model-assisted evidence assessment and grounding review, with immutable snapshots and independent progress. Only the explicitly labeled Samples workflows are fictional. Scores are review aids, not hiring decisions or official GS eligibility determinations.' : 'Explore the complete review workflow with fictional jobs and resumes. Import files or URLs to simulate adding sample records, build a comparison, and follow each score back to its supporting passage.'}</p>
      {cloud ? <div className="info-callout mt-5"><CircleHelp size={18} /><div><strong>Real sources are read, processed, and retained privately.</strong><p>Current resume limits: {resumeLimits.maxBatchItems} inputs per batch, {resumeLimits.maxFileBytes / 1024 / 1024} MiB per file, {resumeLimits.maxPdfPages} PDF pages, and {resumeLimits.maxSourceCharacters.toLocaleString()} normalized characters. Current job limits: {jobLimits.maxBatchFiles} inputs, {jobLimits.maxFileBytes / 1024 / 1024} MiB per file, {jobLimits.maxPdfPages} PDF pages, and {jobLimits.maxSourceCharacters.toLocaleString()} characters. Allowed file formats and public URLs depend on current application policy and deployment support; the import dialog shows the effective choices. Markdown uploads use .md or .markdown files; their links and images are not fetched. Word citations use captured sections, not printed pages; any formatted DOCX preview is approximate, and extracted text remains authoritative. Score never signs in or bypasses access controls. Public profiles can be sparse. Each analysis starts manually and is limited to {realAnalyses?.features?.analysisLimits.maxComparisons ?? ANALYSIS_LIMITS.maxComparisons} independent comparisons. Larger analyses use the same processing rate and may take longer.</p><p>Accepted imports and analysis work continue on the server after browser close and retain their captured limits. Real documents, profiles, and results never enter sample autosave or browser local storage. Reset samples does not delete them. Disabled services never substitute fictional content or hide saved evidence.</p><p>Archive makes content read-only and stops unfinished work it owns, never independent saved analyses. Search includes archived records; restoring them does not restart processing. Permanent deletion requires confirmation and cannot remove an input retained by an analysis or seed ladder, including archived history.</p></div></div>
        : <div className="info-callout mt-5"><CircleHelp size={18} /><div><strong>Nothing is uploaded or evaluated by AI.</strong><p>Selected file contents are never read. URLs are not fetched. Scores and quotations come from synthetic fixtures, and GS examples are not official eligibility assessments.</p></div></div>}
      <div className="mt-5 flex flex-wrap gap-2"><Badge>{cloud ? 'Cloud workspace storage' : 'Local demo storage'}</Badge><Badge>Human review first</Badge><Badge>No automatic hiring decisions</Badge></div>
    </Modal>
  </div></LifecycleDialogProvider>
}
