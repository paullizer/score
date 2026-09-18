import { useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { ArrowUpRight, BarChart3, BriefcaseBusiness, Check, ChevronRight, CircleHelp, Files, FlaskConical, Layers3, LogOut, Menu, Plus, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { useWorkspace } from './workspace-context'
import { ThemeControl } from './ThemeControl'
import { Badge, Button, EmptyState, Modal } from '../components/ui'
import { WorkspaceSwitcher } from '../components/workspace/WorkspaceSwitcher'
import { CloudSaveBanner, CloudSaveIndicator } from '../components/workspace/CloudSaveStatus'
import { JobsPage, JobDetail } from '../features/jobs/JobsPage'
import { ResumesPage } from '../features/resumes/ResumesPage'
import { RubricsPage } from '../features/rubrics/RubricsPage'
import { AnalysesPage, AnalysisSetup, AnalysisDetail } from '../features/analyses/AnalysesPage'
import { latestRubrics } from '../domain/selectors'
import { useGradeLadders } from './grade-ladders-context'
import { CreateGradeLadder } from '../features/grade-ladders/CreateGradeLadder'
import { GradeLadderPage } from '../features/grade-ladders/GradeLadderPage'
import { useRealResumes } from './real-resumes-context'
import { useRealAnalyses } from './real-analyses-context'
import { RealResumeImportActivity } from '../features/resumes/RealAddResumesDialog'

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { workspace } = useWorkspace()
  const gradeLadders = useGradeLadders()
  const realResumes = useRealResumes()
  const realAnalyses = useRealAnalyses()
  const location = useLocation()
  const realGrades = gradeLadders?.summaries.reduce((count, family) => count + family.levels.filter((level) => level.head.latestVersionId).length, 0) ?? 0
  const items = [
    { to: '/jobs', label: 'Jobs', icon: BriefcaseBusiness, count: workspace.jobs.length },
    { to: '/resumes', label: 'Resumes', icon: Files, count: workspace.resumes.length + (realResumes?.summaries.length ?? 0) },
    { to: '/rubrics', label: 'Rubrics', icon: Layers3, count: latestRubrics(workspace).filter((rubric) => !(rubric.kind === 'grade' && rubric.dataKind === 'real')).length + realGrades },
    { to: '/analyses', label: 'Analyses', icon: BarChart3, count: workspace.runs.length + (realAnalyses?.summaries.length ?? 0) },
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
  const { workspace, storageError, retrySave, notice, clearNotice, resetDemo, cloud } = useWorkspace()
  const realResumes = useRealResumes()
  const realAnalyses = useRealAnalyses()
  const [showReset, setShowReset] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const newAnalysisMode = new URLSearchParams(location.search).get('data') === 'samples' ? 'samples' : 'real'
  const section = location.pathname.startsWith('/grade-ladders') ? 'rubrics' : location.pathname.split('/')[1] || 'jobs'
  const isDetail = location.pathname.split('/').filter(Boolean).length > 1
  const currentWorkspaceName = cloud?.workspaces.find((item) => item.id === cloud.currentWorkspaceId)?.name

  return <div className="app-layout">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <Link to="/jobs" className="brand" aria-label="Score home"><span className="brand-mark"><Layers3 size={22} strokeWidth={2} /></span><span>score<span className="brand-period">.</span></span></Link>
      {cloud ? <WorkspaceSwitcher cloud={cloud} /> : <div className="workspace-label"><span className="workspace-monogram">S</span><div><strong>My workspace</strong><span>Personal / local</span></div><span className="workspace-online" /></div>}
      <div className="nav-heading">WORKSPACE</div>
      <Navigation />
      <div className="sidebar-bottom">
        <div className="sidebar-note"><span className="small-symbol"><ShieldCheck size={19} /></span><strong>Evidence, not impressions.</strong><p>Clear criteria. Traceable matches.<br />A human makes the decision.</p>
          <button className="text-link" onClick={() => setShowAbout(true)}>About this preview <ArrowUpRight size={13} /></button>
        </div>
        <div className="sidebar-utility"><span>Appearance</span><ThemeControl /></div>
        {cloud && <AccountPanel cloud={cloud} />}
        <button className="reset-button" onClick={() => setShowReset(true)}><RotateCcw size={14} />Reset {cloud ? 'samples' : 'demo workspace'}</button>
        <div className="sidebar-version">SCORE / UI PREVIEW <span>V0.1</span></div>
      </div>
    </aside>
    <div className="app-body">
      <header className="topbar">
        <div className="flex items-center gap-3"><Button variant="ghost" icon={Menu} className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileNav(true)} />
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={12} /><Link to={`/${section}`}>{section[0].toUpperCase() + section.slice(1)}</Link>{isDetail && <><ChevronRight size={12} /><span>Review</span></>}</div>
        </div>
        <div className="topbar-actions">
          {cloud ? <CloudSaveIndicator cloud={cloud} /> : <span className={`save-status ${storageError ? 'is-error' : ''}`}><span />{storageError ? 'Changes not saved' : 'Saved on this device'}</span>}
          <button className="demo-chip" onClick={() => setShowAbout(true)}><FlaskConical size={13} />{cloud ? 'Real & sample workflows' : 'Demo workspace'}</button>
          <Button variant="primary" size="sm" icon={Plus} disabled={Boolean(cloud && newAnalysisMode === 'real' && (!realAnalyses?.canWrite || realAnalyses.phase !== 'ready' || !realAnalyses.features?.realAnalyses))}
            onClick={() => navigate(cloud ? `/analyses/new?data=${newAnalysisMode}` : '/analyses/new')}>New analysis</Button>
        </div>
      </header>
      {cloud ? <CloudSaveBanner cloud={cloud} /> : storageError && <div className="storage-banner" role="alert"><span>{storageError}</span><Button size="sm" onClick={retrySave}>Retry saving</Button></div>}
      <main id="main-content" className="main-content">
        {cloud && <RealResumeImportActivity />}
        <Routes>
          <Route path="/" element={<Navigate to="/jobs" replace />} />
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
          <span>{workspace.jobs.length} jobs / {workspace.resumes.length + (realResumes?.summaries.length ?? 0)} resumes{cloud && ` / ${workspace.runs.length + (realAnalyses?.summaries.length ?? 0)} analyses · includes samples`}</span>
        </footer>
      </main>
    </div>
    {notice && <div className="toast" role="status"><span className="toast-icon"><Check size={16} /></span><p>{notice}</p><Button variant="ghost" className="icon-button" size="sm" icon={X} aria-label="Dismiss notification" onClick={clearNotice} /></div>}
    <Modal open={mobileNav} onOpenChange={setMobileNav} title="Your workspace" description="Explore your jobs, resumes, rubrics, and analyses." drawer>
      {cloud && <div className="mb-5 space-y-3"><WorkspaceSwitcher cloud={cloud} /><AccountPanel cloud={cloud} /></div>}
      <Navigation onNavigate={() => setMobileNav(false)} /><div className="mobile-appearance"><span>Appearance</span><ThemeControl /></div>
      <Button icon={RotateCcw} onClick={() => { setMobileNav(false); setShowReset(true) }}>Reset {cloud ? 'samples' : 'demo workspace'}</Button>
    </Modal>
    <Modal open={showReset} onOpenChange={setShowReset}
      title={cloud ? 'Reset sample content?' : 'A fresh starting point'}
      description={cloud ? `Reset only the fictional preview content in ${currentWorkspaceName ?? 'this workspace'}?` : 'Reset your demo workspace?'}
      footer={<><Button onClick={() => setShowReset(false)}>Keep my workspace</Button><Button variant="danger" icon={RotateCcw} onClick={() => { resetDemo(); setShowReset(false); navigate('/jobs') }}>Reset {cloud ? 'samples' : 'demo'}</Button></>}>
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
      {cloud ? <div className="info-callout mt-5"><CircleHelp size={18} /><div><strong>Real sources are read, processed, and retained privately.</strong><p>Resume batches accept up to 10 total PDFs, local Markdown files (when enabled), and public URLs, including accessible LinkedIn profiles. Real job and resume files must be no larger than 10 MiB; the 50-page limit applies only to PDFs. Each source is limited to 180,000 normalized characters. Markdown uploads use .md or .markdown files; their links and images are not fetched, and evidence is shown as text rather than a rendered preview. Nonpublic or blocked URLs cannot be processed; Score never signs in or bypasses access controls. Public profiles can be sparse. Each analysis is started manually and is limited to 100 independent comparisons.</p><p>Accepted imports and analysis work continue on the server after browser close. Real documents, profiles, and results never enter sample autosave or browser local storage. Reset samples does not delete them. Disabled or unavailable real services never substitute fictional content.</p></div></div>
        : <div className="info-callout mt-5"><CircleHelp size={18} /><div><strong>Nothing is uploaded or evaluated by AI.</strong><p>Selected file contents are never read. URLs are not fetched. Scores and quotations come from synthetic fixtures, and GS examples are not official eligibility assessments.</p></div></div>}
      <div className="mt-5 flex flex-wrap gap-2"><Badge>{cloud ? 'Cloud workspace storage' : 'Local demo storage'}</Badge><Badge>Human review first</Badge><Badge>No automatic hiring decisions</Badge></div>
    </Modal>
  </div>
}
