import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './app/App'
import { WorkspaceProvider } from './app/WorkspaceProvider'
import { CloudApplication } from './app/CloudApplication'
import { ErrorBoundary } from './app/ErrorBoundary'
import { CLOUD_MODE } from './services/cloudWorkspace'
import './styles/globals.css'

const root = document.getElementById('root')
if (!root) throw new Error('Score could not find its application root.')

// VITE_DEPLOYMENT_MODE=cloud (set by the Docker/Azure build) switches to the real Easy
// Auth-backed, Azure-saved workspace experience. Anything else (including local `npm run dev`)
// keeps the original standalone browser demo exactly as it was, with its own BrowserRouter.
const appTree = CLOUD_MODE
  ? <CloudApplication />
  : <BrowserRouter><WorkspaceProvider><App /></WorkspaceProvider></BrowserRouter>

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>{appTree}</ErrorBoundary>
  </React.StrictMode>,
)
