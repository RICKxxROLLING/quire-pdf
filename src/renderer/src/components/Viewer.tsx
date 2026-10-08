import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Copy, Highlighter, Strikethrough, Underline } from 'lucide-react'
import type { PageViewport, RenderTask } from 'pdfjs-dist'
import type { Annot, Doc, MarkupStyle, Rect } from '@/types'
import { pdfjs, type PDFDocumentProxy, type PDFPageProxy } from '@/lib/pdfjs'
import { addAnnot, setDocView, toast, useStore } from '@/store'
import { AnnotLayer } from './AnnotLayer'
import { clamp, uid } from '@/lib/util'
import { normRect } from '@/lib/geom'

const GAP = 18
const PAD_TOP = 24
const PAD_X = 64

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 6

export function Viewer({ doc }: { doc: Doc }) {
  const ref = useRef<HTMLDivElement>(null)
  const tool = useStore((s) => s.tool)
  const nav = useStore((s) => s.nav)
  const search = useStore((s) => s.search)
  const [range, setRange] = useState<[number, number]>([0, 2])
  const [box, setBox] = useState({ w: 0, h: 0 })
  const zoomAnchor = useRef<{ mx: number; my: number; cx: number; cy: number; ratio: number } | null>(null)
  const viewports = useRef(new Map<number, PageViewport>())
  const [selPop, setSelPop] = useState<{ x: number; y: number } | null>(null)
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)
  const [panning, setPanning] = useState(false)

  const tops = useMemo(() => {
    let y = PAD_TOP
    return doc.pageSizes.map((s) => {
      const t = y
      y += s.height * doc.scale + GAP
      return t
    })
  }, [doc.pageSizes, doc.scale])

  // Track container size for fit modes.
  useLayoutEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (doc.fit === 'none' || !box.w || !doc.pageSizes.length) return
    const maxW = Math.max(...doc.pageSizes.map((s) => s.width))
    const cur = doc.pageSizes[doc.currentPage] ?? doc.pageSizes[0]
    const s =
      doc.fit === 'width'
        ? (box.w - PAD_X - 14) / maxW
        : Math.min((box.w - PAD_X - 14) / cur.width, (box.h - PAD_TOP * 2) / cur.height)
    const next = clamp(Math.round(s * 1000) / 1000, MIN_ZOOM, MAX_ZOOM)
    if (Math.abs(next - doc.scale) > 0.002) setDocView(doc.id, { scale: next })
  }, [doc.fit, box.w, box.h, doc.pageSizes, doc.id])

  const updateRange = useCallback(() => {
    const el = ref.current
    if (!el) return
    const st = el.scrollTop
    const h = el.clientHeight
    let first = 0
    let last = 0
    let current = 0
    for (let i = 0; i < tops.length; i++) {
      const bottom = tops[i] + doc.pageSizes[i].height * doc.scale
      if (bottom < st - h * 0.75) first = i + 1
      if (tops[i] < st + h * 1.75) last = i
      if (tops[i] <= st + h * 0.35) current = i
    }
    setRange((r) => (r[0] === first && r[1] === last ? r : [first, last]))
    const d = useStore.getState().tabs.find((t) => t.id === doc.id)
    if (d && d.currentPage !== current) setDocView(doc.id, { currentPage: current })
  }, [tops, doc.pageSizes, doc.scale, doc.id])

  useLayoutEffect(() => {
    const a = zoomAnchor.current
    const el = ref.current
    if (a && el) {
      el.scrollLeft = a.cx * a.ratio - a.mx
      el.scrollTop = a.cy * a.ratio - a.my
      zoomAnchor.current = null
    }
    updateRange()
  }, [updateRange])

  // Navigation requests (thumbnails, outline, search, page input).
  useEffect(() => {
    if (!nav || nav.docId !== doc.id) return
    const el = ref.current!
    const top = tops[nav.page]
    if (top === undefined) return
    if (!nav.rect) {
      el.scrollTo({ top: top - 12 })
      return
    }
    const r = nav.rect
    doc.pdf.getPage(nav.page + 1).then((p) => {
      const vp = p.getViewport({ scale: doc.scale, rotation: p.rotate })
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle([r.x, r.y, r.x + r.w, r.y + r.h])
      const pageLeft = Math.max(PAD_X / 2, (el.scrollWidth - doc.pageSizes[nav.page].width * doc.scale) / 2)
      el.scrollTo({
        top: top + Math.min(y1, y2) - el.clientHeight / 3,
        left: pageLeft + Math.min(x1, x2) - el.clientWidth / 2,
        behavior: 'smooth'
      })
    })
  }, [nav])

  // Ctrl/⌘ + wheel zoom around the cursor (non-passive listener so we can preventDefault).
  useEffect(() => {
    const el = ref.current!
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const d = useStore.getState().tabs.find((t) => t.id === doc.id)
      if (!d) return
      const next = clamp(d.scale * Math.exp(-e.deltaY * 0.0022), MIN_ZOOM, MAX_ZOOM)
      if (next === d.scale) return
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      zoomAnchor.current = { mx, my, cx: el.scrollLeft + mx, cy: el.scrollTop + my, ratio: next / d.scale }
      setDocView(doc.id, { scale: next, fit: 'none' })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [doc.id])

  const registerVp = useCallback((i: number, vp: PageViewport) => viewports.current.set(i, vp), [])

  // ---- text selection → markup popover ---------------------------------
  const onMouseUp = () => {
    if (useStore.getState().tool !== 'select') return
    setTimeout(() => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount || !ref.current?.contains(sel.anchorNode)) {
        setSelPop(null)
        return
      }
      const rects = Array.from(sel.getRangeAt(0).getClientRects()).filter((r) => r.width > 1 && r.height > 1)
      if (!rects.length) return setSelPop(null)
      const last = rects[rects.length - 1]
      const host = ref.current!.getBoundingClientRect()
      setSelPop({ x: last.right - host.left + ref.current!.scrollLeft, y: last.bottom - host.top + ref.current!.scrollTop + 8 })
    }, 0)
  }

  const markSelection = (style: MarkupStyle) => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const rects = Array.from(sel.getRangeAt(0).getClientRects()).filter((r) => r.width > 1 && r.height > 1)
    const byPage = new Map<number, Rect[]>()
    const pageEls = ref.current!.querySelectorAll<HTMLElement>('.page')
    for (const r of rects) {
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      pageEls.forEach((pe) => {
        const pr = pe.getBoundingClientRect()
        if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) return
        const idx = Number(pe.dataset.index)
        const vp = viewports.current.get(idx)
        if (!vp) return
        const [x1, y1] = vp.convertToPdfPoint(r.left - pr.left, r.top - pr.top)
        const [x2, y2] = vp.convertToPdfPoint(r.right - pr.left, r.bottom - pr.top)
        if (!byPage.has(idx)) byPage.set(idx, [])
        byPage.get(idx)!.push(normRect(x1, y1, x2, y2))
      })
    }
    const { style: st, author } = useStore.getState()
    for (const [idx, rs] of byPage) {
      const a: Annot = {
        id: uid(),
        kind: 'markup',
        style,
        page: doc.pageIds[idx],
        rects: mergeLineRects(rs),
        color: style === 'highlight' ? st.highlight : st.color,
        opacity: style === 'highlight' ? 0.4 : 1,
        created: Date.now(),
        author: author || undefined
      }
      addAnnot(doc.id, a)
    }
    sel.removeAllRanges()
    setSelPop(null)
  }

  // ---- panning ------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    const el = ref.current!
    const t = e.target as HTMLElement
    if (tool === 'select' && !t.closest('.hit-target, .handle, .note-pop, .text-editor, .menu')) {
      const s = useStore.getState()
      if (s.selected || s.editing) useStore.setState({ selected: null, editing: null })
    }
    if (tool === 'pan' || e.button === 1) {
      e.preventDefault()
      pan.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
      el.setPointerCapture(e.pointerId)
      setPanning(true)
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pan.current
    if (!p) return
    const el = ref.current!
    el.scrollLeft = p.sl - (e.clientX - p.x)
    el.scrollTop = p.st - (e.clientY - p.y)
  }
  const onPointerUp = () => {
    pan.current = null
    setPanning(false)
  }

  const hitsByPage = useMemo(() => {
    const m = new Map<number, { rects: Rect[]; current: boolean }[]>()
    if (search.docId !== doc.id) return m
    search.hits.forEach((h, i) => {
      if (!m.has(h.page)) m.set(h.page, [])
      m.get(h.page)!.push({ rects: h.rects, current: i === search.index })
    })
    return m
  }, [search, doc.id])

  const annotsByPage = useMemo(() => {
    const m = new Map<string, Annot[]>()
    for (const a of doc.annots) {
      if (!m.has(a.page)) m.set(a.page, [])
      m.get(a.page)!.push(a)
    }
    return m
  }, [doc.annots])

  return (
    <div
      ref={ref}
      className={`viewer ${tool === 'pan' ? 'pan' : ''} ${panning ? 'panning' : ''}`}
      tabIndex={-1}
      onScroll={() => {
        setSelPop(null)
        requestAnimationFrame(updateRange)
      }}
      onMouseUp={onMouseUp}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="pages">
        {doc.pageSizes.map((s, i) => (
          <PageView
            key={doc.pageIds[i]}
            docId={doc.id}
            pdf={doc.pdf}
            index={i}
            pageId={doc.pageIds[i]}
            width={s.width * doc.scale}
            height={s.height * doc.scale}
            rotation={s.rotation}
            scale={doc.scale}
            visible={i >= range[0] && i <= range[1]}
            annots={annotsByPage.get(doc.pageIds[i]) ?? EMPTY}
            hits={hitsByPage.get(i) ?? EMPTY_HITS}
            registerVp={registerVp}
          />
        ))}
      </div>
      {selPop && tool === 'select' && (
        <div className="menu" style={{ position: 'absolute', left: selPop.x - 60, top: selPop.y, minWidth: 0, display: 'flex', gap: 2 }} onMouseUp={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="Highlight" onClick={() => markSelection('highlight')}>
            <Highlighter size={17} />
          </button>
          <button className="icon-btn" title="Underline" onClick={() => markSelection('underline')}>
            <Underline size={17} />
          </button>
          <button className="icon-btn" title="Strikethrough" onClick={() => markSelection('strike')}>
            <Strikethrough size={17} />
          </button>
          <button
            className="icon-btn"
            title="Copy"
            onClick={() => {
              navigator.clipboard.writeText(window.getSelection()?.toString() ?? '')
              toast('Copied to clipboard')
              setSelPop(null)
            }}
          >
            <Copy size={16} />
          </button>
        </div>
      )}
    </div>
  )
}

const EMPTY: Annot[] = []
const EMPTY_HITS: { rects: Rect[]; current: boolean }[] = []

/** Merge per-span rects into one rect per line. */
function mergeLineRects(rs: Rect[]): Rect[] {
  const sorted = [...rs].sort((a, b) => b.y - a.y || a.x - b.x)
  const out: Rect[] = []
  for (const r of sorted) {
    const prev = out[out.length - 1]
    const sameLine = prev && Math.abs(prev.y + prev.h / 2 - (r.y + r.h / 2)) < Math.min(prev.h, r.h) * 0.5
    if (sameLine && r.x <= prev.x + prev.w + r.h * 0.6) {
      const x1 = Math.min(prev.x, r.x)
      const y1 = Math.min(prev.y, r.y)
      const x2 = Math.max(prev.x + prev.w, r.x + r.w)
      const y2 = Math.max(prev.y + prev.h, r.y + r.h)
      out[out.length - 1] = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
    } else out.push(r)
  }
  return out
}

interface PageProps {
  docId: string
  pdf: PDFDocumentProxy
  index: number
  pageId: string
  width: number
  height: number
  rotation: number
  scale: number
  visible: boolean
  annots: Annot[]
  hits: { rects: Rect[]; current: boolean }[]
  registerVp: (i: number, vp: PageViewport) => void
}

const MAX_CANVAS_PX = 16_777_216

const PageView = memo(function PageView(p: PageProps) {
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const canvasHost = useRef<HTMLDivElement>(null)
  const textHost = useRef<HTMLDivElement>(null)
  const rendered = useRef(false)

  useEffect(() => {
    let alive = true
    p.pdf
      .getPage(p.index + 1)
      .then((pg) => alive && setPage(pg))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [p.pdf, p.index])

  const vp = useMemo(() => page?.getViewport({ scale: p.scale, rotation: page.rotate }), [page, p.scale])
  useEffect(() => {
    if (vp) p.registerVp(p.index, vp)
  }, [vp, p.index])

  // Canvas: render offscreen then swap in, so zooming never flashes blank.
  useEffect(() => {
    const host = canvasHost.current!
    if (!page) return
    if (!p.visible) {
      host.replaceChildren()
      rendered.current = false
      return
    }
    let cancelled = false
    let task: RenderTask | undefined
    const timer = setTimeout(
      async () => {
        const base = page.getViewport({ scale: 1, rotation: page.rotate })
        let rs = p.scale * devicePixelRatio
        if (base.width * base.height * rs * rs > MAX_CANVAS_PX) rs = Math.sqrt(MAX_CANVAS_PX / (base.width * base.height))
        const v = page.getViewport({ scale: rs, rotation: page.rotate })
        const c = document.createElement('canvas')
        c.width = Math.floor(v.width)
        c.height = Math.floor(v.height)
        task = page.render({ canvasContext: c.getContext('2d')!, viewport: v })
        try {
          await task.promise
        } catch {
          return
        }
        if (cancelled) return
        host.replaceChildren(c)
        rendered.current = true
      },
      rendered.current ? 140 : 0
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
      task?.cancel()
    }
  }, [page, p.scale, p.visible])

  // Selectable text layer.
  useEffect(() => {
    const host = textHost.current!
    if (!page || !p.visible || !vp) return
    let cancelled = false
    let tl: InstanceType<typeof pdfjs.TextLayer> | undefined
    const timer = setTimeout(() => {
      const div = document.createElement('div')
      div.className = 'textLayer'
      tl = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container: div,
        viewport: vp
      })
      tl.render()
        .then(() => {
          if (cancelled) return
          const end = document.createElement('div')
          end.className = 'endOfContent'
          div.append(end)
          div.addEventListener('mousedown', () => div.classList.add('selecting'))
          div.addEventListener('mouseup', () => div.classList.remove('selecting'))
          host.replaceChildren(div)
        })
        .catch(() => {})
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
      tl?.cancel()
    }
  }, [page, vp, p.visible])

  return (
    <div
      className="page"
      data-index={p.index}
      style={{ width: p.width, height: p.height, ['--scale-factor' as string]: p.scale }}
    >
      <div ref={canvasHost} style={{ position: 'absolute', inset: 0 }} className="canvas-host" />
      <div ref={textHost} style={{ position: 'absolute', inset: 0 }} />
      {page && vp && p.visible && (
        <AnnotLayer
          docId={p.docId}
          pdf={p.pdf}
          pageIndex={p.index}
          pageId={p.pageId}
          rotation={page.rotate}
          viewport={vp}
          annots={p.annots}
          hits={p.hits}
        />
      )}
      <span className="page-label">{p.index + 1}</span>
    </div>
  )
})
