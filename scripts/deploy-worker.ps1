$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  $json = & node scripts\azure-worker.mjs context
  if ($LASTEXITCODE -ne 0) { throw 'Could not load the worker deployment context.' }
  $context = $json | ConvertFrom-Json
  & az acr build --registry $context.registry --subscription $context.subscription --image $context.rendererRelativeImage --file Dockerfile.renderer . --no-logs --query '{run:runId,status:status}' --output json
  if ($LASTEXITCODE -ne 0) { throw 'The isolated renderer image build failed. Existing images have not been changed.' }
  & az acr build --registry $context.registry --subscription $context.subscription --image $context.relativeImage --file Dockerfile.worker . --no-logs --query '{run:runId,status:status}' --output json
  if ($LASTEXITCODE -ne 0) { throw 'The remote worker image build failed. The previous worker image has not been changed.' }
  & node scripts\azure-worker.mjs configure $context.image $context.rendererImage
  if ($LASTEXITCODE -ne 0) { throw 'The shared worker image was built, but a worker configuration or initial execution failed. Unverified resume/analysis features remain disabled; inspect the error before retrying.' }
} finally {
  Pop-Location
}
