import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './app/App'
import { WorkspaceProvider } from './app/WorkspaceProvider'
import { ErrorBoundary } from './app/ErrorBoundary'
import './styles/globals.css'

const root = document.getElementById('root')
if (!root) throw new Error('Score could not find its application root.')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <WorkspaceProvider><App /></WorkspaceProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
)
