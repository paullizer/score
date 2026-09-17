import { useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { ArrowUpRight, BarChart3, BriefcaseBusiness, Check, ChevronRight, CircleHelp, Files, FlaskConical, Layers3, Menu, Plus, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { useWorkspace } from './workspace-context'
import { ThemeControl } from './ThemeControl'
import { Badge, Button, EmptyState, Modal } from '../components/ui'
import { JobsPage, JobDetail } from '../features/jobs/JobsPage'
import { ResumesPage } from '../features/resumes/ResumesPage'
import { RubricsPage } from '../features/rubrics/RubricsPage'
import { AnalysesPage, AnalysisSetup, AnalysisDetail } from '../features/analyses/AnalysesPage'
import { latestRubrics } from '../domain/selectors'

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { workspace } = useWorkspace()
  const items = [
    { to: '/jobs', label: 'Jobs', icon: BriefcaseBusiness, count: workspace.jobs.length },
    { to: '/resumes', label: 'Resumes', icon: Files, count: workspace.resumes.length },
    { to: '/rubrics', label: 'Rubrics', icon: Layers3, count: latestRubrics(workspace).length },
    { to: '/analyses', label: 'Analyses', icon: BarChart3, count: workspace.runs.length },
  ]
  return <nav className="main-nav" aria-label="Main navigation">{items.map(({ to, label, icon: Icon, count }) =>
    <NavLink key={to} to={to} onClick={onNavigate} className={({ isActive }) => isActive ? 'nav-item is-active' : 'nav-item'}>
      <Icon size={18} strokeWidth={1.7} /><span>{label}</span><span className="nav-count">{count}</span>
    </NavLink>)}</nav>
}

export function App() {
  const { workspace, storageError, retrySave, notice, clearNotice, resetDemo } = useWorkspace()
  const [showReset, setShowReset] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const section = location.pathname.split('/')[1] || 'jobs'
  const isDetail = location.pathname.split('/').filter(Boolean).length > 1

  return <div className="app-layout">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <Link to="/jobs" className="brand" aria-label="Score home"><span className="brand-mark"><Layers3 size={22} strokeWidth={2} /></span><span>score<span className="brand-period">.</span></span></Link>
      <div className="workspace-label"><span className="workspace-monogram">S</span><div><strong>My workspace</strong><span>Personal / local</span></div><span className="workspace-online" /></div>
      <div className="nav-heading">WORKSPACE</div>
      <Navigation />
      <div className="sidebar-bottom">
        <div className="sidebar-note"><span className="small-symbol"><ShieldCheck size={19} /></span><strong>Evidence, not impressions.</strong><p>Clear criteria. Traceable matches.<br />A human makes the decision.</p>
          <button className="text-link" onClick={() => setShowAbout(true)}>About this preview <ArrowUpRight size={13} /></button>
        </div>
        <div className="sidebar-utility"><span>Appearance</span><ThemeControl /></div>
        <button className="reset-button" onClick={() => setShowReset(true)}><RotateCcw size={14} />Reset demo workspace</button>
        <div className="sidebar-version">SCORE / UI PREVIEW <span>V0.1</span></div>
      </div>
    </aside>
    <div className="app-body">
      <header className="topbar">
        <div className="flex items-center gap-3"><Button variant="ghost" icon={Menu} className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileNav(true)} />
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={12} /><Link to={`/${section}`}>{section[0].toUpperCase() + section.slice(1)}</Link>{isDetail && <><ChevronRight size={12} /><span>Review</span></>}</div>
        </div>
        <div className="topbar-actions"><span className={`save-status ${storageError ? 'is-error' : ''}`}><span />{storageError ? 'Changes not saved' : 'Saved on this device'}</span>
          <button className="demo-chip" onClick={() => setShowAbout(true)}><FlaskConical size={13} />Demo workspace</button>
          <Button variant="primary" size="sm" icon={Plus} onClick={() => navigate('/analyses/new')}>New analysis</Button>
        </div>
      </header>
      {storageError && <div className="storage-banner" role="alert"><span>{storageError}</span><Button size="sm" onClick={retrySave}>Retry saving</Button></div>}
      <main id="main-content" className="main-content">
        <Routes>
          <Route path="/" element={<Navigate to="/jobs" replace />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="/resumes" element={<ResumesPage />} />
          <Route path="/resumes/:id" element={<ResumesPage />} />
          <Route path="/rubrics" element={<RubricsPage />} />
          <Route path="/rubrics/:id" element={<RubricsPage />} />
          <Route path="/analyses" element={<AnalysesPage />} />
          <Route path="/analyses/new" element={<AnalysisSetup key={location.key} />} />
          <Route path="/analyses/:id" element={<AnalysisDetail key={location.pathname} />} />
          <Route path="*" element={<EmptyState title="This page is not in your workspace" description="Return to the jobs library to find your next review." action={<Button onClick={() => navigate('/jobs')}>Go to jobs</Button>} />} />
        </Routes>
        <footer className="workspace-footer"><span><ShieldCheck size={13} />Private by design. This preview stays in your browser.</span><span>{workspace.jobs.length} jobs / {workspace.resumes.length} resumes</span></footer>
      </main>
    </div>
    {notice && <div className="toast" role="status"><span className="toast-icon"><Check size={16} /></span><p>{notice}</p><Button variant="ghost" className="icon-button" size="sm" icon={X} aria-label="Dismiss notification" onClick={clearNotice} /></div>}
    <Modal open={mobileNav} onOpenChange={setMobileNav} title="Your workspace" description="Explore your jobs, resumes, rubrics, and analyses." drawer>
      <Navigation onNavigate={() => setMobileNav(false)} /><div className="mobile-appearance"><span>Appearance</span><ThemeControl /></div>
      <Button icon={RotateCcw} onClick={() => { setMobileNav(false); setShowReset(true) }}>Reset demo workspace</Button>
    </Modal>
    <Modal open={showReset} onOpenChange={setShowReset} title="A fresh starting point" description="Reset your demo workspace?"
      footer={<><Button onClick={() => setShowReset(false)}>Keep my workspace</Button><Button variant="danger" icon={RotateCcw} onClick={() => { resetDemo(); setShowReset(false); navigate('/jobs') }}>Reset demo</Button></>}>
      <p>This replaces demo imports, rubric edits, and analysis history with the original fictional examples. It cannot be undone.</p>
      <p className="mt-4 text-muted">Your theme preference and all browser data outside Score are kept.</p>
    </Modal>
    <Modal open={showAbout} onOpenChange={setShowAbout} title="A clearer way to see the fit" description="Score / interactive UI preview"
      footer={<Button variant="primary" onClick={() => setShowAbout(false)}>Back to the workspace</Button>}>
      <div className="about-illustration"><BriefcaseBusiness /><ChevronRight /><Layers3 /><ChevronRight /><BarChart3 /></div>
      <h3 className="mb-3 text-lg font-semibold">A job. A rubric. The evidence.</h3>
      <p>Explore the complete review workflow with fictional jobs and resumes. Import files or URLs to simulate adding sample records, build a comparison, and follow each score back to its supporting passage.</p>
      <div className="info-callout mt-5"><CircleHelp size={18} /><div><strong>Nothing is uploaded or evaluated by AI.</strong><p>Selected file contents are never read. URLs are not fetched. Scores and quotations come from synthetic fixtures, and GS examples are not official eligibility assessments.</p></div></div>
      <div className="mt-5 flex flex-wrap gap-2"><Badge>Local demo storage</Badge><Badge>Human review first</Badge><Badge>No automatic hiring decisions</Badge></div>
    </Modal>
  </div>
}
