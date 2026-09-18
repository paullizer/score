import path from 'node:path'
import express, { type Express } from 'express'

const API_PREFIX = /^\/api(\/|$)/

/**
 * Serves the built SPA from `dist/` with a correct static/SPA-fallback split:
 * - Hashed files under `dist/assets/` get long, immutable caching (safe: the filename changes
 *   whenever the content does).
 * - Any other GET request that isn't under `/api` falls back to `index.html`, so client-side
 *   routing works on a hard refresh of a deep link.
 * - `/api/*` is never matched here; an unmatched API route must reach its own JSON 404 handler
 *   (registered on the API router before this is mounted), never this HTML fallback.
 */
export function mountStaticSpa(app: Express, distDir: string): void {
  app.use(
    express.static(distDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.startsWith(path.join(distDir, 'assets') + path.sep)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
      },
    }),
  )

  app.get(/.*/, (req, res, next) => {
    if (API_PREFIX.test(req.path)) return next()
    res.sendFile('index.html', { root: distDir })
  })
}
