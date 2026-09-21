param location string
param token string
param tags object
param cosmosAccountName string
param storageAccountName string
param registryName string
param foundryAccountName string
param documentIntelligenceName string
param modelDeploymentName string
param environmentId string
param rendererUrl string
param rendererDeployed bool
param tenantId string
param workerImage string

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = {
  name: cosmosAccountName
}
resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' existing = {
  parent: cosmos
  name: 'score'
}
resource records 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'grade-records'
  properties: {
    resource: {
      id: 'grade-records'
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
  name: 'grade-sources'
  properties: { publicAccess: 'None' }
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
}
resource extraction 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: documentIntelligenceName
}
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-grade-worker-${token}'
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
  name: guid(extraction.id, identity.id, extractionRole)
  scope: extraction
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: extractionRole }
}
resource dataAccess 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, identity.id, 'grade-records-data')
  properties: {
    principalId: identity.properties.principalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: '${cosmos.id}/dbs/score/colls/grade-records'
  }
  dependsOn: [records]
}

var deployed = startsWith(workerImage, '${registry.properties.loginServer}/score-worker:') && rendererDeployed
resource worker 'Microsoft.App/jobs@2024-03-01' = {
  name: 'job-score-grades-${token}'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: environmentId
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
        name: 'grade-worker'
        image: workerImage
        command: ['node']
        args: ['dist-worker/grade-worker.mjs']
        resources: { cpu: 1, memory: '2Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
          { name: 'AZURE_TENANT_ID', value: tenantId }
          { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
          { name: 'COSMOS_DATABASE', value: 'score' }
          { name: 'SCORE_SETTINGS_CONTAINER', value: 'application-settings' }
          { name: 'GRADE_RECORDS_CONTAINER', value: 'grade-records' }
          { name: 'STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
          { name: 'GRADE_SOURCE_CONTAINER', value: 'grade-sources' }
          { name: 'DOCUMENT_INTELLIGENCE_ENDPOINT', value: 'https://${extraction.name}.cognitiveservices.azure.com' }
          { name: 'RUBRIC_MODEL_ENDPOINT', value: 'https://${foundry.name}.openai.azure.com' }
          { name: 'RUBRIC_MODEL_DEPLOYMENT', value: modelDeploymentName }
          { name: 'RUBRIC_MODEL_NAME', value: 'gpt-5-mini' }
          { name: 'RUBRIC_MODEL_REASONING_EFFORT', value: 'low' }
          { name: 'GRADE_WORKER_MAX_ITEMS', value: '5' }
          { name: 'JOB_RENDERER_URL', value: rendererUrl }
        ]
      }]
    }
  }
  dependsOn: [sourceAccess, pullAccess, inferenceAccess, extractionAccess, dataAccess]
}

output workerName string = worker.name
output workerId string = worker.id
output workerPrincipalId string = identity.properties.principalId
output isDeployed bool = deployed
