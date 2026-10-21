import { Link } from 'react-router-dom'
import { BadgeCheck } from 'lucide-react'
import { Button } from '../../components/ui'
import { PENDING_RUBRICS_LINK, useRubricApprovals } from './useRubricApproval'

export function PendingRubricNotice({ onApproveAll }: { onApproveAll?: () => void }) {
  const { pending, canApprove } = useRubricApprovals()
  if (!pending.length) return null
  return <div className="info-callout mb-5">
    <BadgeCheck size={18} aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <strong>{pending.length} {pending.length === 1 ? 'job rubric needs' : 'job rubrics need'} approval</strong>
      <p>A workspace owner must approve these drafts before new work can use them. Any previously approved version stays available.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Link className="text-link" to={PENDING_RUBRICS_LINK}>Review pending rubrics</Link>
        {canApprove && onApproveAll && <Button size="sm" icon={BadgeCheck} onClick={onApproveAll}>Approve all pending ({pending.length})</Button>}
      </div>
    </div>
  </div>
}
