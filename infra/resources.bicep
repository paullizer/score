param location string
param token string
param tags object
param authClientId string
param tenantId string
param allowedUserId string
param operatorPrincipalId string
param containerImage string
param workerImage string
param rendererImage string
param gradeWorkerImage string
param resumeWorkerImage string
param analysisWorkerImage string
@allowed(['false', 'true'])
param analysisEvidenceCorrectionsEnabled string = 'false'
param appServiceSku string
param searchSku string

var acrPullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var blobContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var keyVaultReaderRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var keyVaultOfficerRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-score-${token}'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'acrscore${token}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, runtimeIdentity.id, acrPullRole)
  scope: registry
  properties: {
    roleDefinitionId: acrPullRole
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stscore${token}'
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource stateContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'workspace-state'
  properties: { publicAccess: 'None' }
}

resource documentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'documents'
  properties: { publicAccess: 'None' }
}

resource knowledgeContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'knowledge'
  properties: { publicAccess: 'None' }
}

resource knowledgeOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(knowledgeContainer.id, operatorPrincipalId, blobContributorRole)
  scope: knowledgeContainer
  properties: {
    roleDefinitionId: blobContributorRole
    principalId: operatorPrincipalId
    principalType: 'User'
  }
}

resource storageAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, runtimeIdentity.id, blobContributorRole)
  scope: storage
  properties: {
    roleDefinitionId: blobContributorRole
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: 'cosmos-score-${token}'
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    minimalTlsVersion: 'Tls12'
    capabilities: [{ name: 'EnableServerless' }]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmos
  name: 'score'
  properties: { resource: { id: 'score' } }
}

resource directoryContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'workspaces'
  properties: {
    resource: {
      id: 'workspaces'
      partitionKey: { paths: ['/workspaceId'], kind: 'Hash', version: 2 }
      indexingPolicy: {
        automatic: true
        indexingMode: 'consistent'
        includedPaths: [{ path: '/*' }]
        excludedPaths: [{ path: '/"_etag"/?' }]
      }
    }
  }
}

resource cosmosAccess 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, runtimeIdentity.id, 'score-data-contributor')
  properties: {
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    principalId: runtimeIdentity.properties.principalId
    scope: cosmos.id
  }
  dependsOn: [directoryContainer]
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-score-${token}'
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: { name: 'standard', family: 'A' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    accessPolicies: []
  }
}

resource secretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, runtimeIdentity.id, keyVaultReaderRole)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultReaderRole
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource secretOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, operatorPrincipalId, keyVaultOfficerRole)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultOfficerRole
    principalId: operatorPrincipalId
    principalType: 'User'
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-score-${token}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-score-${token}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    IngestionMode: 'LogAnalytics'
  }
}

module ai 'ai.bicep' = {
  name: 'score-ai-foundation'
  params: {
    location: location
    token: token
    tags: tags
    searchSku: searchSku
    storageAccountId: storage.id
    knowledgeContainerId: knowledgeContainer.id
    appPrincipalId: runtimeIdentity.properties.principalId
    operatorPrincipalId: operatorPrincipalId
  }
}

module ingestion 'ingestion.bicep' = {
  name: 'score-job-ingestion'
  params: {
    location: location
    token: token
    tags: tags
    cosmosAccountName: cosmos.name
    storageAccountName: storage.name
    registryName: registry.name
    foundryAccountName: ai.outputs.accountName
    logWorkspaceId: logs.id
    tenantId: tenantId
    workerImage: workerImage
    rendererImage: rendererImage
  }
  dependsOn: [database]
}

module grades 'grades.bicep' = {
  name: 'score-grade-ladders'
  params: {
    location: location
    token: token
    tags: tags
    cosmosAccountName: cosmos.name
    storageAccountName: storage.name
    registryName: registry.name
    foundryAccountName: ai.outputs.accountName
    documentIntelligenceName: ingestion.outputs.documentIntelligenceName
    modelDeploymentName: ingestion.outputs.modelDeploymentName
    environmentId: ingestion.outputs.environmentId
    rendererUrl: ingestion.outputs.rendererUrl
    rendererDeployed: ingestion.outputs.rendererIsDeployed
    tenantId: tenantId
    workerImage: gradeWorkerImage
  }
}

module resumes 'private-processing.bicep' = {
  name: 'score-resume-imports'
  params: {
    location: location
    token: token
    tags: tags
    kind: 'resume'
    cosmosAccountName: cosmos.name
    storageAccountName: storage.name
    registryName: registry.name
    foundryAccountName: ai.outputs.accountName
    modelDeploymentName: ingestion.outputs.modelDeploymentName
    documentIntelligenceName: ingestion.outputs.documentIntelligenceName
    environmentId: ingestion.outputs.environmentId
    rendererUrl: ingestion.outputs.rendererUrl
    rendererDeployed: ingestion.outputs.rendererIsDeployed
    tenantId: tenantId
    workerImage: resumeWorkerImage
  }
}

module analyses 'private-processing.bicep' = {
  name: 'score-resume-analyses'
  params: {
    location: location
    token: token
    tags: tags
    kind: 'analysis'
    cosmosAccountName: cosmos.name
    storageAccountName: storage.name
    registryName: registry.name
    foundryAccountName: ai.outputs.accountName
    modelDeploymentName: ingestion.outputs.modelDeploymentName
    environmentId: ingestion.outputs.environmentId
    tenantId: tenantId
    workerImage: analysisWorkerImage
    analysisEvidenceCorrectionsEnabled: analysisEvidenceCorrectionsEnabled
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: 'asp-score-${token}'
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: appServiceSku
    tier: startsWith(appServiceSku, 'B') ? 'Basic' : 'Standard'
    capacity: 1
  }
  properties: { reserved: true }
}

resource web 'Microsoft.Web/sites@2024-11-01' = {
  name: 'app-score-${token}'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  kind: 'app,linux,container'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${runtimeIdentity.id}': {} }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    keyVaultReferenceIdentity: runtimeIdentity.id
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      linuxFxVersion: 'DOCKER|${containerImage}'
      acrUseManagedIdentityCreds: true
      acrUserManagedIdentityID: runtimeIdentity.properties.clientId
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/healthz'
    }
  }
  dependsOn: [registryPull, storageAccess, cosmosAccess, secretReader]
}

resource appSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: web
  name: 'appsettings'
  properties: {
    NODE_ENV: 'production'
    PORT: '8080'
    WEBSITES_PORT: '8080'
    WEBSITES_ENABLE_APP_SERVICE_STORAGE: 'false'
    WEBSITE_WARMUP_PATH: '/healthz'
    WEBSITE_WARMUP_STATUSES: '200'
    WEBSITE_HEALTHCHECK_MAXPINGFAILURES: '3'
    SCORE_AUTH_MODE: 'easyauth'
    AZURE_TENANT_ID: tenantId
    WEBSITE_AUTH_AAD_ALLOWED_TENANTS: tenantId
    SCORE_ALLOWED_USER_IDS: allowedUserId
    AZURE_CLIENT_ID: runtimeIdentity.properties.clientId
    COSMOS_ENDPOINT: cosmos.properties.documentEndpoint
    COSMOS_DATABASE: database.name
    COSMOS_CONTAINER: directoryContainer.name
    STORAGE_ACCOUNT_URL: storage.properties.primaryEndpoints.blob
    WORKSPACE_BLOB_CONTAINER: stateContainer.name
    REAL_JOB_IMPORTS_ENABLED: 'true'
    // Provisioning never infers Word readiness from saved image tags.
    WORD_DOCUMENT_IMPORTS_ENABLED: 'false'
    JOB_RECORDS_CONTAINER: 'job-records'
    JOB_SOURCE_CONTAINER: 'job-sources'
    REAL_GRADE_LADDERS_ENABLED: grades.outputs.isDeployed ? 'true' : 'false'
    GRADE_RECORDS_CONTAINER: 'grade-records'
    GRADE_SOURCE_CONTAINER: 'grade-sources'
    REAL_RESUME_IMPORTS_ENABLED: resumes.outputs.isDeployed ? 'true' : 'false'
    RESUME_RECORDS_CONTAINER: 'resume-records'
    RESUME_SOURCE_CONTAINER: 'resume-sources'
    REAL_ANALYSES_ENABLED: analyses.outputs.isDeployed ? 'true' : 'false'
    ANALYSIS_EVIDENCE_CORRECTIONS_ENABLED: analysisEvidenceCorrectionsEnabled
    ANALYSIS_RECORDS_CONTAINER: 'analysis-records'
    ANALYSIS_SOURCE_CONTAINER: 'analysis-sources'
    APP_ORIGIN: 'https://${web.properties.defaultHostName}'
    AZURE_AI_PROJECT_ENDPOINT: ai.outputs.projectEndpoint
    AZURE_AI_SEARCH_ENDPOINT: ai.outputs.searchEndpoint
    APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties.ConnectionString
    MICROSOFT_PROVIDER_AUTHENTICATION_SECRET: '@Microsoft.KeyVault(SecretUri=${vault.properties.vaultUri}secrets/easyauth-client-secret)'
  }
}

resource auth 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: web
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true, runtimeVersion: '~1' }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: ['/healthz']
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        login: { loginParameters: ['prompt=select_account'] }
        registration: {
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenantId}/v2.0'
          clientId: authClientId
          clientSecretSettingName: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
        }
        validation: {
          allowedAudiences: [authClientId, 'api://${authClientId}']
          defaultAuthorizationPolicy: {
            allowedPrincipals: { identities: [allowedUserId] }
          }
        }
      }
    }
    login: {
      tokenStore: { enabled: false }
      preserveUrlFragmentsForLogins: true
    }
    httpSettings: { requireHttps: true }
  }
  dependsOn: [appSettings]
}

resource slotSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: web
  name: 'slotConfigNames'
  properties: { appSettingNames: ['MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'] }
}

resource ftpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: web
  name: 'ftp'
  properties: { allow: false }
}

resource scmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-11-01' = {
  parent: web
  name: 'scm'
  properties: { allow: false }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'score-app-service'
  scope: web
  properties: {
    workspaceId: logs.id
    logs: [
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output appServiceName string = web.name
output appServiceUrl string = 'https://${web.properties.defaultHostName}'
output registryName string = registry.name
output registryEndpoint string = registry.properties.loginServer
output keyVaultName string = vault.name
output keyVaultEndpoint string = vault.properties.vaultUri
output identityClientId string = runtimeIdentity.properties.clientId
output identityPrincipalId string = runtimeIdentity.properties.principalId
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output cosmosAccountName string = cosmos.name
output storageAccountName string = storage.name
output storageEndpoint string = storage.properties.primaryEndpoints.blob
output aiAccountName string = ai.outputs.accountName
output aiProjectName string = ai.outputs.projectName
output aiProjectEndpoint string = ai.outputs.projectEndpoint
output searchName string = ai.outputs.searchName
output searchEndpoint string = ai.outputs.searchEndpoint
output logAnalyticsWorkspaceId string = logs.properties.customerId
output workerName string = ingestion.outputs.workerName
output workerId string = ingestion.outputs.workerId
output workerPrincipalId string = ingestion.outputs.workerPrincipalId
output documentIntelligenceName string = ingestion.outputs.documentIntelligenceName
output documentIntelligenceEndpoint string = ingestion.outputs.documentIntelligenceEndpoint
output modelDeploymentName string = ingestion.outputs.modelDeploymentName
output modelEndpoint string = ingestion.outputs.modelEndpoint
output rendererName string = ingestion.outputs.rendererName
output rendererId string = ingestion.outputs.rendererId
output rendererUrl string = ingestion.outputs.rendererUrl
output gradeWorkerName string = grades.outputs.workerName
output gradeWorkerId string = grades.outputs.workerId
output gradeWorkerPrincipalId string = grades.outputs.workerPrincipalId
output resumeWorkerName string = resumes.outputs.workerName
output resumeWorkerId string = resumes.outputs.workerId
output resumeWorkerPrincipalId string = resumes.outputs.workerPrincipalId
output analysisWorkerName string = analyses.outputs.workerName
output analysisWorkerId string = analyses.outputs.workerId
output analysisWorkerPrincipalId string = analyses.outputs.workerPrincipalId
