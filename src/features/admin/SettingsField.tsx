import { useId } from 'react'
import type { AdminSettings, HostRule, SettingsFieldError, SettingsFieldMetadata } from '../../domain/admin-settings'
import { Button } from '../../components/ui'
import { describeSettingValue, settingValue } from './settingsForm'
import { workspaceRoleLabel } from '../../domain/access'
import { isWorkspaceRole } from '../../domain/workspace-permissions'

const optionLabel = (option: string | number) => isWorkspaceRole(option)
  ? workspaceRoleLabel(option) : option === 'owner-and-editor' ? 'Owners and Editors' : option

export function SettingsFieldProvenance({ field, changed }: { field?: SettingsFieldMetadata; changed: boolean }) {
  return <>Default source: {field?.defaultSource ?? 'Not reported'} · Source: {changed ? 'Unsaved draft' : field?.source ?? 'Not reported'}</>
}

export function SettingsField({ field, settings, saved, defaults, errors, onChange, disabled = false }: {
  field: SettingsFieldMetadata; settings: AdminSettings; saved: AdminSettings; defaults: AdminSettings
  errors: SettingsFieldError[]; onChange: (path: string, value: unknown) => void; disabled?: boolean
}) {
  const id = useId()
  const value = settingValue(settings, field.path)
  const defaultValue = settingValue(defaults, field.path)
  const fieldErrors = errors.filter(error => error.path === field.path || error.path.startsWith(`${field.path}.`))
  const common = { id, 'aria-describedby': `${id}-help`, 'aria-invalid': fieldErrors.length ? true as const : undefined, disabled: disabled || field.classification === 'read-only' }
  const changed = JSON.stringify(value) !== JSON.stringify(settingValue(saved, field.path))
  const nullable = field.path.endsWith('.temperature') || field.path.endsWith('.topP') || field.path.endsWith('.reasoningEffort') || field.path.endsWith('.deploymentId') || field.path === 'reports.defaultFormat'
  const byteDisplay = field.units?.startsWith('bytes') && !field.path.includes('inputBudget')
  let options = field.options ?? []
  if (field.path === 'reports.defaultFormat') options = settings.reports.enabledFormats
  const control = field.control === 'boolean' ? <input {...common} type="checkbox" checked={value === true} onChange={event => onChange(field.path, event.target.checked)} />
    : field.control === 'number' ? <input {...common} className="input" type="number"
      min={byteDisplay && field.min !== undefined ? field.min / (1024 * 1024) : field.min}
      max={byteDisplay && field.max !== undefined ? field.max / (1024 * 1024) : field.max}
      step={byteDisplay || field.path.endsWith('.temperature') || field.path.endsWith('.topP') ? 'any' : 1}
      value={value === null || value === undefined ? '' : byteDisplay ? Number(value) / (1024 * 1024) : String(value)}
      placeholder={nullable ? 'Model default (omitted)' : undefined}
      onChange={event => onChange(field.path, event.target.value === '' ? nullable ? null : '' : Number(event.target.value) * (byteDisplay ? 1024 * 1024 : 1))} />
    : field.control === 'select' ? <select {...common} className="input" value={value === null ? '' : String(value)} onChange={event => onChange(field.path, event.target.value === '' && nullable ? null : event.target.value)}>
      {nullable && <option value="">Not set</option>}
      {field.classification === 'read-only' && !options.length && <option value={String(value)}>{String(value)}</option>}
      {options.map(option => <option key={option} value={option}>{optionLabel(option)}</option>)}
    </select>
    : field.control === 'multiselect' || field.control === 'levels' ? <div id={id} className="grade-checks" role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`}>
      {(field.control === 'levels' ? Array.from({ length: 15 }, (_, index) => index + 1) : options).map(option =>
        <label className="check-label" key={option}><input type="checkbox" disabled={disabled}
          checked={Array.isArray(value) && value.includes(option)} onChange={() => {
            const values = Array.isArray(value) ? value : []
            onChange(field.path, values.includes(option) ? values.filter(item => item !== option) : [...values, option])
          }} />{field.control === 'levels' ? `GS-${option}` : optionLabel(option)}</label>)}
    </div>
    : field.control === 'host-rules' ? <div id={id} className="space-y-2" role="group" aria-labelledby={`${id}-label`}>
      {(value as HostRule[]).map((rule, index, rules) => <div className="settings-host-row" key={index}>
        <input className="input" aria-label={`${field.label} hostname ${index + 1}`} disabled={disabled} value={rule.hostname} placeholder="agency.example"
          onChange={event => onChange(field.path, rules.map((item, at) => at === index ? { ...item, hostname: event.target.value } : item))} />
        <label className="check-label"><input type="checkbox" disabled={disabled} checked={rule.includeSubdomains}
          onChange={event => onChange(field.path, rules.map((item, at) => at === index ? { ...item, includeSubdomains: event.target.checked } : item))} />Include subdomains</label>
        <Button size="sm" disabled={disabled} aria-label={`Remove ${field.label} host ${index + 1}`} onClick={() => onChange(field.path, rules.filter((_, at) => at !== index))}>Remove</Button>
      </div>)}
      <Button size="sm" disabled={disabled || (value as HostRule[]).length >= 100} onClick={() => onChange(field.path, [...value as HostRule[], { hostname: '', includeSubdomains: false }])}>Add hostname</Button>
    </div>
    : <textarea {...common} className="input" rows={field.max && field.max > 500 ? 3 : 1} value={String(value ?? '')} maxLength={field.max}
      onChange={event => onChange(field.path, event.target.value)} />
  return <div className={`settings-field ${changed ? 'is-changed' : ''}`}>
    <label className="field-label" id={`${id}-label`} htmlFor={id}>{field.label}{changed && <span className="text-accent"> · changed</span>}</label>
    {control}
    <div id={`${id}-help`} className="field-hint space-y-1">
      <p>{field.description}</p>
      <p><strong>{byteDisplay ? 'MiB (stored as bytes)' : field.units}</strong>{field.min !== undefined && ` · minimum ${byteDisplay ? field.min / (1024 * 1024) : field.min}`}{field.max !== undefined && ` · maximum ${byteDisplay ? field.max / (1024 * 1024) : field.max}`}</p>
      <p>Default: <span className="settings-value">{describeSettingValue(field.path, defaultValue)}</span> · <SettingsFieldProvenance field={field} changed={changed} /> · Scope: {field.scope} · Activation: {field.activation}</p>
      {field.prerequisites.length > 0 && <p>Prerequisites: {field.prerequisites.join('; ')}</p>}
      <code>{field.path}</code>
    </div>
    {fieldErrors.map((error, index) => <p key={index} role="alert" className="settings-error">{error.message}</p>)}
    {field.classification !== 'read-only' && <Button size="sm" variant="ghost" disabled={disabled || JSON.stringify(value) === JSON.stringify(defaultValue)}
      onClick={() => onChange(field.path, structuredClone(defaultValue))}>Use default</Button>}
  </div>
}
