import React from 'react'
import ReactDOM from 'react-dom/client'
import { CloudApplication } from './app/CloudApplication'
import { ErrorBoundary } from './app/ErrorBoundary'
import './styles/globals.css'

const root = document.getElementById('root')
if (!root) throw new Error('Score could not find its application root.')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary><CloudApplication /></ErrorBoundary>
  </React.StrictMode>,
)