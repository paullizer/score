import { useId, useLayoutEffect, useRef, useState } from 'react'
import { BookOpen, ClipboardCheck, Database, Files, FlaskConical, GitBranch, Layers3, LockKeyhole, MessageSquare, Settings, ShieldCheck, Sparkles, Timer, Users, type LucideIcon } from 'lucide-react'
import { useAiTerminology } from '../../../app/public-settings-context'
import { PIPELINE_EDGES, PIPELINE_NODES, PIPELINE_STAGES, type PipelineNodeId } from './pipeline-map'

const icons: Record<PipelineNodeId, LucideIcon> = {
  results: Files, feedback: MessageSquare, sources: BookOpen, curate: ClipboardCheck,
  pack: Database, candidate: Layers3, tasks: GitBranch, settings: Settings,
  holdout: Users, evaluation: FlaskConical, checks: ShieldCheck, activate: LockKeyhole, active: Sparkles, future: Timer,
}

export function RelationshipMap({ selected, focused, savedEdges, metadata, onSelect }: {
  selected: PipelineNodeId | null; focused: boolean; savedEdges: Set<string>
  metadata: Partial<Record<PipelineNodeId, string>>; onSelect: (id: PipelineNodeId) => void
}) {
  const terms = useAiTerminology()
  const graph = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<PipelineNodeId, HTMLButtonElement>())
  const marker = `pipeline-${useId().replace(/:/g, '')}`
  const [geometry, setGeometry] = useState({ width: 0, height: 0, paths: [] as { id: string; path: string }[] })
  useLayoutEffect(() => {
    const element = graph.current
    if (!element) return
    const measure = () => {
      const bounds = element.getBoundingClientRect()
      const paths = PIPELINE_EDGES.flatMap(edge => {
        const from = nodes.current.get(edge.from)?.getBoundingClientRect(), to = nodes.current.get(edge.to)?.getBoundingClientRect()
        if (!from || !to || !bounds.width) return []
        let path: string
        if (PIPELINE_NODES.find(node => node.id === edge.from)?.column === PIPELINE_NODES.find(node => node.id === edge.to)?.column) {
          const down = from.top < to.top
          const x = from.left + from.width / 2 - bounds.left
          path = `M ${x} ${(down ? from.bottom : from.top) - bounds.top} L ${x} ${(down ? to.top : to.bottom) - bounds.top}`
        } else {
          const x1 = from.right - bounds.left, y1 = from.top + from.height / 2 - bounds.top
          const x2 = to.left - bounds.left, y2 = to.top + to.height / 2 - bounds.top
          path = edge.upper
            ? `M ${x1} ${y1} H ${x1 + 12} V ${y2} H ${x2}`
            : `M ${x1} ${y1} C ${x1 + 18} ${y1}, ${x2 - 18} ${y2}, ${x2} ${y2}`
        }
        return [{ id: `${edge.from}:${edge.to}`, path }]
      })
      setGeometry({ width: bounds.width, height: bounds.height, paths })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (observer) {
      observer.observe(element)
      nodes.current.forEach(node => observer.observe(node))
    }
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [metadata, focused])
  const related = new Set<string>()
  for (const edge of PIPELINE_EDGES) {
    if (savedEdges.has(`${edge.from}:${edge.to}`)) { related.add(edge.from); related.add(edge.to) }
  }
  return <>
    <ol className="pipeline-stages" aria-label="Quality improvement stages">{PIPELINE_STAGES.map((stage, index) =>
      <li key={stage}><span>{index + 1}</span>{stage}</li>)}</ol>
    <div ref={graph} className="pipeline-graph" aria-label="Evidence-to-release relationships">
      <svg className="pipeline-connectors" aria-hidden="true" viewBox={`0 0 ${geometry.width || 1} ${geometry.height || 1}`}>
        <defs>{['workflow', 'saved', 'future'].map(kind => <marker key={kind} id={`${marker}-${kind}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M 0 0 L 6 3.5 L 0 7" className={`pipeline-arrow ${kind}`} /></marker>)}</defs>
        {PIPELINE_EDGES.map(edge => {
          const id = `${edge.from}:${edge.to}`, path = geometry.paths.find(value => value.id === id)?.path
          const kind = edge.kind === 'future' ? 'future' : savedEdges.has(id) ? 'saved' : 'workflow'
          return path && <path key={id} d={path} className={`pipeline-edge ${kind}${edge.kind === 'context' ? ' context' : ''}`}
            markerEnd={`url(#${marker}-${kind})`} />
        })}
      </svg>
      {PIPELINE_STAGES.map((stage, column) => <div key={stage} className="pipeline-column" aria-label={stage}>
        {PIPELINE_NODES.filter(node => node.column === column).map(node => {
          const Icon = icons[node.id]
          return <button key={node.id} ref={element => { if (element) nodes.current.set(node.id, element); else nodes.current.delete(node.id) }}
            type="button" className={`pipeline-node${selected === node.id ? ' is-selected' : ''}${focused && !related.has(node.id) && selected !== node.id ? ' is-unrelated' : ''}`}
            style={{ gridRow: node.row }} data-pipeline-node={node.id}
            aria-pressed={selected === node.id} aria-controls="pipeline-node-details" onClick={() => onSelect(node.id)}>
            <span className="pipeline-node-title"><Icon size={16} aria-hidden="true" />{terms.text(node.title)}</span>
            <span className="pipeline-node-description">{node.description}</span>
            {metadata[node.id] && <span className="pipeline-node-metadata">{metadata[node.id]}</span>}
          </button>
        })}
      </div>)}
    </div>
    <div className="pipeline-legend" aria-label="Relationship legend">
      <span><i className="saved" />Saved relationship</span><span><i />Possible workflow relationship</span><span><i className="future" />Conditional future use</span>
    </div>
    <p className="pipeline-caption">Arrows explain relationships, not proof that every input contributed. Saved version pins describe the selected change; this is not an exhaustive live lineage.</p>
    <ul className="sr-only" aria-label="Map relationships">{PIPELINE_EDGES.map(edge => <li key={`${edge.from}:${edge.to}`}>
      {terms.text(PIPELINE_NODES.find(node => node.id === edge.from)?.title ?? '')} to {terms.text(PIPELINE_NODES.find(node => node.id === edge.to)?.title ?? '')}
      {savedEdges.has(`${edge.from}:${edge.to}`) ? ': saved relationship.' : edge.kind === 'future' ? ': conditional future use.' : ': possible workflow relationship.'}
    </li>)}</ul>
  </>
}
