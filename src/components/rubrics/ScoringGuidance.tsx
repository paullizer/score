import { evidenceScale, type EvidenceScaleVersion } from '../../domain/evidence-scale'
import type { Criterion } from '../../domain/types'

export function ScoringGuidance({ criterion, scaleVersion, savedScore }: {
  criterion: Pick<Criterion, 'guidance' | 'levels'>
  scaleVersion?: EvidenceScaleVersion
  savedScore?: number | null
}) {
  const scale = scaleVersion && criterion.levels ? evidenceScale(scaleVersion) : null

  return <details className="scoring-guidance">
    <summary>Saved rubric guidance / scoring anchors</summary>
    {scale ? <>
      <ol className="scoring-guidance-levels" start={0} aria-label="Saved scoring anchors">
        {scale.levels.map((item) => {
          const examples = criterion.levels?.find((entry) => entry.level === item.level)?.examples
          const isSavedScore = savedScore === item.level
          return <li className={isSavedScore ? 'is-saved-score' : undefined} key={item.level}>
            <span className="scoring-guidance-number">{item.level}</span>
            <div className="scoring-guidance-body">
              <div className="scoring-guidance-heading">
                <strong>{item.label}</strong>
                {isSavedScore && <span className="scoring-guidance-saved">Saved score</span>}
              </div>
              <p>{item.description}</p>
              {examples && <p className="scoring-guidance-example"><strong>Examples: </strong>{examples}</p>}
            </div>
          </li>
        })}
      </ol>
      <div className="scoring-guidance-rule"><p>{scale.tieRule}</p><p>{scale.basis}</p></div>
    </> : <p className="scoring-guidance-legacy">{criterion.guidance}</p>}
  </details>
}
