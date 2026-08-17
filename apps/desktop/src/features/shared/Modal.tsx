// 手写 Modal 对话框（不用原生 confirm）
import { useEffect } from 'react'
import '../../styles/panels.css'

interface ModalProps {
  open: boolean
  title: string
  width?: number
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
}

export default function Modal({ open, title, width = 440, onClose, children, footer }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="pl-modal-backdrop fixed inset-0 z-[90] flex items-center justify-center p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="panel pl-modal-card max-h-[85vh] w-full overflow-hidden shadow-[var(--shadow-2)]" style={{ maxWidth: width }}>
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="text-sm font-medium">{title}</span>
          <button className="btn btn-ghost px-2 py-0.5 text-xs" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="max-h-[calc(85vh-96px)] overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-[var(--panel-soft)] px-4 py-3">{footer}</div>}
      </div>
    </div>
  )
}

interface ConfirmProps {
  open: boolean
  title: string
  confirmText?: string
  danger?: boolean
  busy?: boolean
  onClose: () => void
  onConfirm: () => void
  children: React.ReactNode
}

export function ConfirmModal({ open, title, confirmText = '确认', danger = false, busy, onClose, onConfirm, children }: ConfirmProps) {
  return (
    <Modal
      open={open}
      title={title}
      width={400}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? '处理中…' : confirmText}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  )
}
