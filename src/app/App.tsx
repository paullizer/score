import { useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { ArrowUpRight, BarChart3, BriefcaseBusiness, Check, ChevronRight, CircleHelp, ClipboardCheck, Files, FlaskConical, Layers3, LayoutGrid, Menu, Plus, Settings, ShieldCheck, Users, X } from 'lucide-react'
import { useWorkspace } from './workspace-context'
import { ThemeControl } from './ThemeControl'
import { Badge, Button, EmptyState, Modal } from '../components/ui'
import { WorkspaceSwitcher } from '../components/workspace/WorkspaceSwitcher'
import { AccountPanel } from '../components/workspace/AccountPanel'
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
import { LifecycleBanner, LifecycleDialogProvider, LifecycleOperationBanner } from '../components/lifecycle/LifecycleControls'
import { useLifecycleAccess } from '../components/lifecycle/useLifecycleAccess'
import { useRealResumes } from './real-resumes-context'
import { useRealAnalyses } from './real-analyses-context'
import { RealResumeImportActivity } from '../features/resumes/RealAddResumesDialog'
import { clientAdmissionReason, usePublicSettings } from './public-settings-context'
import { useApplicationNavigation } from './application-navigation-context'
import { defaultApplicationPage } from '../services/publicSettings'
import { workspaceCanReview, workspaceQcRole } from '../domain/workspace-permissions'
import { QualityControlPage } from '../features/qc/QualityControlPage'
import { ApplicationPolicyBanners } from './ApplicationPolicyBanners'
import type { Workspace } from '../domain/types'

function active(workspace: Workspace, kind: 'job' | 'resume' | 'analysis', id: string): boolean {
  return !isEntityArchived(workspace, { kind, id }) && !isEntityRemoved(workspace, { kind, id })
}

function QcNavigation({ onNavigate }: { onNavigate?: () => void }) {
  return <nav className="main-nav" aria-label="QC navigation">
    <NavLink to="/qc" end onClick={onNavigate} className={({ isActive }) => `nav-item ${isActive ? 'is-active' : ''}`}><ClipboardCheck size={18} /><span>Reviews</span></NavLink>
    <NavLink to="/qc/improvements" onClick={onNavigate} className={({ isActive }) => `nav-item ${isActive ? 'is-active' : ''}`}><FlaskConical size={18} /><span>Quality improvement</span></NavLink>
    <NavLink to="/qc/prompts" onClick={onNavigate} className={({ isActive }) => `nav-item ${isActive ? 'is-active' : ''}`}><Layers3 size={18} /><span>Prompt versions</span></NavLink>
    <Link to="/analyses" className="nav-item" onClick={onNavigate}><BarChart3 size={18} /><span>Return to normal mode</span></Link>
  </nav>
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { workspace } = useWorkspace()
  const gradeLadders = useGradeLadders()
  const realResumes = useRealResumes()
  const realAnalyses = useRealAnalyses()
  const location = useLocation()
  const realGrades = gradeLadders?.summaries.reduce((count, family) => count + family.levels.filter((level) => level.head.latestVersionId && !isEntityRemoved(workspace, { kind: 'rubric', id: level.head.id }) && !isEntityArchived(workspace, { kind: 'rubric', id: level.head.id })).length, 0) ?? 0
  const items = [
    { to: '/jobs', label: 'Jobs', icon: BriefcaseBusiness, count: workspace.jobs.filter((job) => active(workspace, 'job', job.id)).length },
    { to: '/resumes', label: 'Resumes', icon: Files, count: (realResumes?.summaries ?? []).filter((item) => active(workspace, 'resume', item.resume.id)).length },
    { to: '/rubrics', label: 'Rubrics', icon: Layers3, count: latestRubrics(workspace).filter((rubric) => rubric.kind === 'job' && !isEntityArchived(workspace, { kind: 'rubric', id: rubric.groupId })).length + realGrades },
    { to: '/analyses', label: 'Analyses', icon: BarChart3, count: (realAnalyses?.summaries ?? []).filter((item) => active(workspace, 'analysis', item.run.id)).length },
  ]
  return <nav className="main-nav" aria-label="Main navigation">{items.map(({ to, label, icon: Icon, count }) =>
    <NavLink key={to} to={to} onClick={onNavigate} className={({ isActive }) => isActive || (to === '/rubrics' && location.pathname.startsWith('/grade-ladders')) ? 'nav-item is-active' : 'nav-item'}>
      <Icon size={18} strokeWidth={1.7} /><span>{label}</span><span className="nav-count">{count}</span>
    </NavLink>)}</nav>
}

export function App() {
  const { workspace, notice, clearNotice, cloud } = useWorkspace()
  const realResumes = useRealResumes()
  const realAnalyses = useRealAnalyses()
  const [showAbout, setShowAbout] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [navigationError, setNavigationError] = useState('')
  const navigate = useNavigate()
  const location = useLocation()
  const policy = usePublicSettings()
  const application = useApplicationNavigation()
  const isQc = /^\/qc(?:\/|$)/.test(location.pathname)
  const currentMetadata = cloud.workspaces.find(item => item.id === cloud.currentWorkspaceId)
  const canReview = Boolean(currentMetadata && !currentMetadata.deletedAt &&
    workspaceCanReview(workspaceQcRole(currentMetadata), application?.applicationAdmin === true))
  const title = policy.settings?.appearance.applicationTitle ?? 'Score'
  const resumeLimits = realResumes?.features?.resumeLimits ?? RESUME_IMPORT_LIMITS
  const jobLimits = cloud.realJobs.features?.limits ?? JOB_IMPORT_LIMITS
  const analysisPolicyReason = clientAdmissionReason(policy, 'newAnalyses')
  const section = location.pathname.startsWith('/grade-ladders') ? 'rubrics' : location.pathname.split('/')[1] || 'jobs'
  const isDetail = location.pathname.split('/').filter(Boolean).length > 1
  const { canEdit } = useLifecycleAccess()
  const openWorkspaceHome = () => {
    setNavigationError('')
    void application?.openWorkspaceHome().catch((caught) => setNavigationError(caught instanceof Error ? caught.message : 'Workspace home could not be opened. Your current workspace has been kept.'))
  }
  const brand = <><span className="brand-mark"><Layers3 size={22} strokeWidth={2} /></span><span>{title}</span></>
  const activeJobs = workspace.jobs.filter((job) => active(workspace, 'job', job.id)).length
  const activeResumes = (realResumes?.summaries ?? []).filter((item) => active(workspace, 'resume', item.resume.id)).length

  return <LifecycleDialogProvider><div className="app-layout">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      {application ? <a href={application.workspaceHomePath} className="brand" aria-label={`${title} home`} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault(); openWorkspaceHome()
      }}>{brand}</a> : <Link to={defaultApplicationPage(policy.settings)} className="brand" aria-label={`${title} home`}>{brand}</Link>}
      {application && <Button className="workspace-home-nav" variant="ghost" icon={LayoutGrid} onClick={openWorkspaceHome}>All workspaces</Button>}
      <WorkspaceSwitcher cloud={cloud} />
      <div className="nav-heading">{isQc ? 'QUALITY CONTROL MODE' : 'WORKSPACE'}</div>
      {isQc ? <QcNavigation /> : <Navigation />}
      {!isQc && canReview && <Link className="nav-item" to="/qc"><ClipboardCheck size={18} /><span>Enter QC mode</span></Link>}
      {application?.applicationAdmin && <Button variant="ghost" icon={Settings} onClick={() => void application.openAdminSettings()}>Application settings</Button>}
      {application?.applicationAdmin && <Button variant="ghost" icon={Users} onClick={() => void application.openAdminUsers()}>Users / user access</Button>}
      <div className="sidebar-bottom">
        <div className="sidebar-note"><span className="small-symbol"><ShieldCheck size={19} /></span><strong>Evidence, not impressions.</strong><p>Clear criteria. Traceable matches.<br />A human makes the decision.</p>
          <button className="text-link" onClick={() => setShowAbout(true)}>About this preview <ArrowUpRight size={13} /></button>
          {policy.settings?.help.supportUrl && <a className="text-link" href={policy.settings.help.supportUrl} target="_blank" rel="noopener noreferrer">Support <ArrowUpRight size={13} /></a>}
          {policy.settings?.help.documentationUrl && <a className="text-link" href={policy.settings.help.documentationUrl} target="_blank" rel="noopener noreferrer">Documentation <ArrowUpRight size={13} /></a>}
        </div>
        <div className="sidebar-utility"><span>Appearance</span><ThemeControl /></div>
        <AccountPanel user={cloud.user} signOut={cloud.signOut} />
        <div className="sidebar-version">{title} / UI PREVIEW <span>V0.1</span></div>
      </div>
    </aside>
    <div className="app-body">
      <header className="topbar">
        <div className="flex items-center gap-3"><Button variant="ghost" icon={Menu} className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileNav(true)} />
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={12} /><Link to={`/${section}`}>{isQc ? 'Quality control' : section[0].toUpperCase() + section.slice(1)}</Link>{isDetail && <><ChevronRight size={12} /><span>Review</span></>}</div>
        </div>
        <div className="topbar-actions">
          {isQc ? <><Badge tone="accent">QC mode</Badge><Button size="sm" onClick={() => navigate('/analyses')}>Normal mode</Button></>
            : <><button className="about-chip" onClick={() => setShowAbout(true)}><CircleHelp size={13} />About this application</button>
              {canReview && <Button size="sm" icon={ClipboardCheck} onClick={() => navigate('/qc')}>QC mode</Button>}
              <Button variant="primary" size="sm" icon={Plus} title={analysisPolicyReason ?? undefined} disabled={!canEdit || Boolean(analysisPolicyReason || !realAnalyses?.canWrite || realAnalyses.phase !== 'ready' || !realAnalyses.features?.realAnalyses)}
                onClick={() => navigate('/analyses/new')}>New analysis</Button></>}
        </div>
      </header>
      <ApplicationPolicyBanners />
      {(navigationError || application?.directoryError) && <div className="storage-banner" role="alert">{navigationError || application?.directoryError}</div>}
      <main id="main-content" className="main-content">
        <LifecycleBanner />
        <LifecycleOperationBanner />
        {!isQc && <RealResumeImportActivity />}
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
          <Route path="/qc/*" element={<QualityControlPage />} />
          <Route path="*" element={<EmptyState title="This page is not in your workspace" description="Return to the jobs library to find your next review." action={<Button onClick={() => navigate('/jobs')}>Go to jobs</Button>} />} />
        </Routes>
        <footer className="workspace-footer">
          <span><ShieldCheck size={13} />{isQc ? 'Private QC feedback and trial results stay separate from published scores and normal exports.' : 'Sources and analyses are private server records. A human makes the decision.'}</span>
          {!isQc && <span>{activeJobs} active jobs / {activeResumes} active resumes</span>}
        </footer>
      </main>
    </div>
    {notice && <div className="toast" role="status"><span className="toast-icon"><Check size={16} /></span><p>{notice}</p><Button variant="ghost" className="icon-button" size="sm" icon={X} aria-label="Dismiss notification" onClick={clearNotice} /></div>}
    <Modal open={mobileNav} onOpenChange={setMobileNav} title="Your workspace" description="Explore your jobs, resumes, rubrics, and analyses." drawer>
      {application && <Button className="mb-4" variant="ghost" icon={LayoutGrid} onClick={() => { setMobileNav(false); openWorkspaceHome() }}>All workspaces</Button>}
      <div className="mb-5 space-y-3"><WorkspaceSwitcher cloud={cloud} /><AccountPanel user={cloud.user} signOut={cloud.signOut} /></div>
      {isQc ? <QcNavigation onNavigate={() => setMobileNav(false)} /> : <><Navigation onNavigate={() => setMobileNav(false)} />
        {canReview && <Link className="nav-item" to="/qc" onClick={() => setMobileNav(false)}><ClipboardCheck size={18} /><span>Enter QC mode</span></Link>}</>}
      <div className="mobile-appearance"><span>Appearance</span><ThemeControl /></div>
      {application?.applicationAdmin && <Button icon={Settings} onClick={() => { setMobileNav(false); void application.openAdminSettings() }}>Application settings</Button>}
      {application?.applicationAdmin && <Button icon={Users} onClick={() => { setMobileNav(false); void application.openAdminUsers() }}>Users / user access</Button>}
      {policy.settings?.help.supportUrl && <a className="text-link" href={policy.settings.help.supportUrl} target="_blank" rel="noopener noreferrer">Support</a>}
      {policy.settings?.help.documentationUrl && <a className="text-link" href={policy.settings.help.documentationUrl} target="_blank" rel="noopener noreferrer">Documentation</a>}
    </Modal>
    <Modal open={showAbout} onOpenChange={setShowAbout} title="A clearer way to see the fit" description="Score / interactive UI preview"
      footer={<Button variant="primary" onClick={() => setShowAbout(false)}>Back to the workspace</Button>}>
      <div className="about-illustration"><BriefcaseBusiness /><ChevronRight /><Layers3 /><ChevronRight /><BarChart3 /></div>
      <h3 className="mb-3 text-lg font-semibold">A job. A rubric. The evidence.</h3>
      <p>Import resumes, inspect captured sources, then explicitly compare ready resumes against jobs or exact approved GS versions. Analyses use model-assisted evidence assessment and grounding review, with immutable snapshots and independent progress. Scores are review aids, not hiring decisions or official GS eligibility determinations.</p>
      <div className="info-callout mt-5"><CircleHelp size={18} /><div><strong>Sources are read, processed, and retained privately.</strong><p>Current resume limits: {resumeLimits.maxBatchItems} inputs per batch, {resumeLimits.maxFileBytes / 1024 / 1024} MiB per file, {resumeLimits.maxPdfPages} PDF pages, and {resumeLimits.maxSourceCharacters.toLocaleString()} normalized characters. Current job limits: {jobLimits.maxBatchFiles} inputs, {jobLimits.maxFileBytes / 1024 / 1024} MiB per file, {jobLimits.maxPdfPages} PDF pages, and {jobLimits.maxSourceCharacters.toLocaleString()} characters. Allowed file formats and public URLs depend on current application policy and deployment support; the import dialog shows the effective choices. Markdown uploads use .md or .markdown files; their links and images are not fetched. Word citations use captured sections, not printed pages; any formatted DOCX preview is approximate, and extracted text remains authoritative. Score never signs in or bypasses access controls. Public profiles can be sparse. Each analysis starts manually and is limited to {realAnalyses?.features?.analysisLimits.maxComparisons ?? ANALYSIS_LIMITS.maxComparisons} independent comparisons. Larger analyses use the same processing rate and may take longer.</p><p>Accepted imports and analysis work continue on the server after browser close and retain their captured limits. Documents, profiles, and results are stored on the server, never in browser local storage. Disabled services never hide saved evidence.</p><p>Archive makes content read-only and stops unfinished work it owns, never independent saved analyses. Search includes archived records; restoring them does not restart processing. Permanent deletion requires confirmation and cannot remove an input retained by an analysis or seed ladder, including archived history.</p></div></div>
      <div className="mt-5 flex flex-wrap gap-2"><Badge>Cloud workspace storage</Badge><Badge>Human review first</Badge><Badge>No automatic hiring decisions</Badge></div>
    </Modal>
  </div></LifecycleDialogProvider>
}