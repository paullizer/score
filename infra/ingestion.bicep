param location string
param token string
param tags object
param cosmosAccountName string
param storageAccountName string
param registryName string
param foundryAccountName string
param logWorkspaceId string
param tenantId string
param workerImage string
param rendererImage string

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = {
  name: cosmosAccountName
}
resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' existing = {
  parent: cosmos
  name: 'score'
}
resource jobRecords 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'job-records'
  properties: {
    resource: {
      id: 'job-records'
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
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource sources 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'job-sources'
  properties: { publicAccess: 'None' }
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
}

@description('Pay-as-you-go US data-zone inference; the deployment remains in the North Central US Foundry account.')
resource model 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundry
  name: 'job-rubric'
  sku: { name: 'DataZoneStandard', capacity: 100 }
  properties: {
    model: { format: 'OpenAI', name: 'gpt-5-mini', version: '2025-08-07' }
    raiPolicyName: 'Microsoft.DefaultV2'
    versionUpgradeOption: 'OnceCurrentVersionExpired'
  }
}

resource documentIntelligence 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: 'doc-score-${token}'
  location: location
  tags: tags
  kind: 'FormRecognizer'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: 'doc-score-${token}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-job-worker-${token}'
  location: location
  tags: tags
}
var blobRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var pullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var openAiRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
var extractionRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a97b65f3-24c7-4388-baec-2e87135dc908')

resource sourceAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sources.id, identity.id, blobRole)
  scope: sources
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: blobRole }
}
resource pullAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, pullRole)
  scope: registry
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: pullRole }
}
resource inferenceAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, identity.id, openAiRole)
  scope: foundry
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: openAiRole }
}
resource extractionAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(documentIntelligence.id, identity.id, extractionRole)
  scope: documentIntelligence
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: extractionRole }
}
resource jobDataAccess 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, identity.id, 'job-records-data')
  properties: {
    principalId: identity.properties.principalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: '${cosmos.id}/dbs/score/colls/job-records'
  }
  dependsOn: [jobRecords]
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-score-${token}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: { destination: 'azure-monitor' }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    zoneRedundant: false
  }
}
resource environmentLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'score-worker-logs'
  scope: environment
  properties: {
    workspaceId: logWorkspaceId
    logAnalyticsDestinationType: 'Dedicated'
    logs: [{ category: 'ContainerAppConsoleLogs', enabled: true }, { category: 'ContainerAppSystemLogs', enabled: true }]
  }
}

resource rendererPullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-render-pull-${token}'
  location: location
  tags: tags
}
resource rendererPullAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, rendererPullIdentity.id, pullRole)
  scope: registry
  properties: { principalId: rendererPullIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: pullRole }
}
var rendererDeployed = startsWith(rendererImage, '${registry.properties.loginServer}/')
resource renderer 'Microsoft.App/containerApps@2025-07-01' = {
  name: 'render-score-${token}'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${rendererPullIdentity.id}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registry.properties.loginServer, identity: rendererPullIdentity.id }]
      identitySettings: [{ identity: rendererPullIdentity.id, lifecycle: 'None' }]
      ingress: {
        external: false
        targetPort: rendererDeployed ? 8080 : 80
        transport: 'auto'
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
      }
    }
    template: {
      containers: [{
        name: 'renderer'
        image: rendererImage
        resources: { cpu: 1, memory: '2Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'PORT', value: '8080' }
          { name: 'RENDERER_PULL_CLIENT_ID', value: rendererPullIdentity.properties.clientId }
        ]
      }]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '1' } } }]
      }
    }
  }
  dependsOn: [rendererPullAccess]
}

var deployed = startsWith(workerImage, '${registry.properties.loginServer}/') && rendererDeployed
resource worker 'Microsoft.App/jobs@2024-03-01' = {
  name: 'job-score-import-${token}'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: union({
      triggerType: deployed ? 'Schedule' : 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 0
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
    }, deployed ? {
      scheduleTriggerConfig: { cronExpression: '* * * * *', parallelism: 1, replicaCompletionCount: 1 }
    } : {
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
    })
    template: {
      containers: [{
        name: 'worker'
        image: workerImage
        resources: { cpu: 1, memory: '2Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
          { name: 'AZURE_TENANT_ID', value: tenantId }
          { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
          { name: 'COSMOS_DATABASE', value: 'score' }
          { name: 'JOB_RECORDS_CONTAINER', value: 'job-records' }
          { name: 'STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
          { name: 'JOB_SOURCE_CONTAINER', value: 'job-sources' }
          { name: 'DOCUMENT_INTELLIGENCE_ENDPOINT', value: 'https://${documentIntelligence.name}.cognitiveservices.azure.com' }
          { name: 'RUBRIC_MODEL_ENDPOINT', value: 'https://${foundry.name}.openai.azure.com' }
          { name: 'RUBRIC_MODEL_DEPLOYMENT', value: model.name }
          { name: 'RUBRIC_MODEL_NAME', value: 'gpt-5-mini' }
          { name: 'RUBRIC_MODEL_REASONING_EFFORT', value: 'low' }
          { name: 'WORKER_MAX_JOBS', value: '5' }
          { name: 'JOB_RENDERER_URL', value: 'https://${renderer.properties.configuration.ingress.fqdn}' }
        ]
      }]
    }
  }
  dependsOn: [sourceAccess, pullAccess, inferenceAccess, extractionAccess, jobDataAccess]
}

output workerName string = worker.name
output workerId string = worker.id
output workerIdentityId string = identity.id
output workerPrincipalId string = identity.properties.principalId
output documentIntelligenceName string = documentIntelligence.name
output documentIntelligenceEndpoint string = 'https://${documentIntelligence.name}.cognitiveservices.azure.com'
output modelDeploymentName string = model.name
output modelEndpoint string = 'https://${foundry.name}.openai.azure.com'
output rendererName string = renderer.name
output rendererId string = renderer.id
output rendererUrl string = 'https://${renderer.properties.configuration.ingress.fqdn}'
output environmentId string = environment.id
output rendererIsDeployed bool = rendererDeployed
