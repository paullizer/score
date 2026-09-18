import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../dist-server/app.mjs'
import { ALLOWED_OID, APP_ORIGIN, TENANT_ID } from './helpers.mjs'

const environment = {
  SCORE_ALLOWED_USER_IDS: ALLOWED_OID, AZURE_TENANT_ID: TENANT_ID,
  COSMOS_ENDPOINT: 'https://cosmos.example.test', STORAGE_ACCOUNT_URL: 'https://storage.example.test',
  APP_ORIGIN, REAL_JOB_IMPORTS_ENABLED: 'false', REAL_GRADE_LADDERS_ENABLED: 'false',
  JOB_RECORDS_CONTAINER: 'job-records', JOB_SOURCE_CONTAINER: 'job-sources',
  GRADE_RECORDS_CONTAINER: 'grade-records', GRADE_SOURCE_CONTAINER: 'grade-sources',
  REAL_RESUME_IMPORTS_ENABLED: 'false', REAL_ANALYSES_ENABLED: 'false',
  RESUME_RECORDS_CONTAINER: 'resume-records', RESUME_SOURCE_CONTAINER: 'resume-sources',
  ANALYSIS_RECORDS_CONTAINER: 'analysis-records', ANALYSIS_SOURCE_CONTAINER: 'analysis-sources',
}

test('disabled processing features retain configured stores for authorized lifecycle cleanup', () => {
  const config = loadConfig(environment)
  assert.equal(config.realJobs, undefined)
  assert.equal(config.realGrades, undefined)
  assert.equal(config.jobLifecycleStore.container, 'job-records')
  assert.equal(config.gradeLifecycleStore.blobContainer, 'grade-sources')
  assert.equal(config.realResumes, undefined)
  assert.equal(config.realAnalyses, undefined)
  assert.equal(config.resumeLifecycleStore.container, 'resume-records')
  assert.equal(config.analysisLifecycleStore.blobContainer, 'analysis-sources')
})

test('disabled feature lifecycle stores cannot alias workspace or each other', () => {
  assert.throws(() => loadConfig({ ...environment, JOB_SOURCE_CONTAINER: 'workspace-state' }), /separate/)
  assert.throws(() => loadConfig({ ...environment, GRADE_RECORDS_CONTAINER: 'job-records' }), /separate/)
  assert.throws(() => loadConfig({ ...environment, GRADE_SOURCE_CONTAINER: 'job-sources' }), /separate/)
  assert.throws(() => loadConfig({ ...environment, RESUME_RECORDS_CONTAINER: 'analysis-records' }), /separate/)
  assert.throws(() => loadConfig({ ...environment, ANALYSIS_SOURCE_CONTAINER: 'workspace-state' }), /separate/)
})
