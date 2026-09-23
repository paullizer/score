import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '../components/ui'

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Score encountered an unexpected rendering error.', error, info) }
  render() {
    if (this.state.error) return <main className="recovery-page"><div className="panel recovery-card">
      <AlertTriangle size={32} /><h1>This view could not be opened</h1>
      <p>{this.state.error.message}</p><p>Your saved workspace content is unaffected.</p>
      <Button variant="primary" onClick={() => window.location.assign('/')}>Return to workspace</Button>
    </div></main>
    return this.props.children
  }
}
