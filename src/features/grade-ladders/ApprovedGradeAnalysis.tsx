import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { useRealAnalyses } from '../../app/real-analyses-context'
import { Badge, Button } from '../../components/ui'
import { realAnalysisLink, targetVersionLabel } from '../analyses/realAnalysisUi'
import { realTargetAvailable } from '../analyses/realAnalysisUi'
import { useWorkspace } from '../../app/workspace-context'
import { useLifecycleAccess } from '../../components/lifecycle/useLifecycleAccess'

export function ApprovedGradeAnalysis({ ladderId }: { ladderId: string }) {
  const api = useRealAnalyses()
  const { workspace } = useWorkspace()
  const { canEdit } = useLifecycleAccess({ kind: 'ladder', id: ladderId })
  if (!api) return null
  const targets = api.targets.state === 'ready' ? api.targets.value.filter((target) => target.kind === 'grade' && target.selection.ladderId === ladderId && realTargetAvailable(workspace, target.selection)) : []
  const available = api.phase === 'ready' && api.features?.realAnalyses && api.targets.state === 'ready' && !api.targets.error
  return <section className="mt-4 space-y-3 border-t pt-4" aria-label="Approved GS analysis targets">
    <h3 className="text-[12px] font-semibold">Approved versions for real resume analysis</h3>
    {!available && <p className="text-[11px] text-muted">{api.creationError ?? api.error ?? (api.targets.state === 'error' || api.targets.state === 'ready' ? api.targets.error : null) ?? 'Checking eligible analysis targets…'}
      <Button size="sm" variant="ghost" onClick={() => { void api.refresh(); void api.refreshTargets() }}>Refresh analysis targets</Button></p>}
    {available && !targets.length && <p className="text-[11px] text-muted">No eligible approved version is available yet. Unapproved or incomplete drafts cannot be analyzed.</p>}
    {targets.map((target) => <div key={target.id} className="space-y-2 text-[11px]">
      <strong>{target.label}</strong><p className="text-muted">{target.sublabel}</p><div className="flex flex-wrap gap-2"><Badge>{targetVersionLabel(target.selection)}</Badge>
        {target.kind === 'grade' && target.newerDraftAvailable && <Badge tone="warning">Newer draft not used</Badge>}</div>
      {canEdit && api.canWrite && available ? <Link className="text-link" {...realAnalysisLink({ targets: [target.selection] }, api.workspaceId)}>Analyze resumes with this approved version <ArrowRight size={13} aria-hidden="true" /></Link>
        : <p className="text-muted">Read-only or unavailable · an owner or editor can start a real analysis.</p>}
    </div>)}
    {targets.length > 1 && available && canEdit && api.canWrite && <Link className="button button-secondary button-sm" {...realAnalysisLink({ targets: targets.map((target) => target.selection) }, api.workspaceId)}>Review all approved targets</Link>}
    <p className="text-[10px] text-muted">Each target uses its approved version’s captured context and source set, not the latest draft. Selection opens a manual review; it never starts scoring automatically.</p>
  </section>
}
