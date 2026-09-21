param location string
param token string
param tags object
param searchSku string
param storageAccountId string
param knowledgeContainerId string
param appPrincipalId string
param operatorPrincipalId string

var foundryUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')
var searchReaderRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '1407120a-92aa-4202-b7e9-c0e197c71c8f')
var searchContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7ca78c08-252a-4471-8644-bb5ff32d4ba0')
var searchDataContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8ebe5a00-799e-43f5-93ac-243d3dce84a7')
var blobReaderRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
var storageName = last(split(storageAccountId, '/'))
var blobEndpoint = 'https://${storageName}.blob.${environment().suffixes.storage}'

resource knowledgeContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  name: '${storageName}/default/${last(split(knowledgeContainerId, '/'))}'
}

resource search 'Microsoft.Search/searchServices@2026-03-01-preview' = {
  name: 'srch-score-${token}'
  location: location
  tags: tags
  sku: { name: searchSku }
  identity: { type: 'SystemAssigned' }
  properties: {
    replicaCount: 1
    partitionCount: 1
    hostingMode: 'Default'
    publicNetworkAccess: 'enabled'
    disableLocalAuth: true
    semanticSearch: 'free'
    knowledgeRetrieval: 'free'
  }
}

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: 'aif-score-${token}'
  location: location
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: 'aif-score-${token}'
    allowProjectManagement: true
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource deploymentReaderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'score-model-deployment-reader')
  properties: {
    roleName: 'Score deployment inventory ${token}'
    description: 'Read deployments in the assigned Score AI account without changing them or reading keys.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{
      actions: [
        'Microsoft.CognitiveServices/accounts/read'
        'Microsoft.CognitiveServices/accounts/deployments/read'
      ]
      notActions: []
      dataActions: []
      notDataActions: []
    }]
  }
}

resource deploymentReadAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, appPrincipalId, 'score-model-inventory')
  scope: account
  properties: {
    roleDefinitionId: deploymentReaderRole.id
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource modelProbeAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, appPrincipalId, 'score-model-probes')
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: account
  name: 'score'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'Score'
    description: 'Score demo foundation. Workspace data stays private; AI scoring remains simulated.'
  }
}

resource appFoundryAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(project.id, appPrincipalId, foundryUserRole)
  scope: project
  properties: { principalId: appPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: foundryUserRole }
}

resource userFoundryAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(project.id, operatorPrincipalId, foundryUserRole)
  scope: project
  properties: { principalId: operatorPrincipalId, principalType: 'User', roleDefinitionId: foundryUserRole }
}

resource appSearchAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, appPrincipalId, searchReaderRole)
  scope: search
  properties: { principalId: appPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: searchReaderRole }
}

resource projectSearchAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, project.id, searchReaderRole)
  scope: search
  properties: { principalId: project.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: searchReaderRole }
}

resource searchBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(knowledgeContainer.id, search.id, blobReaderRole)
  scope: knowledgeContainer
  properties: { principalId: search.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: blobReaderRole }
}

resource projectBlobAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(knowledgeContainer.id, project.id, blobReaderRole)
  scope: knowledgeContainer
  properties: { principalId: project.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: blobReaderRole }
}

resource operatorSearchAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, operatorPrincipalId, searchContributorRole)
  scope: search
  properties: { principalId: operatorPrincipalId, principalType: 'User', roleDefinitionId: searchContributorRole }
}

resource operatorSearchDataAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, operatorPrincipalId, searchDataContributorRole)
  scope: search
  properties: { principalId: operatorPrincipalId, principalType: 'User', roleDefinitionId: searchDataContributorRole }
}

resource searchConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-06-01' = {
  parent: project
  name: 'score-search'
  properties: {
    category: 'CognitiveSearch'
    target: 'https://${search.name}.search.windows.net'
    authType: 'AAD'
    useWorkspaceManagedIdentity: true
    metadata: { ApiType: 'Azure', ResourceId: search.id }
  }
  dependsOn: [projectSearchAccess]
}

resource blobConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-06-01' = {
  parent: project
  name: 'score-demo-knowledge'
  properties: {
    category: 'AzureBlob'
    target: '${blobEndpoint}/knowledge'
    authType: 'AAD'
    useWorkspaceManagedIdentity: true
    metadata: { ApiType: 'Azure', ResourceId: storageAccountId, AccountName: storageName, ContainerName: 'knowledge' }
  }
  dependsOn: [projectBlobAccess]
}

output accountName string = account.name
output accountResourceId string = account.id
output projectName string = project.name
output projectEndpoint string = 'https://${account.name}.services.ai.azure.com/api/projects/${project.name}'
output searchName string = search.name
output searchEndpoint string = 'https://${search.name}.search.windows.net'
