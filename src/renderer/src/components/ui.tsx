import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Info, KeyRound, X, type LucideIcon } from 'lucide-react'
import { useStore } from '@/store'

export function Modal(props: {
  title: string
  subtitle?: string
  icon?: LucideIcon
  color?: string
  wide?: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  footerLeft?: ReactNode
}) {
  const { icon: Icon, color = '#6d5dfc' } = props
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [props.onClose])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-label={props.title}>
        <div className="modal-head">
          {Icon && (
            <div className="ic" style={{ background: color + '1f', color }}>
              <Icon size={19} />
            </div>
          )}
          <div>
            <h3>{props.title}</h3>
            {props.subtitle && <div className="sub">{props.subtitle}</div>}
          </div>
          <button className="icon-btn sm" onClick={props.onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && (
          <div className="modal-foot">
            {props.footerLeft && <div className="left">{props.footerLeft}</div>}
            {props.footer}
          </div>
        )}
      </div>
    </div>
  )
}

export function OptionCards<T extends string>(props: {
  value: T
  onChange: (v: T) => void
  options: { value: T; title: string; desc?: string }[]
}) {
  return (
    <div className="option-cards">
      {props.options.map((o) => (
        <button key={o.value} className={`option-card ${props.value === o.value ? 'on' : ''}`} onClick={() => props.onChange(o.value)}>
          <span className="t">{o.title}</span>
          {o.desc && <span className="d">{o.desc}</span>}
        </button>
      ))}
    </div>
  )
}

export function Field(props: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="col">
      <span className="label">{props.label}</span>
      {props.children}
      {props.hint && <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{props.hint}</span>}
    </div>
  )
}

export function Check(props: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      {props.children}
    </label>
  )
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress">
      <div style={{ width: `${Math.round(Math.max(0.03, Math.min(1, value)) * 100)}%` }} />
    </div>
  )
}

export interface MenuEntry {
  label?: string
  icon?: LucideIcon
  shortcut?: string
  onClick?: () => void
  separator?: boolean
  heading?: string
  checked?: boolean
  disabled?: boolean
}

/** A popover menu anchored to an element's rect. */
export function Menu(props: { anchor: DOMRect; items: MenuEntry[]; onClose: () => void; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: props.anchor.left, top: props.anchor.bottom + 6 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = props.align === 'right' ? props.anchor.right - w : props.anchor.left
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    let top = props.anchor.bottom + 6
    if (top + h > window.innerHeight - 8) top = Math.max(8, props.anchor.top - h - 6)
    setPos({ left, top })
  }, [props.anchor, props.align])
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    setTimeout(() => window.addEventListener('mousedown', close), 0)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', props.onClose)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', props.onClose)
    }
  }, [props.onClose])
  return (
    <div className="menu" ref={ref} style={pos}>
      {props.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : it.heading ? (
          <div key={i} className="menu-label">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            className={`menu-item ${it.checked ? 'on' : ''}`}
            disabled={it.disabled}
            style={it.disabled ? { opacity: 0.45 } : undefined}
            onClick={() => {
              props.onClose()
              it.onClick?.()
            }}
          >
            {it.icon ? <it.icon size={16} /> : <span style={{ width: 16 }} />}
            {it.label}
            {it.shortcut && <span className="k">{it.shortcut}</span>}
          </button>
        )
      )}
    </div>
  )
}

/** Hook for a button that toggles a popover menu. */
export function useMenu() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  return {
    anchor,
    open: (e: React.MouseEvent) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect()),
    close: () => setAnchor(null)
  }
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? <AlertCircle size={17} /> : t.kind === 'success' ? <CheckCircle2 size={17} /> : <Info size={17} />}
          <span>{t.text}</span>
          {t.action && <button onClick={t.action.run}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  )
}

export function Busy() {
  const busy = useStore((s) => s.busy)
  if (!busy) return null
  return (
    <div className="busy">
      <div className="busy-card">
        <div className="row1">
          <div className="spinner" />
          {busy.label}
        </div>
        {busy.progress !== undefined && <Progress value={busy.progress} />}
      </div>
    </div>
  )
}

export function PromptHost() {
  const prompt = useStore((s) => s.prompt)
  const [pw, setPw] = useState('')
  useEffect(() => setPw(''), [prompt])
  if (!prompt) return null
  if (prompt.kind === 'password') {
    const submit = () => prompt.resolve(pw)
    return (
      <Modal
        title="Password required"
        subtitle={prompt.name}
        icon={KeyRound}
        onClose={() => prompt.resolve(null)}
        footer={
          <>
            <button className="btn" onClick={() => prompt.resolve(null)}>
              Cancel
            </button>
            <button className="btn primary" onClick={submit} disabled={!pw}>
              Unlock
            </button>
          </>
        }
      >
        <div>This document is protected. Enter its password to open it.</div>
        <input
          className="input"
          type="password"
          autoFocus
          value={pw}
          placeholder="Password"
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && pw && submit()}
          style={prompt.incorrect ? { borderColor: 'var(--danger)' } : undefined}
        />
        {prompt.incorrect && <div style={{ color: 'var(--danger)', fontSize: 12 }}>That password didn't work. Try again.</div>}
      </Modal>
    )
  }
  return (
    <Modal
      title={prompt.title}
      onClose={() => prompt.resolve('cancel')}
      footer={
        <>
          {prompt.alt && (
            <button className="btn" style={{ marginRight: 'auto' }} onClick={() => prompt.resolve('alt')}>
              {prompt.alt}
            </button>
          )}
          <button className="btn" onClick={() => prompt.resolve('cancel')}>
            {prompt.cancel ?? 'Cancel'}
          </button>
          <button className={`btn ${prompt.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => prompt.resolve('ok')}>
            {prompt.ok}
          </button>
        </>
      }
    >
      <div style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>{prompt.message}</div>
    </Modal>
  )
}
