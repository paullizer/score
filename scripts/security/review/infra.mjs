import { privilegedRoleDefinitionIds } from '../policy/review.mjs'
import { REVIEW, addFinding } from './common.mjs'

function isInfra(file) {
  return file.startsWith('infra/') || file === 'azure.yaml' || /^scripts\/deploy/.test(file) || /^scripts\/.*\.(?:ps1|sh)$/.test(file)
}

export function checkInfra(ctx) {
  const findings = []
  for (const file of ctx.files.filter(item => isInfra(item.path))) {
    for (const { line, text } of file.addedLines) {
      const lower = text.toLowerCase()
      if (/unauthenticatedClientAction['"]?\s*:\s*['"]?AllowAnonymous/i.test(text) || /\bexcludedPaths\b/i.test(text)) addFinding(findings, { rule: 'review/infra-anonymous-auth', verdict: REVIEW, file: file.path, line, message: 'Infrastructure may allow anonymous Easy Auth access.', hint: 'Confirm anonymous paths are intentional and safe.' })
      if (/\bexternal\s*:\s*true\b/i.test(text) || /\ballowInsecure\s*:\s*true\b/i.test(text)) addFinding(findings, { rule: 'review/infra-public-ingress', verdict: REVIEW, file: file.path, line, message: 'Container ingress is public or allows insecure traffic.', hint: 'Confirm exposure and HTTPS requirements.' })
      if (/publicNetworkAccess['"]?\s*:\s*['"]Enabled['"]/i.test(text) || /allowBlobPublicAccess['"]?\s*:\s*true/i.test(text)) addFinding(findings, { rule: 'review/infra-public-network', verdict: REVIEW, file: file.path, line, message: 'Public network or blob access was enabled.', hint: 'Prefer private or least-exposed resources.' })
      if (/minimumTlsVersion['"]?\s*:\s*['"]?(?:1\.0|1\.1)/i.test(text) || /httpsOnly['"]?\s*:\s*false/i.test(text)) addFinding(findings, { rule: 'review/infra-weak-tls', verdict: REVIEW, file: file.path, line, message: 'Infrastructure weakens TLS or HTTPS-only settings.', hint: 'Require HTTPS and TLS 1.2 or later.' })
      if (/disableLocalAuth['"]?\s*:\s*false/i.test(text) || /allowSharedKeyAccess['"]?\s*:\s*true/i.test(text)) addFinding(findings, { rule: 'review/infra-local-auth', verdict: REVIEW, file: file.path, line, message: 'Local or shared-key authentication was enabled.', hint: 'Prefer managed identity and Entra ID authentication.' })
      if (/Microsoft\.Authorization\/roleAssignments/i.test(text)) {
        const role = privilegedRoleDefinitionIds.find(item => lower.includes(item.id))
        addFinding(findings, { rule: 'review/infra-role-assignment', verdict: REVIEW, file: file.path, line, message: role ? `Privileged Azure role assignment added: ${role.name}.` : 'Azure role assignment added.', hint: 'Confirm the principal, scope and least privilege.' })
      } else {
        const role = privilegedRoleDefinitionIds.find(item => lower.includes(item.id))
        if (role) addFinding(findings, { rule: 'review/infra-privileged-role', verdict: REVIEW, file: file.path, line, message: `Privileged Azure role definition referenced: ${role.name}.`, hint: 'Confirm least privilege.' })
      }
      if (/appRoleAssignments|oauth2PermissionGrants|RoleManagement/i.test(text)) addFinding(findings, { rule: 'review/infra-graph-permission', verdict: REVIEW, file: file.path, line, message: 'Microsoft Graph permission or role-management surface changed.', hint: 'Confirm consent and privilege scope.' })
      if (/\baz\s+group\s+delete\b|Remove-AzResourceGroup\b/i.test(text)) addFinding(findings, { rule: 'review/infra-resource-group-delete', verdict: REVIEW, file: file.path, line, message: 'Resource group deletion command was added.', hint: 'Guard destructive commands carefully.' })
    }
  }
  return findings
}
