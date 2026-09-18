param(
  [ValidatePattern('^[a-z][a-z0-9-]{2,31}$')]
  [string]$EnvironmentName = 'score-demo',
  [string]$SubscriptionId = '9698dd71-9367-49c2-bede-fd0deecfad62',
  [ValidateSet('northcentralus')]
  [string]$Location = 'northcentralus',
  [string]$AllowedUser = 'paullizer@retroburn.cloud',
  [switch]$ProvisionOnly,
  [switch]$DeployOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($ProvisionOnly -and $DeployOnly) { throw 'Choose either ProvisionOnly or DeployOnly, not both.' }

function Invoke-Azure {
  param([string[]]$Arguments)
  $result = & az @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: az $($Arguments[0..([Math]::Min(2, $Arguments.Length - 1))] -join ' ')" }
  return $result
}

function Set-EnvironmentValue {
  param([string]$Name, [string]$Value)
  & azd env set $Name $Value --environment $EnvironmentName
  if ($LASTEXITCODE -ne 0) { throw "Could not save the azd setting $Name." }
}

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $subscription = (Invoke-Azure @('account', 'show', '--subscription', $SubscriptionId, '--output', 'json')) | ConvertFrom-Json
  if ($subscription.state -ne 'Enabled') { throw 'The selected Azure subscription is not enabled.' }
  $operator = (Invoke-Azure @('ad', 'signed-in-user', 'show', '--query', '{id:id,userPrincipalName:userPrincipalName}', '--output', 'json')) | ConvertFrom-Json
  $user = (Invoke-Azure @('ad', 'user', 'show', '--id', $AllowedUser, '--query', '{id:id,userPrincipalName:userPrincipalName}', '--output', 'json')) | ConvertFrom-Json
  $groupName = "rg-$EnvironmentName-ncus"
  $exists = (Invoke-Azure @('group', 'exists', '--subscription', $SubscriptionId, '--name', $groupName, '--output', 'tsv')).Trim()
  if ($exists -eq 'true') {
    $group = (Invoke-Azure @('group', 'show', '--subscription', $SubscriptionId, '--name', $groupName, '--output', 'json')) | ConvertFrom-Json
    if ($group.location -ne $Location -or !$group.tags -or $group.tags.repository -ne 'paullizer/score') {
      throw 'The resource-group name is already in use outside this Score deployment. It has not been modified.'
    }
  }
  $env:AZURE_ENV_NAME = $EnvironmentName
  $envDirectory = Join-Path (Join-Path $root '.azure') $EnvironmentName
  if (!(Test-Path -LiteralPath $envDirectory)) {
    & azd env new $EnvironmentName --subscription $SubscriptionId --location $Location --no-prompt
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the azd environment.' }
  } else {
    & azd env select $EnvironmentName
    if ($LASTEXITCODE -ne 0) { throw 'Could not select the azd environment.' }
    $existingSubscription = & azd env get-value AZURE_SUBSCRIPTION_ID --environment $EnvironmentName
    if ($LASTEXITCODE -ne 0 -or $existingSubscription.Trim() -ne $SubscriptionId) {
      throw 'The existing azd environment points to another subscription. Use a different environment rather than changing its target.'
    }
  }
  Set-EnvironmentValue 'AZURE_SUBSCRIPTION_ID' $SubscriptionId
  Set-EnvironmentValue 'AZURE_LOCATION' $Location
  Set-EnvironmentValue 'AZURE_RESOURCE_GROUP' $groupName
  Set-EnvironmentValue 'AZURE_TENANT_ID' $subscription.tenantId
  Set-EnvironmentValue 'AZURE_ALLOWED_USER_ID' $user.id
  Set-EnvironmentValue 'AZURE_PRINCIPAL_ID' $operator.id
  $image = & azd env get-value AZURE_CONTAINER_IMAGE --environment $EnvironmentName 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($image)) {
    Set-EnvironmentValue 'AZURE_CONTAINER_IMAGE' 'mcr.microsoft.com/azure-app-service/placeholder:latest'
  }
  $workerImage = & azd env get-value AZURE_WORKER_CONTAINER_IMAGE --environment $EnvironmentName 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($workerImage)) {
    Set-EnvironmentValue 'AZURE_WORKER_CONTAINER_IMAGE' 'mcr.microsoft.com/k8se/quickstart-jobs:latest'
  }
  $rendererImage = & azd env get-value AZURE_JOB_RENDERER_IMAGE --environment $EnvironmentName 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($rendererImage)) {
    Set-EnvironmentValue 'AZURE_JOB_RENDERER_IMAGE' 'mcr.microsoft.com/k8se/quickstart:latest'
  }
  $gradeWorkerImage = & azd env get-value AZURE_GRADE_WORKER_CONTAINER_IMAGE --environment $EnvironmentName 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gradeWorkerImage)) {
    Set-EnvironmentValue 'AZURE_GRADE_WORKER_CONTAINER_IMAGE' 'mcr.microsoft.com/k8se/quickstart-jobs:latest'
  }
  Write-Host "Deploying Score to $Location in subscription $SubscriptionId."
  Write-Host "Allowed application user: $($user.userPrincipalName). Job imports are real; resume scoring remains simulated."
  Write-Host 'Rubric model: GPT-5 mini, US Data Zone Standard, in the existing North Central US Foundry resource.'
  if (!$DeployOnly) {
    foreach ($provider in @('Microsoft.Web', 'Microsoft.ContainerRegistry', 'Microsoft.DocumentDB', 'Microsoft.Storage', 'Microsoft.KeyVault', 'Microsoft.ManagedIdentity', 'Microsoft.CognitiveServices', 'Microsoft.Search', 'Microsoft.OperationalInsights', 'Microsoft.Insights', 'Microsoft.App')) {
      $state = (Invoke-Azure @('provider', 'show', '--subscription', $SubscriptionId, '--namespace', $provider, '--query', 'registrationState', '--output', 'tsv')).Trim()
      if ($state -ne 'Registered') {
        Invoke-Azure @('provider', 'register', '--subscription', $SubscriptionId, '--namespace', $provider, '--wait', '--output', 'none')
      }
    }
    & azd provision --environment $EnvironmentName --no-prompt
    if ($LASTEXITCODE -ne 0) { throw 'Azure provisioning or post-provisioning configuration did not finish. Review the reported error and rerun this script.' }
  }
  if (!$ProvisionOnly) {
    & azd deploy web --environment $EnvironmentName --no-prompt
    if ($LASTEXITCODE -ne 0) { throw 'Container deployment or readiness did not finish. Review the reported error and retry with -DeployOnly.' }
  }
} finally {
  Pop-Location
}
