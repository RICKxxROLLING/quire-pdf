import { memo, useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { PageViewport } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Annot, Rect, Tool } from '@/types'
import { addAnnot, checkpoint, deleteAnnot, replaceAnnot, setSigDraft, setTool, useStore } from '@/store'
import { NOTE_SIZE, TEXT_ASCENT, TEXT_LINE, annotBounds, anchoredSize, normRect, translateAnnot, userToLocal } from '@/lib/geom'
import { getPageText, snapToText } from '@/lib/text'
import { uid } from '@/lib/util'

const DRAW_TOOLS: Tool[] = ['highlight', 'underline', 'strike', 'ink', 'rect', 'ellipse', 'line', 'arrow', 'redact', 'image', 'text', 'note', 'sigbox']

type Draft =
  | { kind: 'box'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'ink'; points: number[][] }

interface Props {
  docId: string
  pdf: PDFDocumentProxy
  pageIndex: number
  pageId: string
  rotation: number
  viewport: PageViewport
  annots: Annot[]
  hits: { rects: Rect[]; current: boolean }[]
}

export const AnnotLayer = memo(function AnnotLayer(p: Props) {
  const tool = useStore((s) => s.tool)
  const style = useStore((s) => s.style)
  const selected = useStore((s) => s.selected)
  const editing = useStore((s) => s.editing)
  const author = useStore((s) => s.author)
  const pendingImage = useStore((s) => s.pendingImage)
  const layerRef = useRef<HTMLDivElement>(null)
  const [draft, setDraftState] = useState<Draft | null>(null)
  // The live draft is kept in a ref so fast pointer events never read a stale value.
  const draftRef = useRef<Draft | null>(null)
  const setDraft = (d: Draft | null) => {
    draftRef.current = d
    setDraftState(d)
  }
  const drag = useRef<{ mode: 'move' | 'resize'; start: number[]; orig: Annot; moved: boolean; fixed?: number[] } | null>(null)
  const vp = p.viewport
  const scale = vp.scale

  const toUser = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = layerRef.current!.getBoundingClientRect()
    const [x, y] = vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top)
    return [x, y]
  }

  const base = () => ({ id: uid(), page: p.pageId, created: Date.now(), author: author || undefined })

  // ---- creation ---------------------------------------------------------
  const onLayerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !DRAW_TOOLS.includes(tool)) return
    e.preventDefault()
    e.stopPropagation()
    const [x, y] = toUser(e)
    if (tool === 'text') {
      const [ax, ay] = anchorAt(x, y, p.rotation, 0, style.fontSize / 2)
      const a: Annot = { ...base(), kind: 'text', x: ax, y: ay, rot: p.rotation, text: '', size: style.fontSize, color: style.color, opacity: 1 }
      addAnnot(p.docId, a)
      useStore.setState({ selected: a.id, editing: a.id })
      return
    }
    if (tool === 'note') {
      const [ax, ay] = anchorAt(x, y, p.rotation, NOTE_SIZE / 2, NOTE_SIZE / 2)
      const a: Annot = { ...base(), kind: 'note', x: ax, y: ay, rot: p.rotation, text: '', color: '#ffd43b', opacity: 1 }
      addAnnot(p.docId, a)
      setTool('select')
      useStore.setState({ selected: a.id, editing: a.id })
      return
    }
    ;(e.target as Element).setPointerCapture(e.pointerId)
    if (tool === 'ink') setDraft({ kind: 'ink', points: [[x, y]] })
    else if (tool === 'line' || tool === 'arrow') setDraft({ kind: 'line', x1: x, y1: y, x2: x, y2: y })
    else setDraft({ kind: 'box', x1: x, y1: y, x2: x, y2: y })
  }

  const onLayerMove = (e: React.PointerEvent) => {
    const draft = draftRef.current
    if (!draft) return
    let [x, y] = toUser(e)
    if (draft.kind === 'ink') {
      const last = draft.points[draft.points.length - 1]
      if (Math.hypot(x - last[0], y - last[1]) * scale < 1.5) return
      setDraft({ ...draft, points: [...draft.points, [x, y]] })
      return
    }
    if (e.shiftKey && draft.kind === 'line') {
      const ang = Math.round(Math.atan2(y - draft.y1, x - draft.x1) / (Math.PI / 4)) * (Math.PI / 4)
      const len = Math.hypot(x - draft.x1, y - draft.y1)
      x = draft.x1 + Math.cos(ang) * len
      y = draft.y1 + Math.sin(ang) * len
    } else if (e.shiftKey && draft.kind === 'box') {
      const d = Math.max(Math.abs(x - draft.x1), Math.abs(y - draft.y1))
      x = draft.x1 + Math.sign(x - draft.x1 || 1) * d
      y = draft.y1 + Math.sign(y - draft.y1 || 1) * d
    }
    setDraft({ ...draft, x2: x, y2: y })
  }

  const onLayerUp = async () => {
    const d = draftRef.current
    if (!d) return
    setDraft(null)
    const common = { ...base(), opacity: style.opacity }
    if (d.kind === 'ink') {
      if (d.points.length < 2) return
      addAnnot(p.docId, { ...common, kind: 'ink', points: simplify(d.points, 0.4 / scale), color: style.color, strokeWidth: style.strokeWidth })
      return
    }
    if (d.kind === 'line') {
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) * scale < 4) return
      addAnnot(p.docId, { ...common, kind: tool === 'arrow' ? 'arrow' : 'line', x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, color: style.color, strokeWidth: style.strokeWidth })
      return
    }
    const r = normRect(d.x1, d.y1, d.x2, d.y2)
    const tiny = r.w * scale < 4 || r.h * scale < 4
    if (tool === 'image' && pendingImage) {
      const w = tiny ? Math.min(220, pendingImage.w) : r.w
      const h = (w * pendingImage.h) / pendingImage.w
      const id = uid()
      const [ax, ay] = tiny ? anchorAt(d.x1, d.y1, p.rotation, w / 2, h / 2) : topLeftOf(r, p.rotation)
      addAnnot(p.docId, { ...common, id, kind: 'image', x: ax, y: ay, rot: p.rotation, w, h, src: pendingImage.src, color: '#000', opacity: 1 })
      useStore.setState({ tool: 'select', selected: id, pendingImage: null })
      return
    }
    if (tool === 'sigbox') {
      if (tiny) return
      setSigDraft({ placement: { docId: p.docId, page: p.pageIndex, rect: r } })
      useStore.setState({ tool: 'select', dialog: { kind: 'digitalSign', docId: p.docId } })
      return
    }
    if (tool === 'highlight' || tool === 'underline' || tool === 'strike') {
      const pt = await getPageText(p.pdf, p.pageIndex)
      const snapped = snapToText(pt, tiny ? { x: r.x - 1, y: r.y - 1, w: 2, h: 2 } : r)
      if (!snapped && tiny) return
      addAnnot(p.docId, { ...common, kind: 'markup', style: tool, rects: snapped ?? [r], color: tool === 'highlight' ? style.highlight : style.color, opacity: tool === 'highlight' ? 0.4 : style.opacity })
      return
    }
    if (tiny) return
    if (tool === 'redact') addAnnot(p.docId, { ...common, kind: 'redact', ...r, color: '#000000', opacity: 1 })
    else if (tool === 'rect' || tool === 'ellipse') addAnnot(p.docId, { ...common, kind: tool, ...r, color: style.color, strokeWidth: style.strokeWidth })
  }

  // ---- selection, move, resize -----------------------------------------
  const onAnnotDown = (e: React.PointerEvent, a: Annot) => {
    if (e.button !== 0) return
    if (tool === 'eraser') {
      e.stopPropagation()
      deleteAnnot(p.docId, a.id)
      return
    }
    if (tool !== 'select') return
    e.stopPropagation()
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    useStore.setState({ selected: a.id, editing: a.kind === 'note' ? a.id : null })
    ;(e.target as Element).setPointerCapture(e.pointerId)
    drag.current = { mode: 'move', start: toUser(e), orig: a, moved: false }
  }

  const onHandleDown = (e: React.PointerEvent, a: Annot) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const b = annotBounds(a)
    const [vx1, vy1, vx2, vy2] = vp.convertToViewportRectangle([b.x, b.y, b.x + b.w, b.y + b.h])
    const fixed = vp.convertToPdfPoint(Math.min(vx1, vx2), Math.min(vy1, vy2))
    drag.current = { mode: 'resize', start: toUser(e), orig: a, moved: false, fixed }
  }

  const onDragMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const [x, y] = toUser(e)
    if (!d.moved) {
      if (Math.hypot(x - d.start[0], y - d.start[1]) * scale < 2) return
      checkpoint(p.docId)
      d.moved = true
    }
    const o = d.orig
    if (d.mode === 'move') {
      replaceAnnot(p.docId, translateAnnot(o, x - d.start[0], y - d.start[1]))
      return
    }
    if (o.kind === 'image' || o.kind === 'text') {
      const { w, h } = anchoredSize(o)
      const [lx, ly] = userToLocal(o, x, y)
      const f = Math.max(10 / Math.max(w, h), Math.max(lx / w, ly / h))
      if (o.kind === 'image') replaceAnnot(p.docId, { ...o, w: o.w * f, h: o.h * f })
      else replaceAnnot(p.docId, { ...o, size: Math.max(4, Math.round(o.size * f * 2) / 2) })
    } else if (o.kind === 'rect' || o.kind === 'ellipse' || o.kind === 'redact') {
      const r = normRect(d.fixed![0], d.fixed![1], x, y)
      if (r.w > 2 && r.h > 2) replaceAnnot(p.docId, { ...o, ...r })
    }
  }

  const onDragUp = () => {
    drag.current = null
  }

  const drawing = DRAW_TOOLS.includes(tool)
  const cls = [
    'annot-layer',
    drawing ? (tool === 'text' ? 'text-tool' : 'drawing') : '',
    tool === 'eraser' ? 'eraser' : '',
    tool === 'pan' ? 'passive' : ''
  ].join(' ')

  const sel = p.annots.find((a) => a.id === selected)
  const m = vp.transform

  return (
    <div
      ref={layerRef}
      className={cls}
      style={{ pointerEvents: drawing ? 'all' : 'none' }}
      onPointerDown={onLayerDown}
      onPointerMove={(e) => (draftRef.current ? onLayerMove(e) : onDragMove(e))}
      onPointerUp={() => (draftRef.current ? onLayerUp() : onDragUp())}
    >
      <svg width="100%" height="100%">
        <g transform={`matrix(${m.join(' ')})`}>
          {p.hits.map((h, i) =>
            h.rects.map((r, j) => <rect key={`${i}-${j}`} className={`search-hl ${h.current ? 'current' : ''}`} x={r.x} y={r.y} width={r.w} height={r.h} rx={1} />)
          )}
          {p.annots.map((a) => (
            <AnnotShape
              key={a.id}
              a={a}
              scale={scale}
              hidden={editing === a.id && a.kind === 'text'}
              onPointerDown={(e) => onAnnotDown(e, a)}
              onDoubleClick={() => (a.kind === 'text' || a.kind === 'note') && useStore.setState({ selected: a.id, editing: a.id })}
            />
          ))}
          {draft && <DraftShape d={draft} tool={tool} color={tool === 'highlight' ? style.highlight : style.color} sw={style.strokeWidth} />}
          {sel && <SelectionBox a={sel} />}
        </g>
      </svg>
      {sel && tool === 'select' && <ResizeHandle a={sel} vp={vp} onPointerDown={(e) => onHandleDown(e, sel)} />}
      {sel && editing === sel.id && sel.kind === 'text' && <TextEditor docId={p.docId} a={sel} vp={vp} />}
      {sel && sel.kind === 'note' && editing === sel.id && <NoteEditor docId={p.docId} a={sel} vp={vp} />}
    </div>
  )
})

/** Anchor such that local point (lx, ly) lands on (x, y). */
function anchorAt(x: number, y: number, rot: number, lx: number, ly: number): [number, number] {
  const t = (rot * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return [x - (lx * c + ly * s), y - (lx * s - ly * c)]
}

function topLeftOf(r: Rect, rot: number): [number, number] {
  switch (((rot % 360) + 360) % 360) {
    case 90:
      return [r.x, r.y]
    case 180:
      return [r.x + r.w, r.y]
    case 270:
      return [r.x + r.w, r.y + r.h]
    default:
      return [r.x, r.y + r.h]
  }
}

/** Ramer–Douglas–Peucker to keep ink paths light. */
function simplify(pts: number[][], eps: number): number[][] {
  if (pts.length < 3) return pts
  const [x1, y1] = pts[0]
  const [x2, y2] = pts[pts.length - 1]
  let maxD = 0
  let idx = 0
  const len = Math.hypot(x2 - x1, y2 - y1) || 1
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((y2 - y1) * pts[i][0] - (x2 - x1) * pts[i][1] + x2 * y1 - y2 * x1) / len
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]]
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)]
}

const inkPath = (pts: number[][]) => pts.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join(' ')

function arrowHead(x1: number, y1: number, x2: number, y2: number, sw: number) {
  const ang = Math.atan2(y2 - y1, x2 - x1)
  const len = Math.max(10, sw * 4)
  const pts = [-1, 1].map((s) => {
    const t = ang + Math.PI - s * 0.5
    return `${x2 + len * Math.cos(t)} ${y2 + len * Math.sin(t)}`
  })
  return `M${pts[0]} L${x2} ${y2} L${pts[1]}`
}

interface ShapeProps {
  a: Annot
  scale: number
  hidden?: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onDoubleClick: () => void
}

function AnnotShape({ a, scale, hidden, ...handlers }: ShapeProps) {
  const hitW = Math.max(10 / scale, 'strokeWidth' in a ? a.strokeWidth : 0)
  const b = annotBounds(a)
  const boxHit = <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="transparent" />
  let body: React.ReactNode
  let hit: React.ReactNode = boxHit
  switch (a.kind) {
    case 'markup':
      body = a.rects.map((r, i) =>
        a.style === 'highlight' ? (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={a.color} opacity={a.opacity} style={{ mixBlendMode: 'multiply' }} />
        ) : (
          <line
            key={i}
            x1={r.x}
            x2={r.x + r.w}
            y1={a.style === 'underline' ? r.y + Math.max(0.8, r.h * 0.07) : r.y + r.h * 0.45}
            y2={a.style === 'underline' ? r.y + Math.max(0.8, r.h * 0.07) : r.y + r.h * 0.45}
            stroke={a.color}
            strokeWidth={Math.max(0.8, r.h * 0.07)}
            opacity={a.opacity}
          />
        )
      )
      hit = a.rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="transparent" />)
      break
    case 'rect':
      body = <rect x={a.x} y={a.y} width={a.w} height={a.h} fill={a.fill ?? 'none'} stroke={a.color} strokeWidth={a.strokeWidth} opacity={a.opacity} />
      break
    case 'ellipse':
      body = <ellipse cx={a.x + a.w / 2} cy={a.y + a.h / 2} rx={a.w / 2} ry={a.h / 2} fill={a.fill ?? 'none'} stroke={a.color} strokeWidth={a.strokeWidth} opacity={a.opacity} />
      break
    case 'redact':
      body = (
        <g>
          <rect x={a.x} y={a.y} width={a.w} height={a.h} fill="#000" opacity={0.82} />
          <rect x={a.x} y={a.y} width={a.w} height={a.h} fill="none" stroke="#e5484d" strokeWidth={1.5 / scale} strokeDasharray={`${4 / scale} ${3 / scale}`} />
        </g>
      )
      break
    case 'line':
    case 'arrow':
      body = (
        <g stroke={a.color} strokeWidth={a.strokeWidth} opacity={a.opacity} strokeLinecap="round" strokeLinejoin="round" fill="none">
          <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} />
          {a.kind === 'arrow' && <path d={arrowHead(a.x1, a.y1, a.x2, a.y2, a.strokeWidth)} />}
        </g>
      )
      hit = <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke="transparent" strokeWidth={hitW + a.strokeWidth} />
      break
    case 'ink':
      body = <path d={inkPath(a.points)} stroke={a.color} strokeWidth={a.strokeWidth} opacity={a.opacity} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      hit = <path d={inkPath(a.points)} stroke="transparent" strokeWidth={hitW + a.strokeWidth} fill="none" />
      break
    case 'text':
      body = hidden ? null : (
        <g transform={`translate(${a.x} ${a.y}) rotate(${a.rot}) scale(1 -1)`} opacity={a.opacity}>
          {a.text.split('\n').map((line, i) => (
            <text key={i} x={0} y={a.size * (TEXT_ASCENT + i * TEXT_LINE)} fontSize={a.size} fill={a.color} fontFamily="Helvetica, Arial, sans-serif" style={{ whiteSpace: 'pre' }}>
              {line}
            </text>
          ))}
        </g>
      )
      break
    case 'note':
      body = (
        <g transform={`translate(${a.x} ${a.y}) rotate(${a.rot}) scale(1 -1)`}>
          <rect width={NOTE_SIZE} height={NOTE_SIZE} rx={4} fill={a.color} stroke="rgba(0,0,0,.25)" strokeWidth={0.75} />
          <path d={`M5 7h12M5 11h12M5 15h8`} stroke="rgba(0,0,0,.55)" strokeWidth={1.4} strokeLinecap="round" />
        </g>
      )
      break
    case 'image':
      body = (
        <g transform={`translate(${a.x} ${a.y}) rotate(${a.rot}) scale(1 -1)`} opacity={a.opacity}>
          <image href={a.src} width={a.w} height={a.h} preserveAspectRatio="none" />
        </g>
      )
      break
  }
  return (
    <g>
      {body}
      <g className="hit-target" {...handlers}>
        {hit}
      </g>
    </g>
  )
}

function DraftShape({ d, tool, color, sw }: { d: Draft; tool: Tool; color: string; sw: number }) {
  if (d.kind === 'ink') return <path d={inkPath(d.points)} stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round" strokeLinejoin="round" />
  if (d.kind === 'line')
    return (
      <g stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round">
        <line x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} />
        {tool === 'arrow' && <path d={arrowHead(d.x1, d.y1, d.x2, d.y2, sw)} />}
      </g>
    )
  const r = normRect(d.x1, d.y1, d.x2, d.y2)
  if (tool === 'ellipse') return <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} stroke={color} strokeWidth={sw} fill="none" />
  if (tool === 'redact') return <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="#000" opacity={0.6} />
  if (tool === 'highlight') return <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={color} opacity={0.3} style={{ mixBlendMode: 'multiply' }} />
  if (tool === 'rect') return <rect x={r.x} y={r.y} width={r.w} height={r.h} stroke={color} strokeWidth={sw} fill="none" />
  return <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="rgba(109,93,252,.08)" stroke="#6d5dfc" strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
}

function SelectionBox({ a }: { a: Annot }) {
  const b = annotBounds(a)
  const pad = 3
  return <rect className="sel-box" x={b.x - pad} y={b.y - pad} width={b.w + pad * 2} height={b.h + pad * 2} rx={2} />
}

function ResizeHandle(props: {
  a: Annot
  vp: PageViewport
  onPointerDown: (e: React.PointerEvent) => void
}) {
  const { a, vp } = props
  if (!['rect', 'ellipse', 'redact', 'image', 'text'].includes(a.kind)) return null
  const b = annotBounds(a)
  const [x1, y1, x2, y2] = vp.convertToViewportRectangle([b.x, b.y, b.x + b.w, b.y + b.h])
  return (
    <div
      className="handle"
      style={{ left: Math.max(x1, x2) + 3, top: Math.max(y1, y2) + 3 }}
      onPointerDown={props.onPointerDown}
    />
  )
}

function TextEditor({ docId, a, vp }: { docId: string; a: Extract<Annot, { kind: 'text' }>; vp: PageViewport }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [x, y] = vp.convertToViewportPoint(a.x, a.y)
  useEffect(() => {
    const el = ref.current!
    el.focus()
    el.select()
  }, [])
  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.width = '0px'
    el.style.height = '0px'
    el.style.width = el.scrollWidth + 8 + 'px'
    el.style.height = el.scrollHeight + 'px'
  }
  useEffect(resize, [a.text, a.size, vp.scale])
  const finish = () => {
    const cur = useStore.getState().tabs.find((t) => t.id === docId)?.annots.find((x) => x.id === a.id)
    if (cur && cur.kind === 'text' && !cur.text.trim()) deleteAnnot(docId, a.id)
    useStore.setState({ editing: null })
  }
  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={a.text}
      spellCheck
      placeholder="Type here"
      style={{ left: x, top: y, fontSize: a.size * vp.scale, color: a.color, lineHeight: TEXT_LINE }}
      onChange={(e) => replaceAnnot(docId, { ...a, text: e.target.value })}
      onBlur={finish}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) ref.current?.blur()
      }}
    />
  )
}

function NoteEditor({ docId, a, vp }: { docId: string; a: Extract<Annot, { kind: 'note' }>; vp: PageViewport }) {
  const [x, y] = vp.convertToViewportPoint(a.x, a.y)
  const started = useRef(false)
  const POP_W = 240
  const right = x + NOTE_SIZE * vp.scale + 8
  // Flip to the left of the icon when there's no room on the right.
  const left = right + POP_W > vp.width + 40 ? x - POP_W - 8 : right
  return (
    <div className="note-pop" style={{ left, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="meta">
        <span>
          {a.author || 'Note'} · {new Date(a.created).toLocaleDateString()}
        </span>
        <button className="icon-btn sm" title="Delete note" onClick={() => deleteAnnot(docId, a.id)}>
          <Trash2 size={14} />
        </button>
      </div>
      <textarea
        className="input"
        rows={4}
        autoFocus
        placeholder="Write a comment…"
        value={a.text}
        onChange={(e) => {
          if (!started.current) {
            checkpoint(docId)
            started.current = true
          }
          replaceAnnot(docId, { ...a, text: e.target.value })
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') useStore.setState({ editing: null })
        }}
      />
    </div>
  )
}
