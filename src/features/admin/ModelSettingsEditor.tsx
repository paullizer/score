import type { AdminSettings, DeploymentInventory, SettingsFieldError, SettingsFieldMetadata } from '../../domain/admin-settings'
import { MODEL_TASK_IDS } from '../../domain/admin-settings-tasks'
import { Badge, Button } from '../../components/ui'
import { SettingsField, SettingsFieldProvenance } from './SettingsField'

const taskNames: Record<typeof MODEL_TASK_IDS[number], string> = {
  jobRubric: 'Job rubric extraction', resumeProfile: 'Resume profile extraction', gradeCompetencies: 'GS shared competency planning',
  gradeDraft: 'GS level draft', gradeReview: 'GS independent review', assessment: 'Candidate assessment',
  assessmentReview: 'Assessment grounding review', candidateSummary: 'Candidate summary', targetSummary: 'Job / grade overview',
  summaryReduction: 'Large-cohort summary reduction', summaryReview: 'Summary factual review', qcPlan: 'QC improvement planning',
}

export function ModelSettingsEditor({ settings, saved, defaults, fields, errors, onChange, inventory, disabled, search }: {
  settings: AdminSettings; saved: AdminSettings; defaults: AdminSettings; fields: SettingsFieldMetadata[]; errors: SettingsFieldError[]
  onChange: (path: string, value: unknown) => void; inventory: DeploymentInventory | null; disabled: boolean; search: string
}) {
  const deployments = settings.ai.deployments
  const compatible = deployments.filter(item => item.enabled && item.capabilities.structuredOutputs)
  const common = { settings, saved, defaults, errors, onChange, disabled }
  const matches = (value: string) => !search || value.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  return <div className="space-y-6">
    {matches(`ai.deployments ai.defaultDeploymentId Azure deployment catalog default model ${deployments.map(item => `${item.label} ${item.deploymentName} ${item.modelName}`).join(' ')}`) && <section className="panel settings-section" aria-label="Azure deployment catalog">
      <h2>Azure deployment catalog</h2>
      <p>One configured Azure resource. Catalog entries name existing deployments; this page never provisions capacity. Model capabilities and verification come from server inventory, not editable claims.</p>
      <p className="field-hint"><SettingsFieldProvenance field={fields.find(field => field.path === 'ai.deployments')} changed={JSON.stringify(deployments) !== JSON.stringify(saved.ai.deployments)} /></p>
      {deployments.map((deployment, index) => {
        const patch = (value: Partial<typeof deployment>) => onChange('ai.deployments', deployments.map((item, at) => at === index ? { ...item, ...value } : item))
        return <section className="settings-deployment" key={deployment.id} aria-label={`Deployment ${deployment.label}`}>
          <div className="flex flex-wrap items-center gap-2"><h3>{deployment.label || deployment.id}</h3><Badge>{deployment.verification}</Badge><Badge tone={deployment.capabilities.structuredOutputs ? 'success' : 'warning'}>{deployment.capabilities.structuredOutputs ? 'Structured outputs supported' : 'Not compatible'}</Badge></div>
          <dl className="settings-facts"><dt>Stable ID</dt><dd><code>{deployment.id}</code></dd><dt>Azure deployment name</dt><dd><code>{deployment.deploymentName}</code></dd>
            <dt>Model / version</dt><dd>{deployment.modelName} / {deployment.modelVersion ?? 'not reported'}</dd><dt>Context / output capacity</dt><dd>{deployment.capabilities.contextTokens.toLocaleString()} / {deployment.capabilities.maxOutputTokens.toLocaleString()} tokens</dd>
            <dt>Verification timestamp</dt><dd>{deployment.verifiedAt ?? 'No live verification recorded'}</dd></dl>
          <div className="settings-grid">
            <label className="field"><span className="field-label">Label: {deployment.id}</span><input className="input" maxLength={100} disabled={disabled} value={deployment.label} onChange={event => patch({ label: event.target.value })} /></label>
            <label className="field"><span className="field-label">Description: {deployment.id}</span><input className="input" maxLength={500} disabled={disabled} value={deployment.description} onChange={event => patch({ description: event.target.value })} /></label>
          </div>
          <div className="flex flex-wrap items-center gap-3"><label className="check-label"><input type="checkbox" disabled={disabled} checked={deployment.enabled} onChange={event => patch({ enabled: event.target.checked })} />Enabled for new work</label>
            <Button size="sm" disabled={disabled || deployments.length === 1} onClick={() => onChange('ai.deployments', deployments.filter((_, at) => at !== index))}>Remove from draft catalog</Button></div>
          {errors.filter(error => error.path.startsWith(`ai.deployments.${index}`)).map((error, at) => <p className="settings-error" role="alert" key={at}>{error.path}: {error.message}</p>)}
        </section>
      })}
      {inventory && <div className="space-y-2"><p>Inventory checked {inventory.checkedAt}. Adding an entry only edits this unsaved draft.</p>
        {inventory.deployments.filter(item => !deployments.some(existing => existing.deploymentName === item.deploymentName)).map(item => <div className="flex flex-wrap items-center gap-2" key={item.id}>
          <code>{item.deploymentName}</code><span>{item.modelName} · {item.capabilities.structuredOutputs ? 'compatible API family' : 'unsupported structured-output adapter'}</span>
          <Button size="sm" disabled={disabled} onClick={() => onChange('ai.deployments', [...deployments, { ...item, enabled: item.capabilities.structuredOutputs }])}>Add to draft catalog</Button>
        </div>)}
        {!inventory.deployments.length && <p>No deployments were returned by the inventory service. No model was created or substituted.</p>}
      </div>}
      <label className="field mt-4"><span className="field-label">Application default deployment</span>
        <select className="input" disabled={disabled} value={settings.ai.defaultDeploymentId} onChange={event => onChange('ai.defaultDeploymentId', event.target.value)}>
          {!compatible.some(item => item.id === settings.ai.defaultDeploymentId) && <option value={settings.ai.defaultDeploymentId}>Current selection unavailable: {settings.ai.defaultDeploymentId}</option>}
          {compatible.map(item => <option key={item.id} value={item.id}>{item.label} ({item.deploymentName})</option>)}
        </select><span className="field-hint">Default: {defaults.ai.defaultDeploymentId} · <SettingsFieldProvenance field={fields.find(field => field.path === 'ai.defaultDeploymentId')} changed={settings.ai.defaultDeploymentId !== saved.ai.defaultDeploymentId} /> · Scope: application · Activation: new-operation. Inherited choices are frozen for new work. No automatic model substitution.</span>
        {errors.filter(error => error.path === 'ai.defaultDeploymentId').map((error, index) => <span role="alert" className="settings-error" key={index}>{error.message}</span>)}
      </label>
    </section>}
    {MODEL_TASK_IDS.map(task => {
      const binding = settings.ai.tasks[task]
      if (!binding) return null
      const deployment = deployments.find(item => item.id === (binding.deploymentId ?? settings.ai.defaultDeploymentId))
      const taskFields = fields.filter(field => field.path.startsWith(`ai.tasks.${task}.`) && !field.path.endsWith('.deploymentId'))
      if (!matches(`${taskNames[task]} ${task} ai.tasks.${task}.deploymentId ${taskFields.map(field => `${field.label} ${field.description} ${field.path}`).join(' ')}`)) return null
      return <details className="panel settings-section" key={task} open={Boolean(search) || undefined}>
        <summary><strong>{taskNames[task]}</strong> <span className="text-muted">{binding.deploymentId === null ? 'Inherits default' : 'Task override'} · {deployment?.deploymentName ?? 'Unavailable deployment'}</span></summary>
        <label className="field mt-4"><span className="field-label">{taskNames[task]} deployment</span>
          <select className="input" disabled={disabled} value={binding.deploymentId ?? ''} onChange={event => onChange(`ai.tasks.${task}.deploymentId`, event.target.value || null)}>
            <option value="">Use application default ({settings.ai.defaultDeploymentId})</option>
            {binding.deploymentId && !compatible.some(item => item.id === binding.deploymentId) && <option value={binding.deploymentId}>Current selection unavailable: {binding.deploymentId}</option>}
            {compatible.map(item => <option value={item.id} key={item.id}>{item.label} ({item.deploymentName})</option>)}
          </select><span className="field-hint">Default: inherit application deployment · <SettingsFieldProvenance field={fields.find(field => field.path === `ai.tasks.${task}.deploymentId`)} changed={binding.deploymentId !== saved.ai.tasks[task]?.deploymentId} /> · Scope: application · Activation: new-operation. Model-default reasoning omits the parameter, rather than inheriting another task.</span>
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
  </div>
}
