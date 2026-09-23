import { useParams } from 'react-router-dom'
import { RealResumesPage } from './RealResumesPage'

/** `/resumes` and `/resumes/:id`. Legacy `data=real|samples` parameters are ignored. */
export function ResumesPage() {
  const { id } = useParams<{ id: string }>()
  return <RealResumesPage id={id} />
}