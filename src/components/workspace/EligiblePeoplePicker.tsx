import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { EligibleUser, EligibleUserPage } from '../../domain/access'
import { Badge, Button, InlineError, SearchField } from '../ui'

export function EligiblePeoplePicker({ load, onChoose, disabled = false, memberIds = [], selectedId }: {
  load: (query: string, continuation?: string, signal?: AbortSignal) => Promise<EligibleUserPage>
  onChoose: (person: EligibleUser) => void
  disabled?: boolean
  memberIds?: string[]
  selectedId?: string
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<EligibleUserPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const cursors = useRef(new Set<string>())

  useEffect(() => {
    const controller = new AbortController()
    const started = ++generation.current
    request.current?.abort()
    request.current = controller
    setLoading(true); setError(''); setPage(null); cursors.current.clear()
    const timer = window.setTimeout(() => {
      void load(query, undefined, controller.signal).then(value => {
        if (controller.signal.aborted || generation.current !== started) return
        setPage(value)
      }).catch(caught => {
        if (!controller.signal.aborted && generation.current === started) setError(caught instanceof Error ? caught.message : 'The eligible people directory could not be loaded. Try again; an outage is not an empty directory.')
      }).finally(() => {
        if (!controller.signal.aborted && generation.current === started) setLoading(false)
      })
    }, query ? 250 : 0)
    return () => { window.clearTimeout(timer); controller.abort(); request.current?.abort() }
  }, [load, query, revision])

  async function more() {
    if (!page?.continuation || loading) return
    const cursor = page.continuation
    const controller = new AbortController()
    const started = generation.current
    request.current = controller
    setLoading(true); setError('')
    try {
      if (cursors.current.has(cursor)) throw new Error('The directory repeated a page. Refresh people before continuing.')
      const next = await load(query, cursor, controller.signal)
      if (controller.signal.aborted || generation.current !== started) return
      if (next.continuation && (next.continuation === cursor || cursors.current.has(next.continuation))) throw new Error('The directory repeated a continuation token. Refresh people before continuing.')
      cursors.current.add(cursor)
      const users = new Map([...page.users, ...next.users].map(user => [user.id, user]))
      setPage({ users: [...users.values()], continuation: next.continuation })
    } catch (caught) {
      if (!controller.signal.aborted && generation.current === started) setError(caught instanceof Error ? caught.message : 'The next directory page could not be loaded.')
    } finally {
      if (!controller.signal.aborted && generation.current === started) setLoading(false)
    }
  }

  return <section className="access-people" aria-label="Eligible people">
    <div className="toolbar mb-3">
      <SearchField value={query} onChange={setQuery} label="Search eligible people" placeholder="Search name or email…" />
      <Button size="sm" icon={RefreshCw} disabled={loading || disabled} onClick={() => setRevision(value => value + 1)}>Refresh people</Button>
    </div>
    <p className="access-hint">People already assigned Score access in Microsoft Entra ID, including people who have not signed in yet. Groups are not workspace members.</p>
    {error && <InlineError>{error}</InlineError>}
    <ul className="access-people-list">
      {page?.users.map(person => <li key={person.id}>
        <div className="access-person"><strong>{person.name || person.email || person.id}</strong><span>{person.email || 'Email unavailable'}</span>
          {person.applicationRoles.includes('Score.Admin') && <Badge tone="accent">Application administrator</Badge>}
        </div>
        <Button size="sm" disabled={disabled || memberIds.includes(person.id)} aria-pressed={selectedId === person.id}
          onClick={() => onChoose(person)}>{memberIds.includes(person.id) ? 'Already a member' : selectedId === person.id ? 'Selected' : `Select ${person.name || person.email || person.id}`}</Button>
      </li>)}
    </ul>
    {loading && <p role="status" className="access-hint">Loading eligible people…</p>}
    {!loading && page && !page.users.length && !error && <p role="status" className="access-hint">No eligible people match. Ask an Entra administrator to check Score application assignment; new assignments can take time to appear.</p>}
    {page?.continuation && <Button size="sm" disabled={loading || disabled} onClick={() => void more()}>Load more people</Button>}
  </section>
}
