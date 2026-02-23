import { cn } from '@/lib/cn'

type ToastTone = 'success' | 'warning' | 'error'

type ToastProps = {
  tone: ToastTone
  message: string
  onClose: () => void
}

const TOAST_ICON_BY_TONE: Record<ToastTone, string> = {
  success: 'OK',
  warning: '!',
  error: 'X',
}

export function Toast({ tone, message, onClose }: ToastProps) {
  return (
    <aside
      className={cn('oc-toast', `oc-toast--${tone}`)}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="oc-toast-icon" aria-hidden="true">
        {TOAST_ICON_BY_TONE[tone]}
      </span>
      <p className="oc-toast-message">{message}</p>
      <button type="button" className="oc-toast-close" onClick={onClose} aria-label="Dismiss notification">
        ×
      </button>
    </aside>
  )
}
