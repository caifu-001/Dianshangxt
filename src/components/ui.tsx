import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ButtonHTMLAttributes, ChangeEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  Search,
  X,
  XCircle,
} from 'lucide-react'
import { cn } from '../lib/utils'

/* ------------------------------------------------------------------ */
/*  Badge                                                              */
/* ------------------------------------------------------------------ */
type Tone = 'gray' | 'blue' | 'green' | 'red' | 'amber' | 'violet'

const TONE_CLASS: Record<Tone, string> = {
  gray: 'bg-ink-100 text-ink-600 border-ink-200/60',
  blue: 'bg-blue-50 text-blue-700 border-blue-200/60',
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200/60',
  red: 'bg-rose-50 text-rose-700 border-rose-200/60',
  amber: 'bg-amber-50 text-amber-700 border-amber-200/60',
  violet: 'bg-violet-50 text-violet-700 border-violet-200/60',
}

export function Badge({
  children,
  tone = 'gray',
  dot = false,
  className,
}: {
  children: ReactNode
  tone?: Tone
  dot?: boolean
  className?: string
}) {
  return (
    <span className={cn('chip', TONE_CLASS[tone], className)}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/*  Button                                                             */
/* ------------------------------------------------------------------ */
type ButtonProps = {
  variant?: 'primary' | 'default' | 'ghost' | 'danger'
  size?: 'md' | 'sm'
  loading?: boolean
  icon?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>

export function Button({
  variant = 'default',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn('btn', size === 'md' ? 'btn-md' : 'btn-sm', `btn-${variant}`, className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Form fields                                                        */
/* ------------------------------------------------------------------ */
export function Field({
  label,
  hint,
  required,
  children,
  className,
}: {
  label?: string
  hint?: string
  required?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      {label && (
        <label className="label">
          {label}
          {required && <span className="text-rose-500 ml-0.5">*</span>}
        </label>
      )}
      {children}
      {hint && <p className="mt-1 text-[11px] text-ink-400">{hint}</p>}
    </div>
  )
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  className,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  return (
    <div className={cn('relative', className)}>
      <select
        className="input appearance-none pr-8 cursor-pointer disabled:bg-ink-50 disabled:cursor-not-allowed"
        value={value}
        disabled={disabled}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="m6 8 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder = '搜索…',
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400" />
      <input
        className="input pl-9"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-ink-400 hover:text-ink-700 hover:bg-ink-100"
          onClick={() => onChange('')}
          aria-label="清空"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}

export function Segmented({
  value,
  onChange,
  options,
  size = 'md',
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
  size?: 'md' | 'sm'
}) {
  return (
    <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-ink-100 border border-ink-200/60">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md font-medium transition-all',
            size === 'md' ? 'h-7 px-3 text-xs' : 'h-6 px-2 text-[11px]',
            value === o.value
              ? 'bg-white text-ink-900 shadow-sm'
              : 'text-ink-500 hover:text-ink-700',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Modal                                                              */
/* ------------------------------------------------------------------ */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  width?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center sm:items-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-ink-900/35 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className={cn(
          'relative w-full bg-white rounded-xl shadow-pop border border-ink-200/70 animate-scale-in',
          'max-h-[90vh] flex flex-col',
          width,
        )}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-ink-100">
          <div>
            <h3 className="text-[15px] font-semibold text-ink-900">{title}</h3>
            {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 -mr-1 rounded-lg text-ink-400 hover:text-ink-700 hover:bg-ink-100 transition-colors"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-ink-100 bg-ink-50/50 rounded-b-xl">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = '确认删除',
  message,
  confirmText = '删除',
  loading,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title?: string
  message: string
  confirmText?: string
  loading?: boolean
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-sm"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-ink-600 leading-relaxed">{message}</p>
    </Modal>
  )
}

/* ------------------------------------------------------------------ */
/*  Toast                                                              */
/* ------------------------------------------------------------------ */
type ToastKind = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

const ToastContext = createContext<{ push: (message: string, kind?: ToastKind) => void } | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const idRef = useRef(0)

  const push = useCallback((message: string, kind: ToastKind = 'success') => {
    const id = ++idRef.current
    setItems((prev) => [...prev, { id, message, kind }])
    setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), 3200)
  }, [])

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      {createPortal(
        <div className="fixed bottom-5 right-5 z-[200] flex flex-col gap-2 pointer-events-none">
          {items.map((item) => (
            <div
              key={item.id}
              className="pointer-events-auto flex items-start gap-2.5 min-w-[240px] max-w-[360px] px-3.5 py-2.5 rounded-xl bg-white border border-ink-200 shadow-pop animate-fade-up"
            >
              {item.kind === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />}
              {item.kind === 'error' && <XCircle className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />}
              {item.kind === 'info' && <Info className="w-4 h-4 text-brand-500 mt-0.5 shrink-0" />}
              <p className="text-[13px] text-ink-700 leading-snug">{item.message}</p>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

/* ------------------------------------------------------------------ */
/*  Layout helpers                                                     */
/* ------------------------------------------------------------------ */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div>
        <h1 className="text-[19px] font-semibold text-ink-900 tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-[13px] text-ink-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
      <div className="w-11 h-11 rounded-xl bg-ink-100 flex items-center justify-center text-ink-400 mb-3">
        {icon ?? <Info className="w-5 h-5" />}
      </div>
      <p className="text-[13px] font-medium text-ink-700">{title}</p>
      {description && <p className="mt-1 text-xs text-ink-500 max-w-sm leading-relaxed">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function LoadingBlock({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-ink-100">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-5 py-3.5 flex items-center gap-4">
          <div className="skeleton h-3.5 w-32" />
          <div className="skeleton h-3.5 w-20" />
          <div className="skeleton h-3.5 flex-1" />
          <div className="skeleton h-3.5 w-16" />
          <div className="skeleton h-3.5 w-12" />
        </div>
      ))}
    </div>
  )
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center py-12 px-6 text-center">
      <AlertTriangle className="w-7 h-7 text-amber-500 mb-2" />
      <p className="text-[13px] font-medium text-ink-700">数据加载失败</p>
      <p className="mt-1 text-xs text-ink-500 max-w-md break-all">{message}</p>
      {onRetry && (
        <Button size="sm" className="mt-4" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Pagination                                                         */
/* ------------------------------------------------------------------ */
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number
  pageSize: number
  total: number
  onChange: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  return (
    <div className="flex items-center justify-between px-5 py-3 border-t border-ink-100 text-xs text-ink-500">
      <span>
        共 <span className="num font-medium text-ink-700">{total}</span> 条 · 当前 {from}-{to}
      </span>
      <div className="flex items-center gap-1">
        <button
          className="btn btn-sm btn-default !px-2"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <span className="px-2 num">
          {page} / {pages}
        </span>
        <button
          className="btn btn-sm btn-default !px-2"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Avatar                                                             */
/* ------------------------------------------------------------------ */
export function Avatar({ name, url, size = 28 }: { name?: string | null; url?: string | null; size?: number }) {
  const style = { width: size, height: size }
  if (url) {
    return <img src={url} alt={name ?? ''} style={style} className="rounded-full object-cover border border-ink-200" />
  }
  return (
    <div
      style={style}
      className="rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white flex items-center justify-center text-[11px] font-semibold shrink-0"
    >
      {(name ?? '?').trim().slice(0, 1).toUpperCase()}
    </div>
  )
}
