import { useRef, useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { ArrowUpRight, BarChart3, BookOpen, BriefcaseBusiness, Check, ChevronLeft, ChevronRight, CircleHelp, ClipboardCheck, Files, FlaskConical, Info, Layers3, LayoutGrid, LifeBuoy, Menu, Plus, Settings, ShieldCheck, Users, X } from 'lucide-react'
import { useWorkspace } from './workspace-context'
import { ThemeControl } from './ThemeControl'
import { useSidebarCollapsed } from './sidebar-preference'
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

const navClass = ({ isActive }: { isActive: boolean }) => isActive ? 'nav-item is-active' : 'nav-item'

function QcNavigation({ onNavigate, collapsed = false }: { onNavigate?: () => void; collapsed?: boolean }) {
  const items = [
    { to: '/qc', label: 'Reviews', icon: ClipboardCheck, end: true },
    { to: '/qc/improvements', label: 'Quality improvement', icon: FlaskConical, end: false },
    { to: '/qc/prompts', label: 'Prompt versions', icon: Layers3, end: false },
  ]
  return <nav className="main-nav" aria-label="QC navigation">{items.map(({ to, label, icon: Icon, end }) =>
    <NavLink key={to} to={to} end={end} onClick={onNavigate} title={collapsed ? label : undefined} className={navClass}>
      <Icon size={18} strokeWidth={1.7} aria-hidden="true" /><span className="nav-label">{label}</span>
    </NavLink>)}</nav>
}

function Navigation({ onNavigate, collapsed = false }: { onNavigate?: () => void; collapsed?: boolean }) {
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
    <NavLink key={to} to={to} onClick={onNavigate} title={collapsed ? `${label} · ${count}` : undefined} className={({ isActive }) => navClass({ isActive: isActive || (to === '/rubrics' && location.pathname.startsWith('/grade-ladders')) })}>
      <Icon size={18} strokeWidth={1.7} aria-hidden="true" /><span className="nav-label">{label}</span><span className="nav-count">{count}</span>
    </NavLink>)}</nav>
}

// Administration, About, and configured help links share the main navigation's item styling.
function SidebarLinks({ title, collapsed = false, onAbout, onLeave }: { title: string; collapsed?: boolean; onAbout: () => void; onLeave?: () => void }) {
  const application = useApplicationNavigation()
  const help = usePublicSettings().settings?.help
  const tip = (label: string) => collapsed ? label : undefined
  return <div className="sidebar-links">
    {application?.applicationAdmin && <button type="button" className="nav-item" title={tip('Application settings')} onClick={() => { onLeave?.(); void application.openAdminSettings() }}>
      <Settings size={18} strokeWidth={1.7} aria-hidden="true" /><span className="nav-label">Application settings</span></button>}
    {application?.applicationAdmin && <button type="button" className="nav-item" title={tip('Users / user access')} onClick={() => { onLeave?.(); void application.openAdminUsers() }}>
      <Users size={18} strokeWidth={1.7} aria-hidden="true" /><span className="nav-label">Users / user access</span></button>}
    <button type="button" className="nav-item" title={tip(`About ${title}`)} onClick={onAbout}>
      <Info size={18} strokeWidth={1.7} aria-hidden="true" /><span className="nav-label">About {title}</span></button>
    {help?.supportUrl && <a className="nav-item" href={help.supportUrl} target="_blank" rel="noopener noreferrer" title={tip('Support')}>
      <LifeBuoy size={18} strokeWidth={1.7} aria-hidden="true" /><span className="nav-label">Support</span><ArrowUpRight size={13} className="nav-external" aria-hidden="true" /></a>}
    {help?.documentationUrl && <a className="nav-item" href={help.documentationUrl} target="_blank" rel="noopener noreferrer" title={tip('Documentation')}>
      <BookOpen size={18} strokeWidth={1.7} aria-hidden="true" /><span className="nav-label">Documentation</span><ArrowUpRight size={13} className="nav-external" aria-hidden="true" /></a>}
  </div>
}

export function App() {
  const { workspace, notice, clearNotice, cloud } = useWorkspace()
  const realResumes = useRealResumes()
  const realAnalyses = useRealAnalyses()
  const [showAbout, setShowAbout] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [navigationError, setNavigationError] = useState('')
  const [collapsed, toggleCollapsed] = useSidebarCollapsed()
  const aboutAfterDrawer = useRef(false)
  const menuButton = useRef<HTMLButtonElement>(null)
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
  const brand = <><span className="brand-mark"><Layers3 size={22} strokeWidth={2} /></span><span className="brand-title">{title}</span></>
  const brandTip = collapsed ? `${title} home` : undefined
  const toggleLabel = collapsed ? 'Expand navigation' : 'Collapse navigation'
  const activeJobs = workspace.jobs.filter((job) => active(workspace, 'job', job.id)).length
  const activeResumes = (realResumes?.summaries ?? []).filter((item) => active(workspace, 'resume', item.resume.id)).length

  return <LifecycleDialogProvider><div className="app-layout">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside id="primary-navigation" className={collapsed ? 'sidebar is-collapsed' : 'sidebar'}>
      <div className="sidebar-brand-row">
        {application ? <a href={application.workspaceHomePath} className="brand" aria-label={`${title} home`} title={brandTip} onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          event.preventDefault(); openWorkspaceHome()
        }}>{brand}</a> : <Link to={defaultApplicationPage(policy.settings)} className="brand" aria-label={`${title} home`} title={brandTip}>{brand}</Link>}
        <button type="button" className="sidebar-toggle" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-controls="primary-navigation" aria-label={toggleLabel} title={toggleLabel}>
          {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronLeft size={16} aria-hidden="true" />}
        </button>
      </div>
      <div className="sidebar-scroll">
        {application && <button type="button" className="nav-item sidebar-home" title={collapsed ? 'All workspaces' : undefined} onClick={openWorkspaceHome}>
          <LayoutGrid size={18} strokeWidth={1.7} aria-hidden="true" /><span className="nav-label">All workspaces</span></button>}
        <WorkspaceSwitcher cloud={cloud} compact={collapsed} />
        <div className="nav-heading">{isQc ? 'QUALITY CONTROL MODE' : 'WORKSPACE'}</div>
        {isQc ? <QcNavigation collapsed={collapsed} /> : <Navigation collapsed={collapsed} />}
        <SidebarLinks title={title} collapsed={collapsed} onAbout={() => setShowAbout(true)} />
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-utility"><span className="sidebar-utility-label">Appearance</span><ThemeControl /></div>
        <AccountPanel user={cloud.user} signOut={cloud.signOut} compact={collapsed} />
      </div>
    </aside>
    <div className="app-body">
      <header className="topbar">
        <div className="flex items-center gap-3"><Button ref={menuButton} variant="ghost" icon={Menu} className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileNav(true)} />
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={12} /><Link to={`/${section}`}>{isQc ? 'Quality control' : section[0].toUpperCase() + section.slice(1)}</Link>{isDetail && <><ChevronRight size={12} /><span>Review</span></>}</div>
        </div>
        <div className="topbar-actions">
          {isQc ? <><Badge tone="accent">QC mode</Badge><Button size="sm" onClick={() => navigate('/analyses')}>Normal mode</Button></>
            : <>{canReview && <Button size="sm" icon={ClipboardCheck} onClick={() => navigate('/qc')}>QC mode</Button>}
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
    <Modal open={mobileNav} onOpenChange={setMobileNav} title="Your workspace" description="Explore your jobs, resumes, rubrics, and analyses." drawer
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        menuButton.current?.focus()
        // About opens only after the drawer has returned focus, so closing About returns to the menu button too.
        if (!aboutAfterDrawer.current) return
        aboutAfterDrawer.current = false
        setShowAbout(true)
      }}>
      {application && <button type="button" className="nav-item mb-4" onClick={() => { setMobileNav(false); openWorkspaceHome() }}>
        <LayoutGrid size={18} strokeWidth={1.7} aria-hidden="true" /><span className="nav-label">All workspaces</span></button>}
      <div className="mb-5 space-y-3"><WorkspaceSwitcher cloud={cloud} /><AccountPanel user={cloud.user} signOut={cloud.signOut} /></div>
      {isQc ? <QcNavigation onNavigate={() => setMobileNav(false)} /> : <Navigation onNavigate={() => setMobileNav(false)} />}
      <SidebarLinks title={title} onLeave={() => setMobileNav(false)} onAbout={() => { aboutAfterDrawer.current = true; setMobileNav(false) }} />
      <div className="mobile-appearance"><span>Appearance</span><ThemeControl /></div>
    </Modal>
    <Modal open={showAbout} onOpenChange={setShowAbout} title={`About ${title}`} description="How it works, current limits, and privacy"
      footer={<Button variant="primary" onClick={() => setShowAbout(false)}>Back to the workspace</Button>}>
      <div className="about-illustration"><BriefcaseBusiness /><ChevronRight /><Layers3 /><ChevronRight /><BarChart3 /></div>
      <h3 className="mb-3 text-lg font-semibold">A job. A rubric. The evidence.</h3>
      <p>Import resumes, inspect captured sources, then explicitly compare ready resumes against jobs or exact approved GS versions. Analyses use model-assisted evidence assessment and grounding review, with immutable snapshots and independent progress. Scores are review aids, not hiring decisions or official GS eligibility determinations.</p>
      <div className="info-callout mt-5"><CircleHelp size={18} /><div><strong>Sources are read, processed, and retained privately.</strong><p>Current resume limits: {resumeLimits.maxBatchItems} inputs per batch, {resumeLimits.maxFileBytes / 1024 / 1024} MiB per file, {resumeLimits.maxPdfPages} PDF pages, and {resumeLimits.maxSourceCharacters.toLocaleString()} normalized characters. Current job limits: {jobLimits.maxBatchFiles} inputs, {jobLimits.maxFileBytes / 1024 / 1024} MiB per file, {jobLimits.maxPdfPages} PDF pages, and {jobLimits.maxSourceCharacters.toLocaleString()} characters. Allowed file formats and public URLs depend on current application policy and deployment support; the import dialog shows the effective choices. Markdown uploads use .md or .markdown files; their links and images are not fetched. Word citations use captured sections, not printed pages; any formatted DOCX preview is approximate, and extracted text remains authoritative. Score never signs in or bypasses access controls. Public profiles can be sparse. Each analysis starts manually and is limited to {realAnalyses?.features?.analysisLimits.maxComparisons ?? ANALYSIS_LIMITS.maxComparisons} independent comparisons. Larger analyses use the same processing rate and may take longer.</p><p>Accepted imports and analysis work continue on the server after browser close and retain their captured limits. Documents, profiles, and results are stored on the server, never in browser local storage. Disabled services never hide saved evidence.</p><p>Archive makes content read-only and stops unfinished work it owns, never independent saved analyses. Search includes archived records; restoring them does not restart processing. Permanent deletion requires confirmation and cannot remove an input retained by an analysis or seed ladder, including archived history.</p></div></div>
      <div className="mt-5 flex flex-wrap gap-2"><Badge>Cloud workspace storage</Badge><Badge>Human review first</Badge><Badge>No automatic hiring decisions</Badge></div>
    </Modal>
  </div></LifecycleDialogProvider>
}