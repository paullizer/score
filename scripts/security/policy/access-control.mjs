export const recognizedGuards = [
  { name: 'authorize', reason: 'Workspace-scoped route middleware checks read/write/manage access before the handler runs.' },
  { name: 'authorizePublication', reason: 'QC prompt publication requires a workspace reviewer context plus application-administrator access.' },
  { name: 'requireApplicationAdmin', reason: 'Application-administrator helper rejects non-admin principals.' },
  { name: 'requireOwner', reason: 'Workspace access helper requires owner/application-admin access before membership changes.' },
  { name: 'isApplicationAdmin', reason: 'Application-level routes branch on the validated Score.Admin designation.' },
  { name: 'getPrincipal', reason: 'Route consumes the authenticated principal; service-level membership checks behind this boundary are trusted by policy.' },
  { name: 'authorizeWorkspace', reason: 'WorkspaceRepository authorization checks workspace membership and requested access level.' },
  { name: 'authorizeWorkspaceMembership', reason: 'WorkspaceRepository authorization checks explicit workspace membership.' },
  { name: 'withWorkspaceMutation', reason: 'WorkspaceRepository mutation wrapper rechecks write/manage/member access before storage changes.' },
]

export const authenticatedOnlyRoutes = [
  { method: 'GET', path: '/api/features', reason: 'Feature flags are deployment/session metadata; the API auth middleware already requires an admitted identity.' },
  { method: 'GET', path: '/api/session', reason: 'Session bootstrap data is scoped to the authenticated principal and has no workspace parameter.' },
  { method: 'GET', path: '/api/session/identity', reason: 'Identity bootstrap data is scoped to the authenticated principal and has no workspace parameter.' },
  { method: 'GET', path: '/api/workspaces', reason: 'WorkspaceRepository.listWorkspaces scopes the result to the authenticated principal.' },
  { method: 'POST', path: '/api/workspaces', reason: 'Workspace creation is principal-scoped and additionally checked by CreationAccessService.' },
  { method: 'PATCH', path: '/api/workspaces/:id', reason: 'WorkspaceRepository.renameWorkspace validates owner/application-admin access for the target workspace.' },
  { method: 'GET', path: '/api/workspaces/:id/summary', reason: 'Workspace summary reads are authorized inside getWorkspaceCounts through the principal-scoped repository calls.' },
  { method: 'GET', path: '/api/workspaces/:id/lifecycle', reason: 'WorkspaceLifecycleService.impact authorizes access with the authenticated principal.' },
  { method: 'POST', path: '/api/workspaces/:id/lifecycle', reason: 'WorkspaceLifecycleService.change authorizes lifecycle mutation with the authenticated principal.' },
  { method: 'GET', path: '/api/workspaces/:id/state', reason: 'Retired compatibility endpoint returns 410 without storage access or workspace data.' },
  { method: 'PUT', path: '/api/workspaces/:id/state', reason: 'Retired compatibility endpoint returns 410 without storage access or workspace data.' },
]

export const publicRoutes = [
  { method: 'GET', path: '/healthz', reason: 'Anonymous health probe exposes only ready/unavailable status for App Service health checks.' },
]

export const directAppRouteAllowlist = [
  { file: 'server/static.ts', path: '<non-literal>', reason: 'mountStaticSpa registers the SPA fallback after app-level auth and explicitly skips /api paths.' },
]

export const principalHeaderAllowedFiles = [
  { file: 'server/auth.ts', reason: 'Principal header parsing and validation live here.' },
  { file: 'server/middleware.ts', reason: 'Auth middleware is the only request path that reads principal headers.' },
]

export const appWiringOrder = [
  { id: 'api-no-store', contains: 'api.use(noStore)', reason: 'API responses must disable caching before route handlers run.' },
  { id: 'api-auth', contains: "api.use(telemetryMiddleware('score.auth', createAuthMiddleware(config)))", reason: 'Every /api route must require a validated principal.' },
  { id: 'api-csrf', contains: "api.use(telemetryMiddleware('score.csrf', createCsrfMiddleware(config)))", reason: 'Mutating /api routes must reject cross-site requests before handlers run.' },
  { id: 'settings-context', contains: 'api.use(attachSettingsContext(config, deps.settings))', reason: 'Routes must observe the active settings revision after auth/CSRF.' },
  { id: 'settings-router', contains: 'api.use(createAdminSettingsRouter(config, deps.settings, deps.prompts))', reason: 'Admin settings routes are mounted before feature routers.' },
  { id: 'members-router', contains: 'api.use(createWorkspaceMembersRouter', reason: 'Reviewer access routes are part of the authenticated API surface.' },
  { id: 'qc-router', contains: 'api.use(createQcRouter', reason: 'QC routes are part of the authenticated API surface.' },
  { id: 'access-router', contains: 'api.use(createAccessRouter', reason: 'Access-management routes are part of the authenticated API surface.' },
  { id: 'features-route', contains: "api.get('/features'", reason: 'Feature discovery remains behind API auth and settings context.' },
  { id: 'jobs-router', contains: 'api.use(createRealJobsRouter', reason: 'Job routes mount after shared API controls.' },
  { id: 'grades-router', contains: 'api.use(createRealGradesRouter', reason: 'Grade routes mount after shared API controls.' },
  { id: 'resumes-router', contains: 'api.use(createRealResumesRouter', reason: 'Resume routes mount after shared API controls.' },
  { id: 'analyses-router', contains: 'api.use(createRealAnalysesRouter', reason: 'Analysis routes mount after shared API controls.' },
  { id: 'api-mount', contains: "app.use('/api', api)", reason: 'The completed API router must mount before the JSON 404 and SPA fallback.' },
  { id: 'api-404', contains: "app.use('/api', (_req, res) =>", reason: 'Unmatched API routes must return a JSON CloudApiError, not the SPA shell.' },
  { id: 'spa-auth', contains: "app.use(telemetryMiddleware('score.auth', createAuthMiddleware(config)))", reason: 'The SPA shell/static fallback also requires a validated principal.' },
  { id: 'spa-mount', contains: 'mountStaticSpa(app, distDir)', reason: 'Static SPA serving must happen only after API routing and app-level auth.' },
]

export const devHeaderGuard = {
  file: 'server/auth.ts',
  contains: "config.authMode !== 'dev-header' || config.isProduction || config.isAppService",
  reason: 'The development principal header must be unreachable in production or App Service.',
}

export const guardHelperFiles = [
  { file: 'server/auth.ts', exports: ['isApplicationAdmin'], reason: 'Application role helper changes affect every admin-gated route.' },
  { file: 'server/request-context.ts', exports: ['getPrincipal'], reason: 'Principal extraction changes affect every authenticated route.' },
  { file: 'server/jobs/routes.ts', exports: ['authorize'], reason: 'Job workspace authorization middleware is local to this router.' },
  { file: 'server/access/service.ts', exports: ['requireApplicationAdmin', 'requireOwner'], reason: 'Access-management helpers gate application-admin and owner actions.' },
]
