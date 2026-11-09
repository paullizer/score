import { useId } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button, InlineError } from '../../components/ui'
import { getDisplayName } from '../../domain/displayNames'
import type { RealAnalysisComparisonSummary, RealAnalysisTargetSummary } from '../../domain/real-analyses'
import { targetVersionLabel } from './realAnalysisUi'
import { calculateScoreDistribution, scoreDistributionBinLabel, type ScoreDistribution } from './analysisScoreDistributionData'

const scoreFormat = new Intl.NumberFormat('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const rangeFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 1 })

function ScoreAxis() {
  return <div className="score-distribution-axis" aria-hidden="true">
    {Array.from({ length: 11 }, (_, index) => <span key={index} className={index % 2 ? 'score-distribution-minor-tick' : ''}
      style={{ left: `${index * 10}%` }}>{index * 10}</span>)}
  </div>
}

function DistributionPlot({ distribution }: { distribution: ScoreDistribution }) {
  const { statistics, bins, markers, counts } = distribution
  if (!statistics) return null
  const maximumCount = Math.max(...bins.map(bin => bin.count))
  const countTicks = [...new Set([0, Math.ceil(maximumCount / 2), maximumCount])]
  const markerHeight = Math.max(...markers.map(marker => Math.min(3, marker.count) * 8 + (marker.count > 3 ? 18 : 4)))
  const range = `${rangeFormat.format(statistics.minimum)}-${rangeFormat.format(statistics.maximum)}`
  const middleHalf = `${rangeFormat.format(statistics.lowerQuartile)}-${rangeFormat.format(statistics.upperQuartile)}`
  return <figure className="score-distribution-figure" aria-label="Saved score distribution">
    <figcaption className="sr-only">{counts.scored} saved scores on a fixed 0 to 100 evidence-match scale.
      Mean {scoreFormat.format(statistics.mean)}, median {scoreFormat.format(statistics.median)}, range {range}, middle half {middleHalf}.
      The range is observed data, not a confidence interval. Exact score and band counts are available below.</figcaption>
    <div className="score-distribution-spread-caption" aria-hidden="true"><span>Score range</span><span>Middle half: <strong>{middleHalf}</strong></span></div>
    <div className="score-distribution-inset" aria-hidden="true">
      <div className="score-distribution-spread">
        <span className="score-distribution-whisker" style={{ left: `${statistics.minimum}%`, width: `${statistics.maximum - statistics.minimum}%` }} />
        {[statistics.minimum, statistics.maximum].map((score, index) =>
          <span key={index} className="score-distribution-range-end" style={{ left: `${score}%` }} />)}
        <span className={`score-distribution-middle-half${statistics.lowerQuartile === statistics.upperQuartile ? ' is-point' : ''}`}
          style={{ left: `${statistics.lowerQuartile}%`, width: `${statistics.upperQuartile - statistics.lowerQuartile}%` }} />
        <span className="score-distribution-median" style={{ left: `${statistics.median}%` }} />
      </div>
      <ScoreAxis />
      <div className="score-distribution-markers" style={{ height: `${markerHeight}px` }}>
        {markers.map(({ score, count }) => <span key={score} className="score-distribution-marker-group" style={{ left: `${score}%` }}>
          {count > 3 && <span className="score-distribution-marker-count">{count}</span>}
          {Array.from({ length: Math.min(3, count) }, (_, index) =>
            <span key={index} className="score-distribution-marker" style={{ bottom: `${4 + index * 8}px` }} />)}
        </span>)}
      </div>
    </div>
    <p className="score-distribution-note">Resume scores. Shared scores stack; larger groups show a count.</p>
    <div className="score-distribution-histogram" aria-hidden="true">
      <div className="score-distribution-count-axis">{countTicks.map(count =>
        <span key={count} style={{ bottom: `${count / maximumCount * 100}%` }}>{count}</span>)}</div>
      <div className="score-distribution-histogram-plot">
        {countTicks.map(count => <span key={count} className="score-distribution-rule" style={{ bottom: `${count / maximumCount * 100}%` }} />)}
        <div className="score-distribution-bins">{bins.map(bin => <div key={bin.lower} className="score-distribution-bin">
          <span className="score-distribution-bar-count" style={{ bottom: `${bin.count / maximumCount * 100}%` }}>{bin.count}</span>
          <span className="score-distribution-bar" style={{ height: `${bin.count / maximumCount * 100}%` }} />
        </div>)}</div>
      </div>
    </div>
    <div className="score-distribution-inset"><ScoreAxis /><p className="score-distribution-axis-label" aria-hidden="true">Evidence-match score (0-100)</p></div>
  </figure>
}

function DistributionCounts({ distribution }: { distribution: ScoreDistribution }) {
  return <details className="score-distribution-counts">
    <summary>View score counts</summary>
    <div className="score-distribution-count-columns">
      <section aria-label="Score band counts"><h3>Score bands</h3><dl className="score-distribution-count-list">
        {distribution.bins.map(bin => <div key={bin.lower}><dt>{scoreDistributionBinLabel(bin)}</dt><dd>{bin.count}</dd></div>)}
      </dl></section>
      <section aria-label="Exact score counts"><h3>Exact scores</h3>
        <div className="score-distribution-exact-counts" role="region" aria-label="Scrollable exact score counts" tabIndex={0}>
          <dl className="score-distribution-count-list">
            {distribution.markers.map(marker => <div key={marker.score}><dt>{marker.score} / 100</dt>
              <dd>{marker.count} {marker.count === 1 ? 'resume' : 'resumes'}</dd></div>)}
          </dl>
        </div>
      </section>
    </div>
    <p className="score-distribution-note">The middle half uses the median of the lower and upper halves, excluding the central value for odd-sized groups.
      Whiskers show the lowest and highest saved scores, not outlier limits.</p>
  </details>
}

export function AnalysisScoreDistribution({ target, comparisons, planned, error, onRetry }: {
  target?: RealAnalysisTargetSummary
  comparisons: readonly RealAnalysisComparisonSummary[] | null
  planned: number
  error?: string | null
  onRetry: () => void
}) {
  const headingId = useId()
  const distribution = target && comparisons ? calculateScoreDistribution(comparisons, target.selection, planned) : null
  const statistics = distribution?.statistics
  const counts = distribution?.counts
  const exclusionCounts: readonly [number, string][] = counts ? [
    [counts.withheld, 'withheld'], [counts.withoutScore, 'without a saved total'], [counts.queued, 'queued'],
    [counts.running, 'assessing'], [counts.uninitialized, 'not initialized'], [counts.failed, 'failed'],
    [counts.cancelled, 'cancelled'], [counts.invalid, 'invalid'],
  ] : []
  const exclusions = exclusionCounts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`).join(' · ')
  return <section className="panel mt-5 score-distribution" aria-labelledby={headingId}>
    <div className="section-heading score-distribution-heading"><div><h2 id={headingId}>Score distribution</h2>
      {target && <p>{getDisplayName(target, target.label)} · {targetVersionLabel(target.selection)}</p>}
    </div></div>
    <div className="score-distribution-content">
      {!target ? <p className="score-distribution-note">Select one exact job or grade using <strong>Comparison target</strong> below.
        Scores across different targets are not pooled.</p>
        : <>
          {error && <InlineError>{error} {comparisons ? 'The last loaded scores are shown; the refresh could not be confirmed.' : 'Saved scores could not be loaded.'}
            {' '}<Button size="sm" icon={RotateCcw} onClick={onRetry}>Reload scores</Button></InlineError>}
          {distribution?.errors.length ? <InlineError>{distribution.errors.map(message => <p key={message}>{message}</p>)}
            <Button size="sm" icon={RotateCcw} onClick={onRetry}>Reload scores</Button></InlineError> : null}
          {!distribution ? !error && <div className="score-distribution-loading" role="status">
            <p>Loading saved scores...</p><div className="score-distribution-skeleton" aria-hidden="true" />
          </div> : <>
            <dl className="score-distribution-statistics">
              <div><dt>Scored</dt><dd aria-live="polite">{counts?.scored}<span> / {planned}</span></dd></div>
              <div><dt>Mean</dt><dd>{statistics ? scoreFormat.format(statistics.mean) : <span>Not available</span>}</dd></div>
              <div><dt>Median</dt><dd>{statistics ? scoreFormat.format(statistics.median) : <span>Not available</span>}</dd></div>
              <div><dt>Range</dt><dd>{statistics ? `${rangeFormat.format(statistics.minimum)}-${rangeFormat.format(statistics.maximum)}` : <span>Not available</span>}</dd></div>
            </dl>
            {statistics ? <><DistributionPlot distribution={distribution} /><DistributionCounts distribution={distribution} /></>
              : <div className="score-distribution-empty"><h3>No available overall scores</h3>
                <p>{counts && counts.queued + counts.running + counts.uninitialized > 0
                  ? 'The distribution will fill in as comparisons finish. No scores are invented while work is pending.'
                  : 'These comparisons have no available overall scores. Withheld or missing totals are not plotted as zeros.'}</p>
              </div>}
            {exclusions && <p className="score-distribution-note">Not charted: {exclusions}.</p>}
            {counts && counts.corrections > 0 && <p className="score-distribution-note">{counts.corrections} re-scores or corrections in progress.
              Showing the last saved results until replacements are published.</p>}
          </>}
        </>}
      <p className="score-distribution-note">Full target group; search and sorting below do not change it.
        Descriptive only, not a fitted curve, an anomaly test, or a hiring recommendation.</p>
    </div>
  </section>
}
