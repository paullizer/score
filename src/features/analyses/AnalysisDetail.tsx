import { useParams } from 'react-router-dom'
import { RealAnalysisDetail } from './RealAnalysisDetail'

/** `/analyses/:id` opens the saved analysis. Legacy `data=real|samples` parameters are ignored. */
export function AnalysisDetail() {
  const { id } = useParams()
  return id ? <RealAnalysisDetail id={id} /> : null
}