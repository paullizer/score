import { useCallback } from 'react'
import { Link, NavLink, Route, Routes } from 'react-router-dom'
import { ClipboardCheck, LoaderCircle } from 'lucide-react'
import { useWorkspace } from '../../app/workspace-context'
import { useApplicationNavigation } from '../../app/application-navigation-context'
import { workspaceCanReview, workspaceQcRole } from '../../domain/workspace-permissions'
import { getQcCapabilities } from '../../services/qualityControl'
import { Badge, Button, EmptyState, InlineError } from '../../components/ui'
import { QcComparisonReview, QcReviews } from './QcReviews'
import { CreateImprovementPlan, ImprovementPlan, ImprovementPlans, PromptHistory } from './QualityImprovement'
import { useQcResource } from './qc-ui'
import { QcPrivacyBoundary } from './QcPrivacyBoundary'
import '../../styles/quality-control.css'

export function QualityControlPage() {
  const { cloud } = useWorkspace()
  const application = useApplicationNavigation()
  const metadata = cloud?.workspaces.find(item => item.id === cloud.currentWorkspaceId)
  const role = workspaceQcRole(metadata)
  if (!cloud || !metadata || metadata.deletedAt || !workspaceCanReview(role, application?.applicationAdmin === true)) {
    return <EmptyState icon={ClipboardCheck} title="QC requires an authorized cloud workspace"
      description="A workspace reviewer, editor, owner, or application admin with workspace membership can review real saved assessments. Samples cannot be used for calibration."
      action={<Link className="button button-secondary button-md" to="/analyses">Return to analyses</Link>} />
  }
  return <QcPrivacyBoundary key={JSON.stringify([
    cloud.currentWorkspaceId, cloud.user.tenantId, cloud.user.id, role, application?.applicationAdmin === true,
  ])}
    onAccessLost={cloud.refreshWorkspaces}>
    <QcWorkspace workspaceId={cloud.currentWorkspaceId} />
  </QcPrivacyBoundary>
}

function QcWorkspace({ workspaceId }: { workspaceId: string }) {
  const load = useCallback((signal: AbortSignal) => getQcCapabilities(workspaceId, signal), [workspaceId])
  const access = useQcResource(load)
  if (!access.value) return <><EmptyState icon={access.loading ? LoaderCircle : ClipboardCheck}
    title={access.loading ? 'Opening quality control' : 'Quality control is unavailable'}
    description="QC uses private saved evidence and independent human feedback. No model work starts by opening this page."
    action={<Button onClick={access.reload}>Check QC access</Button>} />{access.error && <InlineError>{access.error}</InlineError>}</>
  const capabilities = access.value
  if (!capabilities.reviews) return <EmptyState title="QC storage is not ready" description={capabilities.message ?? 'An operator must deploy the private QC services. No sample feedback is substituted.'} action={<Button onClick={access.reload}>Check service</Button>} />
  return <div className="qc-workspace">
    <div className="qc-mode-banner"><div><Badge tone="accent">QC mode</Badge><span>Human feedback and trial results never replace published scores.</span></div>
      <Link className="text-link" to="/analyses?data=real">Return to normal mode</Link></div>
    <nav className="qc-tabs" aria-label="Quality control navigation">
      <NavLink to="/qc" end>Reviews</NavLink>
      <NavLink to="/qc/improvements">Quality improvement</NavLink>
      <NavLink to="/qc/prompts">Prompt versions</NavLink>
    </nav>
    {!capabilities.admissionEnabled && <p className="qc-notice">{capabilities.message ?? 'New QC changes are disabled. Saved QC history and cancellation of accepted work remain available.'} This switch does not change normal workspace permissions.</p>}
    {!capabilities.writable && <p className="qc-notice">QC changes are read-only for this workspace. Saved QC history remains available.</p>}
    {capabilities.admissionEnabled && !capabilities.improvements && <p className="qc-notice">{capabilities.message ?? 'New AI planning and evaluation work is unavailable; saved reviews and plans remain readable.'}</p>}
    <Routes>
      <Route index element={<QcReviews workspaceId={workspaceId} capabilities={capabilities} />} />
      <Route path="reviews/:runId/:comparisonId" element={<QcComparisonReview workspaceId={workspaceId} capabilities={capabilities} />} />
      <Route path="improvements" element={<ImprovementPlans workspaceId={workspaceId} capabilities={capabilities} />} />
      <Route path="improvements/new" element={<CreateImprovementPlan workspaceId={workspaceId} capabilities={capabilities} />} />
      <Route path="improvements/:planId" element={<ImprovementPlan workspaceId={workspaceId} capabilities={capabilities} />} />
      <Route path="prompts" element={<PromptHistory workspaceId={workspaceId} capabilities={capabilities} />} />
      <Route path="*" element={<EmptyState title="QC page not found" description="Return to the reviews list to select a saved analysis." />} />
    </Routes>
  </div>
}
