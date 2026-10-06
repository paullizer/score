import { RefreshCw } from 'lucide-react'
import type {
  AdminSettings, DeploymentInventory, ModelDeployment, ModelTaskId, SettingsFieldError, SettingsFieldMetadata, TaskModelSettings,
} from '../../domain/admin-settings'
import { MODEL_TASK_IDS } from '../../domain/admin-settings-tasks'
import { Badge, Button } from '../../components/ui'
import { SettingsField, SettingsFieldProvenance } from './SettingsField'

const taskNames: Record<ModelTaskId, string> = {
  jobRubric: 'Job rubric extraction', resumeProfile: 'Resume profile extraction', gradeCompetencies: 'GS shared competency planning',
  gradeDraft: 'GS level draft', gradeReview: 'GS independent review', assessment: 'Candidate assessment',
  assessmentReview: 'Assessment grounding review', candidateSummary: 'Candidate summary', targetSummary: 'Job / grade overview',
  summaryReduction: 'Large-cohort summary reduction', summaryReview: 'Summary factual review', qcPlan: 'QC improvement planning',
}

/** What the configured Azure resource reports. Reading it never saves settings or provisions a model. */
export interface DeploymentDiscovery {
  status: 'idle' | 'loading' | 'ready' | 'error'
  inventory: DeploymentInventory | null
  error: string
}

// Settings IDs can't contain ':', so this prefix never collides with a deployment Score already lists.
const AVAILABLE = 'azure:'
const usable = (item: ModelDeployment) => item.enabled && item.capabilities.structuredOutputs
const titleOf = (item: ModelDeployment) => item.label || item.deploymentName
const sameName = (left: ModelDeployment, right: ModelDeployment) => left.deploymentName.toLowerCase() === right.deploymentName.toLowerCase()
const verificationText: Record<ModelDeployment['verification'], string> = {
  'deployment-config': 'This environment’s deployment settings', discovered: 'Your Azure resource', validated: 'A model test',
}

function versionOf(item: ModelDeployment, inventory: DeploymentInventory | null): string | null {
  return item.modelVersion ?? inventory?.deployments.find(found => sameName(found, item))?.modelVersion ?? null
}

/** The deployment and the model behind it, such as "job-rubric · gpt-5-mini 2025-08-07". */
function describe(item: ModelDeployment, inventory: DeploymentInventory | null): string {
  const version = versionOf(item, inventory)
  const model = titleOf(item) === item.modelName ? version : [item.modelName, version].filter(Boolean).join(' ')
  return model ? `${titleOf(item)} · ${model}` : titleOf(item)
}

function capabilitiesText(item: ModelDeployment, inventory: DeploymentInventory | null): string {
  const { contextTokens, maxOutputTokens, reasoningEfforts } = item.capabilities
  if (!item.capabilities.structuredOutputs) return [item.modelName, versionOf(item, inventory)].filter(Boolean).join(' ')
  return [
    [item.modelName, versionOf(item, inventory)].filter(Boolean).join(' '),
    `${contextTokens.toLocaleString()}-token context`,
    `up to ${maxOutputTokens.toLocaleString()} output tokens`,
    reasoningEfforts.length ? `reasoning ${reasoningEfforts.join(', ')}` : 'no reasoning setting',
  ].join(' · ')
}

function unavailableReason(item: ModelDeployment, listed: boolean): string {
  if (!item.capabilities.structuredOutputs) return 'Score doesn’t support this model'
  return listed ? 'turned off for new work' : 'not ready in Azure yet'
}

/** The schema's model-dependent checks, so a problem shows when a model is chosen rather than only at save. */
function taskIssues(binding: TaskModelSettings, deployment: ModelDeployment | undefined, deploymentId: string): string[] {
  if (!deployment || !usable(deployment)) return [`its model, ${deployment ? titleOf(deployment) : deploymentId}, can’t be used for new work`]
  const name = titleOf(deployment)
  const { capabilities } = deployment
  const issues: string[] = []
  if (binding.reasoningEffort !== null && !capabilities.reasoningEfforts.includes(binding.reasoningEffort)) {
    issues.push(`${name} doesn’t support reasoning effort “${binding.reasoningEffort}”`)
  }
  if (binding.temperature !== null && !capabilities.temperature) issues.push(`${name} doesn’t support temperature`)
  if (binding.topP !== null && !capabilities.topP) issues.push(`${name} doesn’t support top-p`)
  if (binding.completionTokenLimit > capabilities.maxOutputTokens) {
    issues.push(`its completion limit is above ${name}’s ${capabilities.maxOutputTokens.toLocaleString()}-token maximum`)
  }
  if (binding.inputBudget.maxRequest + binding.inputBudget.reservedTokens + binding.completionTokenLimit > capabilities.contextTokens) {
    issues.push(`its request budget doesn’t fit ${name}’s context window`)
  }
  return issues
}

function checkedTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function ModelSettingsEditor({
  settings, saved, defaults, fields, errors, onChange, discovery, discoveryAvailable, onRefreshDeployments, disabled, search,
}: {
  settings: AdminSettings; saved: AdminSettings; defaults: AdminSettings; fields: SettingsFieldMetadata[]; errors: SettingsFieldError[]
  onChange: (path: string, value: unknown) => void
  discovery: DeploymentDiscovery; discoveryAvailable: boolean; onRefreshDeployments: () => void
  disabled: boolean; search: string
}) {
  const deployments = settings.ai.deployments
  const inventory = discovery.inventory
  const elsewhere = (inventory?.deployments ?? []).filter(item => !deployments.some(listed => sameName(listed, item)))
  const addable = elsewhere.filter(usable)
  const blocked = elsewhere.filter(item => !usable(item))
  const offline = deployments.filter(item => !usable(item))
  const defaultId = settings.ai.defaultDeploymentId
  const defaultDeployment = deployments.find(item => item.id === defaultId)
  const tasks = MODEL_TASK_IDS.filter(task => settings.ai.tasks[task] !== undefined)
  const bindingOf = (task: ModelTaskId) => settings.ai.tasks[task] as TaskModelSettings
  const targetOf = (task: ModelTaskId) => bindingOf(task).deploymentId ?? defaultId
  const deploymentFor = (task: ModelTaskId) => deployments.find(item => item.id === targetOf(task))
  const nameFor = (task: ModelTaskId) => { const deployment = deploymentFor(task); return deployment ? titleOf(deployment) : targetOf(task) }
  const ownModel = tasks.filter(task => bindingOf(task).deploymentId !== null)
  const attention = tasks.map(task => ({ task, issues: taskIssues(bindingOf(task), deploymentFor(task), targetOf(task)) })).filter(item => item.issues.length > 0)
  const modelChanged = defaultId !== saved.ai.defaultDeploymentId || JSON.stringify(deployments) !== JSON.stringify(saved.ai.deployments)
    || tasks.some(task => bindingOf(task).deploymentId !== saved.ai.tasks[task]?.deploymentId)
  const common = { settings, saved, defaults, errors, onChange, disabled }
  const matches = (value: string) => !search || value.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  const metadata = (path: string) => fields.find(field => field.path === path)
  const names = deployments.map(item => `${item.label} ${item.deploymentName} ${item.modelName}`).join(' ')

  function add(item: ModelDeployment): string {
    const taken = new Set(deployments.map(entry => entry.id))
    let id = item.id
    for (let suffix = 2; taken.has(id); suffix++) id = `${item.id.slice(0, 120)}-${suffix}`
    onChange('ai.deployments', [...deployments, { ...item, id, enabled: true }])
    return id
  }

  /** Choosing a deployment Score doesn't list yet adds it, so one choice is all it takes. */
  function choose(path: string, value: string) {
    if (!value.startsWith(AVAILABLE)) { onChange(path, value || null); return }
    const found = addable.find(item => item.deploymentName === value.slice(AVAILABLE.length))
    if (found) onChange(path, add(found))
  }

  function useDefaultEverywhere() {
    onChange('ai.tasks', Object.fromEntries(Object.entries(settings.ai.tasks).map(([task, binding]) => [task, { ...binding, deploymentId: null }])))
  }

  const missing = (id: string) => !deployments.some(item => item.id === id) && <option value={id}>Unavailable: {id}</option>
  const options = <>
    {deployments.filter(usable).map(item => <option key={item.id} value={item.id}>{describe(item, inventory)}</option>)}
    {addable.length > 0 && <optgroup label="Also in your Azure resource">
      {addable.map(item => <option key={item.deploymentName} value={`${AVAILABLE}${item.deploymentName}`}>{describe(item, inventory)}</option>)}
    </optgroup>}
    {offline.length + blocked.length > 0 && <optgroup label="Can’t be used">
      {offline.map(item => <option key={item.id} value={item.id} disabled>{describe(item, inventory)} — {unavailableReason(item, true)}</option>)}
      {blocked.map(item => <option key={item.deploymentName} value={`${AVAILABLE}${item.deploymentName}`} disabled>{describe(item, inventory)} — {unavailableReason(item, false)}</option>)}
    </optgroup>}
  </>

  const discoveryText = !discoveryAvailable
    ? 'These lists show only the deployments Score already uses. Finding the other deployments in your Azure resource isn’t set up for this environment; ask an operator to turn it on.'
    : discovery.status === 'error'
      ? `Couldn’t list the deployments in your Azure resource: ${discovery.error.replace(/\.?$/, '.')} The lists show only the deployments Score already uses.`
      : discovery.status === 'loading'
        ? inventory ? 'Checking your Azure resource again…' : 'Looking for deployments in your Azure resource…'
        : inventory
          ? inventory.deployments.length === 0 ? `Your Azure resource reported no deployments at ${checkedTime(inventory.checkedAt)}.`
            : `Found ${inventory.deployments.length === 1 ? '1 deployment' : `${inventory.deployments.length} deployments`} in your Azure resource at ${checkedTime(inventory.checkedAt)}.`
          : ''
  const coverage = ownModel.length === 0
    ? `All ${tasks.length} AI tasks use the default model.`
    : `${tasks.length - ownModel.length} of ${tasks.length} AI tasks use the default model. ${ownModel.length === 1 ? 'One task uses its own model' : `${ownModel.length} tasks use their own model`}: ${ownModel.map(task => `${taskNames[task]} (${nameFor(task)})`).join(', ')}.`

  return <div className="space-y-6">
    {matches(`ai.defaultDeploymentId AI model default model ${names}`) && <section className="panel settings-section" aria-label="AI model">
      <h2>AI model</h2>
      <p>Score sends job rubric, resume, assessment, summary, and QC work to a model deployment in your Azure resource. Changes apply to new work once you review and save them; work that has already started keeps its model.</p>
      <label className="field settings-model-picker"><span className="field-label">Default model</span>
        <select className="input" disabled={disabled} value={defaultId} onChange={event => choose('ai.defaultDeploymentId', event.target.value)}>
          {missing(defaultId)}{options}
        </select>
        <span className="field-hint">Used by every task that doesn’t have its own model. <SettingsFieldProvenance field={metadata('ai.defaultDeploymentId')} changed={defaultId !== saved.ai.defaultDeploymentId} /></span>
        {errors.filter(error => error.path === 'ai.defaultDeploymentId').map((error, index) => <span role="alert" className="settings-error" key={index}>{error.message}</span>)}
      </label>
      {defaultDeployment && <p className="settings-model-facts">{capabilitiesText(defaultDeployment, inventory)}</p>}
      <div className="settings-discovery"><span role="status">{discoveryText}</span>
        {discoveryAvailable && discovery.status !== 'loading' && <Button size="sm" icon={RefreshCw} disabled={disabled} onClick={onRefreshDeployments}>
          {discovery.status === 'error' ? 'Try again' : inventory ? 'Check Azure again' : 'Find deployments in Azure'}
        </Button>}
      </div>
      <div className="settings-model-coverage"><p>{coverage}</p>
        {ownModel.length > 0 && <Button size="sm" disabled={disabled} onClick={useDefaultEverywhere}>Use the default model for every task</Button>}
      </div>
      {attention.length > 0 && <div className="settings-attention" role="alert"><strong>Fix before saving</strong>
        <ul>{attention.map(item => <li key={item.task}>{taskNames[item.task]}: {item.issues.join('; ')}.</li>)}</ul>
        <p>Open the task below and choose a setting its model supports.</p>
      </div>}
      {modelChanged && <p className="settings-model-unsaved">Not saved yet. Choose <strong>Review and save</strong> at the top of the page, then <strong>Publish new revision</strong>, to use this for new work.</p>}
    </section>}
    {!search && tasks.length > 0 && <div className="settings-subheading"><h2>Model for each task</h2>
      <p>Each task uses the default model unless you choose another one. Open a task to change its model, reasoning, or limits.</p></div>}
    {tasks.map(task => {
      const binding = bindingOf(task)
      const deployment = deploymentFor(task)
      const issues = attention.find(item => item.task === task)?.issues ?? []
      const taskFields = fields.filter(field => field.path.startsWith(`ai.tasks.${task}.`) && !field.path.endsWith('.deploymentId'))
      if (!matches(`${taskNames[task]} ${task} ai.tasks.${task}.deploymentId ${taskFields.map(field => `${field.label} ${field.description} ${field.path}`).join(' ')}`)) return null
      return <details className="panel settings-section" key={task} open={Boolean(search) || issues.length > 0 || undefined}>
        <summary><strong>{taskNames[task]}</strong> <span className="settings-summary-detail text-muted">{nameFor(task)} · {binding.deploymentId === null ? 'default model' : 'chosen for this task'} · reasoning {binding.reasoningEffort ?? 'model default'}</span>
          {issues.length > 0 && <Badge tone="warning" dot>Needs attention</Badge>}</summary>
        <label className="field mt-4"><span className="field-label">{taskNames[task]} model</span>
          <select className="input" disabled={disabled} value={binding.deploymentId ?? ''} onChange={event => choose(`ai.tasks.${task}.deploymentId`, event.target.value)}>
            <option value="">Use the default model ({defaultDeployment ? titleOf(defaultDeployment) : defaultId})</option>
            {binding.deploymentId !== null && missing(binding.deploymentId)}
            {options}
          </select><span className="field-hint">Default: use the default model · <SettingsFieldProvenance field={metadata(`ai.tasks.${task}.deploymentId`)} changed={binding.deploymentId !== saved.ai.tasks[task]?.deploymentId} /> · Activation: new-operation. Model-default reasoning omits the parameter, rather than inheriting another task.</span>
          {errors.filter(error => error.path === `ai.tasks.${task}.deploymentId`).map((error, index) => <span role="alert" className="settings-error" key={index}>{error.message}</span>)}
        </label>
        <div className="settings-grid mt-4">{taskFields.map(field => {
          const parameter = field.path.split('.').at(-1)
          const supported = parameter === 'temperature' ? deployment?.capabilities.temperature : parameter === 'topP' ? deployment?.capabilities.topP : true
          const adjusted = parameter === 'reasoningEffort' ? { ...field, options: deployment?.capabilities.reasoningEfforts ?? [] }
            : parameter === 'completionTokenLimit' ? { ...field, max: Math.min(field.max ?? Infinity, deployment?.capabilities.maxOutputTokens ?? 0) } : field
          return <div key={field.path}>
            <SettingsField {...common} disabled={disabled || !supported} field={adjusted} />
            {parameter === 'reasoningEffort' && binding.reasoningEffort !== null && !deployment?.capabilities.reasoningEfforts.includes(binding.reasoningEffort) &&
              <p className="settings-error" role="alert">The retained effort “{binding.reasoningEffort}” is unsupported by this deployment. Choose a supported value or leave it unset.</p>}
            {!supported && <p className="field-hint">This deployment does not support {parameter}. Leave it unset.
              {(parameter === 'temperature' ? binding.temperature : binding.topP) !== null && <Button size="sm" disabled={disabled} onClick={() => onChange(field.path, null)}>Clear unsupported parameter</Button>}
            </p>}
          </div>
        })}</div>
      </details>
    })}
    {matches(`ai.deployments Azure deployments catalog Deployments Score can use ${names}`) && <section className="panel settings-section" aria-label="Deployments Score can use">
      <h2>Deployments Score can use</h2>
      <p>Score sends AI work only to the deployments listed here. Choosing one from “Also in your Azure resource” in a list above adds it, and removing one here doesn’t delete it from Azure.</p>
      <p className="field-hint"><SettingsFieldProvenance field={metadata('ai.deployments')} changed={JSON.stringify(deployments) !== JSON.stringify(saved.ai.deployments)} /></p>
      <ul className="settings-deployment-list">{deployments.map((deployment, index) => {
        const patch = (value: Partial<ModelDeployment>) => onChange('ai.deployments', deployments.map((item, at) => at === index ? { ...item, ...value } : item))
        const inUse = deployment.id === defaultId || tasks.some(task => bindingOf(task).deploymentId === deployment.id)
        const taskCount = tasks.filter(task => targetOf(task) === deployment.id).length
        const locked = deployments.length === 1 ? 'Score needs at least one deployment.' : inUse ? 'In use. Choose another model for the default and its tasks first.' : ''
        return <li className="settings-deployment" key={deployment.id} aria-label={`Deployment ${titleOf(deployment)}`}>
          <div className="settings-deployment-head"><h3>{titleOf(deployment)}</h3>
            {deployment.id === defaultId && <Badge tone="accent">Default model</Badge>}
            {taskCount > 0 && <Badge>{taskCount === 1 ? 'Used by 1 task' : `Used by ${taskCount} tasks`}</Badge>}
            {!deployment.capabilities.structuredOutputs && <Badge tone="warning" dot>Not supported by Score</Badge>}
            {!deployment.enabled && <Badge>Turned off</Badge>}
          </div>
          <dl className="settings-facts">
            <dt>Azure deployment</dt><dd><code>{deployment.deploymentName}</code></dd>
            <dt>Model</dt><dd>{capabilitiesText(deployment, inventory)}</dd>
            <dt>Listed from</dt><dd>{verificationText[deployment.verification]}{deployment.verifiedAt ? ` · ${deployment.verifiedAt}` : ''}</dd>
            <dt>Settings ID</dt><dd><code>{deployment.id}</code></dd>
          </dl>
          <div className="flex flex-wrap items-center gap-3">
            <label className={`check-label${inUse && deployment.enabled ? ' is-disabled' : ''}`}><input type="checkbox" disabled={disabled || (inUse && deployment.enabled)} checked={deployment.enabled} onChange={event => patch({ enabled: event.target.checked })} />Enabled for new work</label>
            <Button size="sm" disabled={disabled || Boolean(locked)} onClick={() => onChange('ai.deployments', deployments.filter((_, at) => at !== index))}>Remove from list</Button>
            {locked && <span className="field-hint">{locked}</span>}
          </div>
          <details className="settings-deployment-names"><summary>Rename or describe</summary>
            <div className="settings-grid">
              <label className="field"><span className="field-label">Display name</span><input className="input" maxLength={100} disabled={disabled} value={deployment.label} onChange={event => patch({ label: event.target.value })} /></label>
              <label className="field"><span className="field-label">Description</span><input className="input" maxLength={500} disabled={disabled} value={deployment.description} onChange={event => patch({ description: event.target.value })} /></label>
            </div>
          </details>
          {errors.filter(error => error.path.startsWith(`ai.deployments.${index}`)).map((error, at) => <p className="settings-error" role="alert" key={at}>{error.path}: {error.message}</p>)}
        </li>
      })}</ul>
      {elsewhere.length > 0 && <div className="settings-available"><h3>Also in your Azure resource</h3>
        <ul>
          {addable.map(item => <li key={item.deploymentName}><span><code>{item.deploymentName}</code> · {capabilitiesText(item, inventory)}</span>
            <Button size="sm" disabled={disabled} onClick={() => add(item)}>Add to list</Button></li>)}
          {blocked.map(item => <li key={item.deploymentName}><span><code>{item.deploymentName}</code> · {capabilitiesText(item, inventory)}</span>
            <span className="field-hint">{unavailableReason(item, false)}</span></li>)}
        </ul>
      </div>}
      {errors.filter(error => error.path === 'ai.deployments').map((error, index) => <p className="settings-error" role="alert" key={index}>{error.message}</p>)}
    </section>}
  </div>
}
