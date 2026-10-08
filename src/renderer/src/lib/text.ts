import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import type { Rect } from '@/types'
import { rectsIntersect } from './geom'

interface TextRun {
  str: string
  x: number
  y: number
  w: number
  h: number
  start: number
  eol: boolean
  font: string
  /** Lazily computed x offset (user units) of each character boundary. */
  offsets?: number[]
}

export interface PageText {
  items: TextRun[]
  text: string
}

let measureCtx: CanvasRenderingContext2D | null = null

/**
 * Character boundary offsets within a run. Glyph widths are measured with a similar font and scaled
 * to the run's true width, which is far more accurate than assuming equal-width characters.
 */
function offsets(it: TextRun): number[] {
  if (it.offsets) return it.offsets
  measureCtx ??= document.createElement('canvas').getContext('2d')!
  measureCtx.font = `100px ${it.font}`
  const raw = [0]
  for (let i = 1; i <= it.str.length; i++) raw.push(measureCtx.measureText(it.str.slice(0, i)).width)
  const total = raw[raw.length - 1] || 1
  it.offsets = raw.map((v) => (v / total) * it.w)
  return it.offsets
}

const cache = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageText>>>()

export function getPageText(pdf: PDFDocumentProxy, index: number): Promise<PageText> {
  let m = cache.get(pdf)
  if (!m) cache.set(pdf, (m = new Map()))
  let p = m.get(index)
  if (!p) {
    p = (async () => {
      const page = await pdf.getPage(index + 1)
      const tc = await page.getTextContent()
      const items: PageText['items'] = []
      let text = ''
      for (const it of tc.items as TextItem[]) {
        if (typeof it.str !== 'string') continue
        const [a, b, c, d, e, f] = it.transform
        const h = it.height || Math.hypot(c, d) || Math.hypot(a, b)
        const font = tc.styles[it.fontName]?.fontFamily ?? 'sans-serif'
        items.push({ str: it.str, x: e, y: f - h * 0.22, w: it.width, h: h * 1.18, start: text.length, eol: !!it.hasEOL, font })
        text += it.str + (it.hasEOL ? '\n' : '')
      }
      return { items, text }
    })()
    m.set(index, p)
  }
  return p
}

export async function extractAllText(pdf: PDFDocumentProxy, onProgress?: (d: number, t: number) => void): Promise<string> {
  const parts: string[] = []
  for (let i = 0; i < pdf.numPages; i++) {
    onProgress?.(i, pdf.numPages)
    const { text } = await getPageText(pdf, i)
    parts.push(text.trim())
  }
  return parts.join('\n\n\f')
}

/** Rects (user space) covering characters [from, to) of the page text. */
export function rangeRects(pt: PageText, from: number, to: number): Rect[] {
  const rects: Rect[] = []
  for (const it of pt.items) {
    const s = it.start
    const e = it.start + it.str.length
    if (e <= from || s >= to || !it.str.length) continue
    const a = Math.max(from, s) - s
    const b = Math.min(to, e) - s
    const o = offsets(it)
    rects.push({ x: it.x + o[a], y: it.y, w: o[b] - o[a], h: it.h })
  }
  return rects
}

export interface SearchHit {
  page: number
  rects: Rect[]
  snippet: { before: string; match: string; after: string }
}

export async function searchDoc(
  pdf: PDFDocumentProxy,
  query: string,
  opts: { caseSensitive: boolean; wholeWord: boolean },
  signal: { cancelled: boolean },
  onHits: (hits: SearchHit[]) => void
): Promise<void> {
  if (!query.trim()) return
  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const re = new RegExp(opts.wholeWord ? `\\b${esc}\\b` : esc, opts.caseSensitive ? 'g' : 'gi')
  for (let i = 0; i < pdf.numPages; i++) {
    if (signal.cancelled) return
    const pt = await getPageText(pdf, i)
    const hits: SearchHit[] = []
    for (const m of pt.text.matchAll(re)) {
      const from = m.index!
      const to = from + m[0].length
      hits.push({
        page: i,
        rects: rangeRects(pt, from, to),
        snippet: {
          before: pt.text.slice(Math.max(0, from - 40), from).replace(/\s+/g, ' '),
          match: m[0],
          after: pt.text.slice(to, to + 60).replace(/\s+/g, ' ')
        }
      })
    }
    if (hits.length && !signal.cancelled) onHits(hits)
  }
}

/**
 * Snap a dragged rectangle to the text lines it covers, so highlights hug the words.
 * Returns null when the rectangle doesn't touch any text.
 */
export function snapToText(pt: PageText, r: Rect): Rect[] | null {
  const lines = new Map<number, Rect>()
  for (const it of pt.items) {
    if (!it.str.trim() || it.w <= 0) continue
    const box = { x: it.x, y: it.y, w: it.w, h: it.h }
    if (!rectsIntersect(box, r)) continue
    // Clip horizontally to whole characters inside the drag.
    const o = offsets(it)
    let a = 0
    while (a < it.str.length && it.x + o[a + 1] <= r.x) a++
    let b = it.str.length
    while (b > a && it.x + o[b - 1] >= r.x + r.w) b--
    if (b <= a) continue
    const seg = { x: it.x + o[a], y: it.y, w: o[b] - o[a], h: it.h }
    const key = Math.round(it.y / Math.max(2, it.h * 0.5))
    const cur = lines.get(key)
    if (!cur) lines.set(key, seg)
    else {
      const x1 = Math.min(cur.x, seg.x)
      const y1 = Math.min(cur.y, seg.y)
      const x2 = Math.max(cur.x + cur.w, seg.x + seg.w)
      const y2 = Math.max(cur.y + cur.h, seg.y + seg.h)
      lines.set(key, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
    }
  }
  return lines.size ? [...lines.values()] : null
}
