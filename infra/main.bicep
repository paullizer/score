targetScope = 'subscription'

@description('Azure Developer CLI environment name.')
@minLength(3)
@maxLength(32)
param environmentName string

@description('All regional resources remain in the explicitly selected Azure region.')
param location string = 'northcentralus'
param resourceGroupName string = 'rg-${environmentName}-ncus'
param authClientId string
param authServicePrincipalId string
param tenantId string
@description('Legacy ingress guard retained until an explicitly verified role-aware deployment is released.')
param allowedUserId string
@allowed(['guarded', 'roles'])
param admissionStage string = 'guarded'
param operatorPrincipalId string
param containerImage string
param workerImage string
param rendererImage string
param gradeWorkerImage string
param resumeWorkerImage string
param analysisWorkerImage string

@sealed()
type AdditionalModelDeployment = {
  @minLength(1)
  @maxLength(64)
  name: string
  @minLength(1)
  modelName: string
  @minLength(1)
  modelVersion: string
  sku: 'DataZoneStandard' | 'Standard'
  @minValue(1)
  capacity: int
  versionUpgradeOption: 'NoAutoUpgrade' | 'OnceCurrentVersionExpired' | 'OnceNewDefaultVersionAvailable'
}

@description('Additional model deployments in the existing Score AI account. Settings select these deployments but never provision them. Do not repeat the reserved job-rubric deployment.')
param additionalModelDeployments AdditionalModelDeployment[] = []

@allowed(['B1', 'B2', 'B3', 'S1'])
param appServiceSku string = 'B3'

@allowed(['basic', 'standard'])
param searchSku string = 'basic'

var tags = {
  'azd-env-name': environmentName
  application: 'score'
  repository: 'paullizer/score'
  purpose: 'authenticated-demo'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  name: 'score-resources'
  scope: resourceGroup
  params: {
    location: location
    token: uniqueString(subscription().id, environmentName)
    tags: tags
    authClientId: authClientId
    authServicePrincipalId: authServicePrincipalId
    tenantId: tenantId
    allowedUserId: allowedUserId
    admissionStage: admissionStage
    operatorPrincipalId: operatorPrincipalId
    containerImage: containerImage
    workerImage: workerImage
    rendererImage: rendererImage
    gradeWorkerImage: gradeWorkerImage
    resumeWorkerImage: resumeWorkerImage
    analysisWorkerImage: analysisWorkerImage
    additionalModelDeployments: additionalModelDeployments
    appServiceSku: appServiceSku
    searchSku: searchSku
  }
}

output AZURE_RESOURCE_GROUP string = resourceGroup.name
output AZURE_LOCATION string = location
output AZURE_APP_SERVICE_NAME string = resources.outputs.appServiceName
output AZURE_APP_SERVICE_URL string = resources.outputs.appServiceUrl
output AZURE_CONTAINER_REGISTRY_NAME string = resources.outputs.registryName
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.registryEndpoint
output AZURE_KEY_VAULT_NAME string = resources.outputs.keyVaultName
output AZURE_KEY_VAULT_ENDPOINT string = resources.outputs.keyVaultEndpoint
output AZURE_MANAGED_IDENTITY_CLIENT_ID string = resources.outputs.identityClientId
output AZURE_MANAGED_IDENTITY_PRINCIPAL_ID string = resources.outputs.identityPrincipalId
output AZURE_COSMOS_ENDPOINT string = resources.outputs.cosmosEndpoint
output AZURE_COSMOS_ACCOUNT_NAME string = resources.outputs.cosmosAccountName
output AZURE_STORAGE_ACCOUNT_NAME string = resources.outputs.storageAccountName
output AZURE_STORAGE_ACCOUNT_URL string = resources.outputs.storageEndpoint
output AZURE_AI_ACCOUNT_NAME string = resources.outputs.aiAccountName
output AZURE_AI_PROJECT_NAME string = resources.outputs.aiProjectName
output AZURE_AI_PROJECT_ENDPOINT string = resources.outputs.aiProjectEndpoint
output AZURE_AI_SEARCH_NAME string = resources.outputs.searchName
output AZURE_AI_SEARCH_ENDPOINT string = resources.outputs.searchEndpoint
output AZURE_LOG_ANALYTICS_WORKSPACE_ID string = resources.outputs.logAnalyticsWorkspaceId
output AZURE_JOB_WORKER_NAME string = resources.outputs.workerName
output AZURE_JOB_WORKER_ID string = resources.outputs.workerId
output AZURE_JOB_WORKER_PRINCIPAL_ID string = resources.outputs.workerPrincipalId
output AZURE_DOCUMENT_INTELLIGENCE_NAME string = resources.outputs.documentIntelligenceName
output AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT string = resources.outputs.documentIntelligenceEndpoint
output AZURE_RUBRIC_MODEL_DEPLOYMENT string = resources.outputs.modelDeploymentName
output AZURE_RUBRIC_MODEL_ENDPOINT string = resources.outputs.modelEndpoint
output AZURE_JOB_RENDERER_NAME string = resources.outputs.rendererName
output AZURE_JOB_RENDERER_ID string = resources.outputs.rendererId
output AZURE_JOB_RENDERER_URL string = resources.outputs.rendererUrl
output AZURE_GRADE_WORKER_NAME string = resources.outputs.gradeWorkerName
output AZURE_GRADE_WORKER_ID string = resources.outputs.gradeWorkerId
output AZURE_GRADE_WORKER_PRINCIPAL_ID string = resources.outputs.gradeWorkerPrincipalId
output AZURE_RESUME_WORKER_NAME string = resources.outputs.resumeWorkerName
output AZURE_RESUME_WORKER_ID string = resources.outputs.resumeWorkerId
output AZURE_RESUME_WORKER_PRINCIPAL_ID string = resources.outputs.resumeWorkerPrincipalId
output AZURE_ANALYSIS_WORKER_NAME string = resources.outputs.analysisWorkerName
output AZURE_ANALYSIS_WORKER_ID string = resources.outputs.analysisWorkerId
output AZURE_ANALYSIS_WORKER_PRINCIPAL_ID string = resources.outputs.analysisWorkerPrincipalId
