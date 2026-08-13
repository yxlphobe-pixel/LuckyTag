import { useEffect } from 'react'
import { Icon } from './Icon'

export interface ToastMessage {
  id: string
  tone: 'success' | 'error' | 'info'
  title: string
  message?: string
}

interface ToastRegionProps {
  toasts: ToastMessage[]
  onDismiss: (id: string) => void
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: string) => void }): React.JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.tone === 'error' ? 10_000 : 4200)
    return () => window.clearTimeout(timer)
  }, [onDismiss, toast.id, toast.tone])

  return (
    <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
      <span className="toast-icon"><Icon name={toast.tone === 'error' ? 'warning' : toast.tone === 'success' ? 'check' : 'sparkle'} size={17} /></span>
      <div><strong>{toast.title}</strong>{toast.message && <p>{toast.message}</p>}</div>
      <button aria-label="关闭通知" className="toast-close" onClick={() => onDismiss(toast.id)} type="button"><Icon name="close" size={14} /></button>
    </div>
  )
}

export function ToastRegion({ toasts, onDismiss }: ToastRegionProps): React.JSX.Element {
  return <div aria-live="polite" className="toast-region">{toasts.map((toast) => <ToastItem key={toast.id} onDismiss={onDismiss} toast={toast} />)}</div>
}
