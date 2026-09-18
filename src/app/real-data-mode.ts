import type { Workspace } from '../domain/types'

export type RealDataMode = 'real' | 'samples' | 'invalid'

export function dataMode(params: URLSearchParams, cloud: boolean, knownSample = false): RealDataMode {
  const explicit = params.get('data')
  if (explicit !== null) return explicit === 'real' || explicit === 'samples' ? explicit : 'invalid'
  return cloud && !knownSample ? 'real' : 'samples'
}

export function analysisDataMode(params: URLSearchParams, cloud: boolean, workspace: Workspace, runId?: string): RealDataMode {
  if (runId) return dataMode(params, cloud, workspace.runs.some((run) => run.id === runId))
  if (params.get('from')) return dataMode(params, cloud, workspace.runs.some((run) => run.id === params.get('from')))
  const resumes = (params.get('resumes') ?? '').split(',').filter(Boolean)
  const rubrics = (params.get('rubrics') ?? '').split(',').filter(Boolean)
  const allSamples = resumes.length + rubrics.length > 0
    && !['jobs', 'targets', 'ladder', 'resumeSelections', 'targetSelections', 'selectionTransfer', 'selectionTransport'].some((key) => params.has(key))
    && resumes.every((id) => workspace.resumes.some((resume) => resume.id === id && resume.sample === true))
    && rubrics.every((id) => workspace.rubrics.some((rubric) => rubric.id === id && rubric.dataKind !== 'real'))
  return dataMode(params, cloud, allSamples)
}

export function sampleDataLink(path: string, cloud: boolean): string {
  if (!cloud) return path
  const [pathname, search = ''] = path.split('?')
  const params = new URLSearchParams(search)
  params.set('data', 'samples')
  return `${pathname}?${params}`
}
