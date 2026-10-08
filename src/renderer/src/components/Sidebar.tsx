import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight,
  BadgeCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  EyeOff,
  FormInput,
  Highlighter,
  Image as ImageIcon,
  Images,
  ListTree,
  MessageSquare,
  Minus,
  PenLine,
  Search,
  Square,
  StickyNote,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  X,
  type LucideIcon
} from 'lucide-react'
import type { Annot, Doc } from '@/types'
import { applyBytes, deleteAnnot, navigate, setAuthor, setPanel, useStore, type Panel } from '@/store'
import { Thumb } from './Thumb'
import { SignaturesPanel } from './Signatures'
import { searchDoc } from '@/lib/text'
import { annotBounds } from '@/lib/geom'
import { fillForm, flattenForm, getFormFields, type FormField } from '@/lib/ops'

const PANELS: { id: Panel; icon: LucideIcon; label: string }[] = [
  { id: 'thumbs', icon: Images, label: 'Pages' },
  { id: 'outline', icon: ListTree, label: 'Bookmarks' },
  { id: 'search', icon: Search, label: 'Search' },
  { id: 'comments', icon: MessageSquare, label: 'Annotations' },
  { id: 'forms', icon: FormInput, label: 'Form fields' },
  { id: 'signatures', icon: BadgeCheck, label: 'Signatures' }
]

export function Sidebar({ doc }: { doc: Doc }) {
  const panel = useStore((s) => s.panel)
  return (
    <>
      <div className="rail">
        {PANELS.map((p) => (
          <button key={p.id} className={`icon-btn ${panel === p.id ? 'on' : ''}`} title={p.label} onClick={() => setPanel(panel === p.id ? null : p.id)}>
            <p.icon size={18} />
          </button>
        ))}
      </div>
      {panel && (
        <div className="panel">
          <div className="panel-head">
            {PANELS.find((p) => p.id === panel)?.label}
            <button className="icon-btn sm" onClick={() => setPanel(null)} title="Close panel">
              <X size={15} />
            </button>
          </div>
          <div className="panel-body">
            {panel === 'thumbs' && <ThumbsPanel doc={doc} />}
            {panel === 'outline' && <OutlinePanel doc={doc} />}
            {panel === 'search' && <SearchPanel doc={doc} />}
            {panel === 'comments' && <CommentsPanel doc={doc} />}
            {panel === 'forms' && <FormsPanel doc={doc} />}
            {panel === 'signatures' && <SignaturesPanel doc={doc} />}
          </div>
        </div>
      )}
    </>
  )
}

function ThumbsPanel({ doc }: { doc: Doc }) {
  const ref = useRef<HTMLDivElement>(null)
  const W = 150
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-thumb="${doc.currentPage}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [doc.currentPage])
  return (
    <div className="thumbs" ref={ref}>
      {doc.pageSizes.map((s, i) => {
        const w = s.width >= s.height ? W : (W * s.width) / s.height
        const h = (w * s.height) / s.width
        return (
          <div key={doc.pageIds[i]} data-thumb={i} className={`thumb ${i === doc.currentPage ? 'current' : ''}`} onClick={() => navigate(doc.id, i)}>
            <div className="frame">
              <Thumb pdf={doc.pdf} index={i} width={w} height={h} />
            </div>
            <span className="num">{i + 1}</span>
          </div>
        )
      })}
    </div>
  )
}

interface OutlineNode {
  title: string
  dest: string | unknown[] | null
  items: OutlineNode[]
}

function OutlinePanel({ doc }: { doc: Doc }) {
  const [items, setItems] = useState<OutlineNode[] | null>(null)
  useEffect(() => {
    let alive = true
    doc.pdf.getOutline().then((o) => alive && setItems((o as OutlineNode[]) ?? []))
    return () => {
      alive = false
    }
  }, [doc.pdf])
  const go = async (dest: OutlineNode['dest']) => {
    try {
      const explicit = typeof dest === 'string' ? await doc.pdf.getDestination(dest) : dest
      if (!explicit) return
      const ref = explicit[0]
      const idx = typeof ref === 'number' ? ref : await doc.pdf.getPageIndex(ref as never)
      const top = typeof explicit[3] === 'number' ? (explicit[3] as number) : null
      navigate(doc.id, idx, top !== null ? { x: 0, y: top - 20, w: 1, h: 20 } : undefined)
    } catch {
      /* broken destination */
    }
  }
  if (!items) return <div className="panel-empty">Loading…</div>
  if (!items.length) return <div className="panel-empty">This document has no bookmarks.</div>
  return (
    <div style={{ padding: '2px 0 16px' }}>
      {items.map((n, i) => (
        <OutlineItem key={i} node={n} depth={0} go={go} />
      ))}
    </div>
  )
}

function OutlineItem({ node, depth, go }: { node: OutlineNode; depth: number; go: (d: OutlineNode['dest']) => void }) {
  const [open, setOpen] = useState(depth < 1)
  return (
    <>
      <div className="outline-item" style={{ paddingLeft: depth * 14 + 2 }} onClick={() => go(node.dest)}>
        <button
          className="chev"
          style={{ visibility: node.items.length ? 'visible' : 'hidden' }}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(!open)
          }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span>{node.title}</span>
      </div>
      {open && node.items.map((c, i) => <OutlineItem key={i} node={c} depth={depth + 1} go={go} />)}
    </>
  )
}

function SearchPanel({ doc }: { doc: Doc }) {
  const search = useStore((s) => s.search)
  const [q, setQ] = useState(search.docId === doc.id ? search.query : '')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { caseSensitive, wholeWord } = search

  useEffect(() => {
    inputRef.current?.focus()
    const focus = () => inputRef.current?.focus()
    window.addEventListener('quire:focus-search', focus)
    return () => window.removeEventListener('quire:focus-search', focus)
  }, [])

  useEffect(() => {
    const signal = { cancelled: false }
    const t = setTimeout(() => {
      useStore.setState((s) => ({ search: { ...s.search, docId: doc.id, query: q, hits: [], index: 0, running: !!q.trim() } }))
      if (!q.trim()) return
      let first = true
      searchDoc(doc.pdf, q, { caseSensitive, wholeWord }, signal, (hits) => {
        useStore.setState((s) => ({ search: { ...s.search, hits: [...s.search.hits, ...hits] } }))
        if (first) {
          first = false
          navigate(doc.id, hits[0].page, hits[0].rects[0])
        }
      }).finally(() => !signal.cancelled && useStore.setState((s) => ({ search: { ...s.search, running: false } })))
    }, 220)
    return () => {
      signal.cancelled = true
      clearTimeout(t)
    }
  }, [q, caseSensitive, wholeWord, doc.pdf, doc.id])

  const goto = (i: number) => {
    const n = search.hits.length
    if (!n) return
    const idx = ((i % n) + n) % n
    useStore.setState((s) => ({ search: { ...s.search, index: idx } }))
    const h = search.hits[idx]
    navigate(doc.id, h.page, h.rects[0])
    listRef.current?.querySelector(`[data-hit="${idx}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const hits = search.docId === doc.id ? search.hits : []
  return (
    <>
      <div className="search-box">
        <div className="input-icon">
          <Search size={15} />
          <input
            ref={inputRef}
            className="input"
            placeholder="Search document"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') goto(search.index + (e.shiftKey ? -1 : 1))
              e.stopPropagation()
            }}
          />
        </div>
        <div className="chips">
          <button className={`chip ${caseSensitive ? 'on' : ''}`} onClick={() => useStore.setState((s) => ({ search: { ...s.search, caseSensitive: !caseSensitive } }))}>
            Match case
          </button>
          <button className={`chip ${wholeWord ? 'on' : ''}`} onClick={() => useStore.setState((s) => ({ search: { ...s.search, wholeWord: !wholeWord } }))}>
            Whole words
          </button>
          <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11.5 }}>
            {q.trim() ? (search.running ? 'Searching…' : `${hits.length} result${hits.length === 1 ? '' : 's'}`) : ''}
          </span>
        </div>
      </div>
      <div ref={listRef}>
        {hits.map((h, i) => (
          <div key={i} data-hit={i} className={`hit ${i === search.index ? 'on' : ''}`} onClick={() => goto(i)}>
            <div className="pg">Page {h.page + 1}</div>
            …{h.snippet.before}
            <mark>{h.snippet.match}</mark>
            {h.snippet.after}…
          </div>
        ))}
        {q.trim() && !search.running && !hits.length && <div className="panel-empty">No matches. Scanned documents need OCR before they can be searched.</div>}
      </div>
    </>
  )
}

const KIND_META: Record<string, { icon: LucideIcon; label: string }> = {
  highlight: { icon: Highlighter, label: 'Highlight' },
  underline: { icon: Underline, label: 'Underline' },
  strike: { icon: Strikethrough, label: 'Strikethrough' },
  rect: { icon: Square, label: 'Rectangle' },
  ellipse: { icon: Circle, label: 'Ellipse' },
  line: { icon: Minus, label: 'Line' },
  arrow: { icon: ArrowUpRight, label: 'Arrow' },
  ink: { icon: PenLine, label: 'Drawing' },
  text: { icon: Type, label: 'Text' },
  note: { icon: StickyNote, label: 'Note' },
  image: { icon: ImageIcon, label: 'Image' },
  redact: { icon: EyeOff, label: 'Redaction' }
}

function CommentsPanel({ doc }: { doc: Doc }) {
  const selected = useStore((s) => s.selected)
  const author = useStore((s) => s.author)
  const groups = useMemo(() => {
    const m = new Map<number, Annot[]>()
    for (const a of doc.annots) {
      const idx = doc.pageIds.indexOf(a.page)
      if (idx < 0) continue
      if (!m.has(idx)) m.set(idx, [])
      m.get(idx)!.push(a)
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [doc.annots, doc.pageIds])

  return (
    <>
      <div className="field" style={{ paddingTop: 2 }}>
        <label>Your name (shown on notes)</label>
        <input className="input" value={author} placeholder="Anonymous" onChange={(e) => setAuthor(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      {!groups.length && <div className="panel-empty">No annotations yet. Use the tools in the toolbar to highlight, draw, comment and more.</div>}
      {groups.map(([idx, list]) => (
        <div key={idx}>
          <div className="group-label">Page {idx + 1}</div>
          {list.map((a) => {
            const meta = KIND_META[a.kind === 'markup' ? a.style : a.kind]
            const detail = a.kind === 'note' || a.kind === 'text' ? a.text || '(empty)' : a.author ? `by ${a.author}` : new Date(a.created).toLocaleString()
            return (
              <div
                key={a.id}
                className={`comment ${selected === a.id ? 'on' : ''}`}
                onClick={() => {
                  useStore.setState({ selected: a.id, tool: 'select' })
                  navigate(doc.id, idx, annotBounds(a))
                }}
              >
                <div className="ic" style={{ background: (a.kind === 'redact' ? '#000000' : a.color) + '2a', color: a.kind === 'redact' ? 'var(--text)' : a.color }}>
                  <meta.icon size={15} />
                </div>
                <div className="body">
                  <div className="t">{meta.label}</div>
                  <div className="d">{detail}</div>
                </div>
                <button
                  className="icon-btn sm"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteAnnot(doc.id, a.id)
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
}

function FormsPanel({ doc }: { doc: Doc }) {
  const [fields, setFields] = useState<FormField[] | null>(null)
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({})
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setFields(null)
    getFormFields(doc.bytes)
      .then((f) => {
        if (!alive) return
        setFields(f)
        setValues(Object.fromEntries(f.map((x) => [x.name, x.value])))
      })
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [doc.version])

  if (error) return <div className="panel-empty">Couldn't read form fields: {error}</div>
  if (!fields) return <div className="panel-empty">Loading…</div>
  const editable = fields.filter((f) => f.type !== 'signature' && f.type !== 'other')
  if (!editable.length) return <div className="panel-empty">This document has no fillable form fields.</div>
  const changed = editable.some((f) => JSON.stringify(values[f.name]) !== JSON.stringify(f.value))
  const set = (k: string, v: string | boolean | string[]) => setValues((s) => ({ ...s, [k]: v }))

  return (
    <div style={{ paddingTop: 4 }}>
      {editable.map((f) => (
        <div className="field" key={f.name}>
          {f.type !== 'checkbox' && <label title={f.name}>{prettyName(f.name)}</label>}
          {f.type === 'text' &&
            (f.multiline ? (
              <textarea className="input" rows={3} disabled={f.readOnly} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            ) : (
              <input className="input" disabled={f.readOnly} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            ))}
          {f.type === 'checkbox' && (
            <label className="check">
              <input type="checkbox" disabled={f.readOnly} checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
              {prettyName(f.name)}
            </label>
          )}
          {(f.type === 'dropdown' || f.type === 'radio') && (
            <select className="input" disabled={f.readOnly} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)}>
              <option value="">—</option>
              {f.options?.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          )}
          {f.type === 'list' && (
            <select
              className="input"
              multiple
              style={{ height: 80 }}
              disabled={f.readOnly}
              value={(values[f.name] as string[]) ?? []}
              onChange={(e) => set(f.name, Array.from(e.target.selectedOptions).map((o) => o.value))}
            >
              {f.options?.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, padding: '4px 12px 20px', position: 'sticky', bottom: 0, background: 'var(--surface)' }}>
        <button className="btn primary" style={{ flex: 1 }} disabled={!changed} onClick={() => applyBytes(doc.id, 'Filling form…', (d) => fillForm(d.bytes, values), 'Form updated')}>
          Apply
        </button>
        <button className="btn" title="Turn fields into regular page content" onClick={() => applyBytes(doc.id, 'Flattening…', (d) => flattenForm(d.bytes), 'Form flattened')}>
          Flatten
        </button>
      </div>
    </div>
  )
}

const prettyName = (n: string) => n.split('.').pop()!.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim()

