import { useState } from 'react'
import { LogOut } from 'lucide-react'
import type { CloudUser } from '../../domain/cloud'
import { Button, InlineError } from '../ui'

export function AccountPanel({ user, signOut, compact = false }: { user: CloudUser; signOut: () => Promise<void>; compact?: boolean }) {
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState('')
  return <div>
    <div className="account-panel">
      <span className="avatar avatar-small" aria-hidden="true" title={compact ? `${user.name}\n${user.email}` : undefined}>{user.name.trim().slice(0, 1).toUpperCase() || 'U'}</span>
      <div className="account-panel-identity min-w-0"><strong className="block truncate text-[12px] font-medium">{user.name}</strong><span className="block truncate text-[10px] text-muted">{user.email}</span></div>
      <Button size="sm" variant="ghost" className="icon-button" aria-label="Sign out" title={compact ? 'Sign out' : undefined} icon={LogOut} disabled={signingOut}
        onClick={() => {
          setSigningOut(true); setError('')
          void signOut().catch((caught) => setError(caught instanceof Error ? caught.message : 'Sign-out could not be completed. Try again.')).finally(() => setSigningOut(false))
        }} />
    </div>
    {error && <InlineError>{error}</InlineError>}
  </div>
}
