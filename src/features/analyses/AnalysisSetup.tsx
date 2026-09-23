import { useLocation } from 'react-router-dom'
import { RealAnalysisSetup } from './RealAnalysisSetup'

/** `/analyses/new`: every selection starts a fresh real-analysis builder. */
export function AnalysisSetup() {
  const location = useLocation()
  return <RealAnalysisSetup key={`${location.key}:${location.search}:${location.hash}`} />
}