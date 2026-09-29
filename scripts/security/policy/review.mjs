export const allowedRegistries = [
  { prefix: 'https://registry.npmjs.org/', reason: 'The canonical public npm registry.' },
  { prefix: 'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/', reason: 'The 1ES public npm mirror serves the same public packages used by Score.' },
]

export const metadataEndpointAllowlist = [
  { file: 'worker/public-http.ts', reason: 'SSRF denylist implementation must name cloud metadata endpoints to block them.' },
  { file: 'renderer/request-policy.ts', reason: 'Renderer outbound-request policy must name cloud metadata endpoints to block them.' },
  { file: 'server/jobs/routes.ts', reason: 'Job import URL validation blocks metadata host names.' },
  { file: 'server/telemetry-spans.ts', reason: 'Telemetry classifier labels expected managed-identity metadata traffic.' },
]

export const binaryAssetAllowlist = [
  { glob: 'src/assets/report-fonts/**', reason: 'Bundled report fonts are static user-facing assets, not executable code.' },
  { glob: 'server-tests/fixtures/dist/assets/**', reason: 'Bundled build-output fixtures are inert test assets.' },
  { glob: 'public/**', reason: 'Public images and icons are static web assets.' },
  { glob: 'src/assets/**', reason: 'Application assets are static browser resources.' },
]

export const dataBlobAssetAllowlist = [
  { glob: 'src/assets/**', reason: 'Static asset fixtures may include embedded data URIs.' },
  { glob: 'public/**', reason: 'Public assets may include embedded data URIs.' },
]

export const reviewerContentExemptions = [
  { glob: 'scripts/security/policy/review.mjs', reason: 'The reviewer policy file must contain trigger strings and allowlists for tests and rules.' },
  { glob: 'scripts/security/review/**', reason: 'Reviewer rule modules must contain trigger strings they detect.' },
  { glob: 'scripts/security/malicious-pr-review.test.mjs', reason: 'Reviewer tests construct trigger strings and expected findings.' },
]

export const sensitiveFiles = [
  { file: 'server/auth.ts', reason: 'Authentication and principal parsing control access.' },
  { file: 'server/middleware.ts', reason: 'Middleware applies request security controls.' },
  { file: 'worker/public-http.ts', reason: 'Worker outbound HTTP policy prevents SSRF.' },
  { file: 'renderer/request-policy.ts', reason: 'Renderer outbound request policy prevents SSRF.' },
  { file: 'src/components/documents/docxPreviewSanitize.ts', reason: 'DOCX preview sanitizer is an XSS boundary.' },
  { file: 'src/components/documents/DocxPreview.tsx', reason: 'DOCX preview rendering is an XSS boundary.' },
]

export const agentSurfaceGlobs = [
  { glob: '.github/copilot-instructions.md', reason: 'Repository-level Copilot instructions affect agent behavior.' },
  { glob: '.github/instructions/**', reason: 'Instruction files affect agent behavior.' },
  { glob: '.github/prompts/**', reason: 'Prompt files affect agent behavior.' },
  { glob: '.github/agents/**', reason: 'Agent definitions affect tool behavior.' },
  { glob: '.github/chatmodes/**', reason: 'Chat modes affect agent behavior.' },
  { glob: 'AGENTS.md', reason: 'Agent instructions affect tool behavior.' },
  { glob: 'CLAUDE.md', reason: 'Agent instructions affect tool behavior.' },
  { glob: '.vscode/mcp.json', reason: 'MCP configuration can grant tools to agents.' },
  { glob: '.mcp.json', reason: 'MCP configuration can grant tools to agents.' },
]

export const guardrailGlobs = [
  { glob: 'scripts/security/**', reason: 'Security tooling changes should receive human review.' },
  { glob: '.github/workflows/**', reason: 'Workflow changes can alter CI security boundaries.' },
  { glob: '.github/dependabot.yml', reason: 'Dependabot policy changes affect supply-chain updates.' },
  { glob: 'eslint.config.js', reason: 'Lint policy changes can disable safety checks.' },
  { glob: 'tsconfig*.json', reason: 'TypeScript configuration changes can alter type safety.' },
]

export const privilegedRoleDefinitionIds = [
  { id: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635', name: 'Owner', reason: 'Owner grants full control over Azure resources.' },
  { id: 'b24988ac-6180-42a0-ab88-20f7382dd24c', name: 'Contributor', reason: 'Contributor can modify most Azure resources.' },
  { id: '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9', name: 'User Access Administrator', reason: 'User Access Administrator can grant access to Azure resources.' },
  { id: 'f58310d9-a9f6-439a-9e8d-f62e7b41a168', name: 'RBAC Administrator', reason: 'RBAC Administrator can manage Azure role assignments.' },
]
