import { setTimeout as delay } from 'node:timers/promises'
import { BlobServiceClient } from '@azure/storage-blob'
import { client, environment, identifier, request, required, setEnvironment } from './azure-common.mjs'

const apiVersion = '2026-04-01'
const sourceName = 'score-demo-guide'
const knowledgeBaseName = 'score-knowledge'
const guide = `Score application guide

Score imports real job PDFs and public job URLs into server-owned workspace job records.
A durable background worker extracts source text and creates a source-cited, versioned job rubric.
Job criteria distinguish required and preferred qualifications and include weights and 0-5 scoring guidance.
Analyses start only when explicitly requested. Missing evidence is not proof that a person lacks a skill.
The Azure application requires Microsoft Entra sign-in and stores workspace records privately.
Workspace access uses immutable tenant and object IDs, server-side membership checks, and ETag concurrency.
Real job originals and extracted text are stored in a separate private job-sources container.
Scanned PDFs use Document Intelligence OCR. Rubric generation uses Foundry with exact source-paragraph citations.
When enabled, the grade-ladder workflow derives separate GS grade drafts from a real job and selected reference sources.
OPM references are discovered by occupational series; agency PDFs or public URLs can supply additional context.
Grade expectations retain exact citations and require source support and reviewer approval. Unsupported grades remain incomplete drafts.
Qualification requirements are separate from weighted criteria. A saved grade rubric is not an official OPM classification or eligibility decision.
Grade records and captured references live in separate private grade-records and grade-sources stores, not shared knowledge retrieval.
Whole-site job discovery is not enabled.
This knowledge base contains only this general application guide. Private workspace state, resumes, job descriptions, and grade references are not indexed here.
Group workspace administration is a future feature, not enabled by this knowledge source.
`

async function withPropagationRetry(action) {
  for (let attempt = 0; attempt < 25; attempt++) {
    try { return await action() } catch (error) {
      if (!(error instanceof Error) || ![403, 429, 503].includes(error.statusCode) || attempt === 24) throw error
      if (attempt === 0) console.log('Waiting for the Search/Blob role assignments or service readiness...')
      await delay(10000)
    }
  }
  throw new Error('Knowledge service access did not become available.')
}

async function main() {
  const env = environment()
  const credential = client(env)
  const endpoint = required(env, 'AZURE_AI_SEARCH_ENDPOINT').replace(/\/$/, '')
  const subscription = identifier(required(env, 'AZURE_SUBSCRIPTION_ID'), 'Subscription')
  const storageName = required(env, 'AZURE_STORAGE_ACCOUNT_NAME')
  const resourceGroup = required(env, 'AZURE_RESOURCE_GROUP')
  const storageId = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageName}`
  const searchId = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.Search/searchServices/${required(env, 'AZURE_AI_SEARCH_NAME')}`
  await request(credential, 'https://management.azure.com', `https://management.azure.com${searchId}?api-version=2026-03-01-preview`,
    'PATCH', { properties: { knowledgeRetrieval: 'free' } })
  const blobs = new BlobServiceClient(required(env, 'AZURE_STORAGE_ACCOUNT_URL'), credential)
  const blob = blobs.getContainerClient('knowledge').getBlockBlobClient('score-demo-guide.txt')
  await withPropagationRetry(() => blob.uploadData(Buffer.from(guide), {
    blobHTTPHeaders: { blobContentType: 'text/plain; charset=utf-8' },
    metadata: { content: 'general-demo-guide', privateWorkspaceData: 'false' },
  }))
  const source = {
    name: sourceName,
    kind: 'azureBlob',
    azureBlobParameters: {
      connectionString: `ResourceId=${storageId}`,
      containerName: 'knowledge',
      ingestionParameters: { contentExtractionMode: 'minimal', disableImageVerbalization: true },
    },
  }
  await withPropagationRetry(() => request(credential, 'https://search.azure.com',
    `${endpoint}/knowledgesources/${sourceName}?api-version=${apiVersion}`, 'PUT', source))
  await withPropagationRetry(() => request(credential, 'https://search.azure.com',
    `${endpoint}/knowledgebases/${knowledgeBaseName}?api-version=${apiVersion}`, 'PUT', {
      name: knowledgeBaseName,
      knowledgeSources: [{ name: sourceName }],
    }))
  setEnvironment('AZURE_AI_KNOWLEDGE_BASE', knowledgeBaseName)
  setEnvironment('AZURE_AI_KNOWLEDGE_SOURCE', sourceName)
  setEnvironment('AZURE_AI_SEARCH_API_VERSION', apiVersion)
  console.log(`Foundry IQ guide source and base configured: ${knowledgeBaseName}. Private workspace and job-source content is not indexed.`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Knowledge-source configuration failed.')
  process.exitCode = 1
})
