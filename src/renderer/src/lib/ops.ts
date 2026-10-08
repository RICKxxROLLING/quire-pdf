/**
 * All document mutations go through here. Every function takes PDF bytes and returns new bytes,
 * which keeps undo/redo trivial (snapshots are just immutable byte arrays).
 */
import {
  BlendMode,
  LineCapStyle,
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFPage,
  PDFPageLeaf,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFSignature,
  PDFString,
  PDFTextField,
  StandardFonts,
  TextRenderingMode,
  beginText,
  concatTransformationMatrix,
  decodePDFRawStream,
  drawObject,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setFontAndSize,
  showText,
  degrees,
  rgb
} from '@cantoo/pdf-lib'
import type { Annot, Rect } from '@/types'
import { canvasToBytes, loadPdf, renderPageToCanvas } from './pdfjs'
import { NOTE_SIZE, TEXT_ASCENT, TEXT_LINE, localToUser, visualFrame } from './geom'
import { dataUrlToBytes, hexToRgb01, normalizeImage } from './util'

export type Progress = (done: number, total: number, label?: string) => void

export async function openDoc(bytes: Uint8Array, password?: string): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { password, updateMetadata: false, ignoreEncryption: false })
}

export async function saveDoc(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: true })
}

const color = (hex: string) => {
  const [r, g, b] = hexToRgb01(hex)
  return rgb(r, g, b)
}

/** Strip characters the standard 14 fonts can't encode so drawText never throws. */
function safeText(font: PDFFont, text: string): string {
  const supported = new Set(font.getCharacterSet())
  return Array.from(text)
    .map((ch) => {
      if (ch === '\n') return ch
      const cp = ch.codePointAt(0)!
      if (supported.has(cp)) return ch
      const ascii = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
      return ascii && supported.has(ascii.codePointAt(0)!) ? ascii : '?'
    })
    .join('')
}

const normRot = (r: number) => ((r % 360) + 360) % 360

// ---------------------------------------------------------------------------
// Opening helpers

/** Produce an unencrypted copy so the editor can work on it; the password is re-applied on save. */
export async function decrypt(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const doc = await openDoc(bytes, password)
  return saveDoc(doc)
}

/** True when pdf-lib can open the file without a password (encrypted-for-permissions files fail here). */
export async function needsNormalizing(bytes: Uint8Array): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    return doc.isEncrypted
  } catch {
    return false
  }
}

/** Remove /Text (sticky note) annotations; Quire imports them as editable notes instead. */
export async function stripNoteAnnots(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await openDoc(bytes)
  for (const page of doc.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    for (let i = annots.size() - 1; i >= 0; i--) {
      const ref = annots.get(i)
      const dict = doc.context.lookup(ref)
      if (dict instanceof PDFDict) {
        const sub = dict.get(PDFName.of('Subtype'))
        const parent = dict.lookup(PDFName.of('Parent'))
        const isNotePopup =
          sub === PDFName.of('Popup') && parent instanceof PDFDict && parent.get(PDFName.of('Subtype')) === PDFName.of('Text')
        if (sub === PDFName.of('Text') || isNotePopup) annots.remove(i)
      }
    }
  }
  return saveDoc(doc)
}

// ---------------------------------------------------------------------------
// Page operations

export async function rotatePages(bytes: Uint8Array, indices: number[], delta: number): Promise<Uint8Array> {
  const doc = await openDoc(bytes)
  const pages = doc.getPages()
  for (const i of indices) pages[i].setRotation(degrees(normRot(pages[i].getRotation().angle + delta)))
  return saveDoc(doc)
}

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const

/**
 * Rebuild the page list in the given order. Indices may repeat (duplicate) or be omitted (delete).
 * The page tree is flattened into a single /Kids array (pdf-lib corrupts its tree if you remove
 * every page and re-insert them), so inherited attributes are first copied onto each page.
 */
export async function reorderPages(bytes: Uint8Array, order: number[]): Promise<Uint8Array> {
  if (!order.length) throw new Error('A PDF needs at least one page')
  const doc = await openDoc(bytes)
  const ctx = doc.context
  const pages = doc.getPages()
  for (const p of pages) {
    for (const key of INHERITABLE) {
      const name = PDFName.of(key)
      if (!p.node.get(name)) {
        const v = p.node.getInheritableAttribute(name)
        if (v) p.node.set(name, v)
      }
    }
  }
  const used = new Set<number>()
  const dupIdx = order.filter((i) => (used.has(i) ? true : (used.add(i), false)))
  const copies = dupIdx.length ? await doc.copyPages(doc, dupIdx) : []
  used.clear()
  let c = 0
  const next = order.map((i) => (used.has(i) ? copies[c++] : (used.add(i), pages[i])))

  const rootRef = doc.catalog.get(PDFName.of('Pages')) as PDFRef
  const root = doc.catalog.Pages()
  const kids = PDFArray.withContext(ctx)
  for (const p of next) {
    p.node.set(PDFName.of('Parent'), rootRef)
    kids.push(p.ref)
  }
  root.set(PDFName.of('Kids'), kids)
  root.set(PDFName.of('Count'), PDFNumber.of(next.length))
  return saveDoc(doc)
}

export async function insertBlankPage(bytes: Uint8Array, at: number, size?: [number, number]): Promise<Uint8Array> {
  const doc = await openDoc(bytes)
  const ref = doc.getPages()[Math.min(at, doc.getPageCount() - 1)] ?? doc.getPages()[0]
  const dims: [number, number] = size ?? (ref ? [ref.getWidth(), ref.getHeight()] : [612, 792])
  doc.insertPage(at, dims)
  return saveDoc(doc)
}

export async function insertPdf(bytes: Uint8Array, other: Uint8Array, at: number): Promise<{ bytes: Uint8Array; count: number }> {
  const doc = await openDoc(bytes)
  const src = await openDoc(other)
  const pages = await doc.copyPages(src, src.getPageIndices())
  pages.forEach((p, i) => doc.insertPage(at + i, p))
  return { bytes: await saveDoc(doc), count: pages.length }
}

export async function extractPages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const src = await openDoc(bytes)
  const out = await PDFDocument.create()
  const pages = await out.copyPages(src, indices)
  pages.forEach((p) => out.addPage(p))
  return saveDoc(out)
}

export async function mergePdfs(files: Uint8Array[], onProgress?: Progress): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (let i = 0; i < files.length; i++) {
    onProgress?.(i, files.length)
    const src = await openDoc(files[i])
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((p) => out.addPage(p))
  }
  onProgress?.(files.length, files.length)
  return saveDoc(out)
}

export async function cropPages(
  bytes: Uint8Array,
  indices: number[],
  m: { top: number; right: number; bottom: number; left: number }
): Promise<Uint8Array> {
  const doc = await openDoc(bytes)
  const pages = doc.getPages()
  for (const i of indices) {
    const page = pages[i]
    const box = page.getCropBox()
    const f = visualFrame(box, page.getRotation().angle)
    const [x1, y1] = f.toUser(m.left, m.bottom)
    const [x2, y2] = f.toUser(f.vw - m.right, f.vh - m.top)
    const x = Math.min(x1, x2)
    const y = Math.min(y1, y2)
    const w = Math.abs(x2 - x1)
    const h = Math.abs(y2 - y1)
    if (w < 10 || h < 10) throw new Error('Margins are larger than the page')
    page.setCropBox(x, y, w, h)
  }
  return saveDoc(doc)
}

// ---------------------------------------------------------------------------
// Annotations → page content

async function drawAnnot(doc: PDFDocument, page: PDFPage, a: Annot, font: PDFFont, imageCache: Map<string, unknown>) {
  const opacity = a.opacity ?? 1
  switch (a.kind) {
    case 'markup':
      for (const r of a.rects) {
        if (a.style === 'highlight') {
          page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: color(a.color), opacity, blendMode: BlendMode.Multiply })
        } else {
          const t = Math.max(0.8, r.h * 0.07)
          const y = a.style === 'underline' ? r.y + t : r.y + r.h * 0.45
          page.drawLine({ start: { x: r.x, y }, end: { x: r.x + r.w, y }, thickness: t, color: color(a.color), opacity })
        }
      }
      break
    case 'rect':
      page.drawRectangle({
        x: a.x,
        y: a.y,
        width: a.w,
        height: a.h,
        borderColor: color(a.color),
        borderWidth: a.strokeWidth,
        borderOpacity: opacity,
        color: a.fill ? color(a.fill) : undefined,
        opacity: a.fill ? opacity : undefined
      })
      break
    case 'ellipse':
      page.drawEllipse({
        x: a.x + a.w / 2,
        y: a.y + a.h / 2,
        xScale: a.w / 2,
        yScale: a.h / 2,
        borderColor: color(a.color),
        borderWidth: a.strokeWidth,
        borderOpacity: opacity,
        color: a.fill ? color(a.fill) : undefined,
        opacity: a.fill ? opacity : undefined
      })
      break
    case 'line':
    case 'arrow': {
      const opts = { thickness: a.strokeWidth, color: color(a.color), opacity, lineCap: LineCapStyle.Round }
      page.drawLine({ start: { x: a.x1, y: a.y1 }, end: { x: a.x2, y: a.y2 }, ...opts })
      if (a.kind === 'arrow') {
        const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1)
        const len = Math.max(10, a.strokeWidth * 4)
        for (const s of [-1, 1]) {
          const t = ang + Math.PI - s * 0.5
          page.drawLine({ start: { x: a.x2, y: a.y2 }, end: { x: a.x2 + len * Math.cos(t), y: a.y2 + len * Math.sin(t) }, ...opts })
        }
      }
      break
    }
    case 'ink': {
      if (!a.points.length) break
      // drawSvgPath flips y (SVG is y-down), so feed it negated y with the origin at 0,0.
      const d = a.points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${(-p[1]).toFixed(2)}`).join(' ')
      page.drawSvgPath(a.points.length === 1 ? d + ' l0.01 0' : d, {
        x: 0,
        y: 0,
        borderColor: color(a.color),
        borderWidth: a.strokeWidth,
        borderOpacity: opacity,
        borderLineCap: LineCapStyle.Round
      })
      break
    }
    case 'text': {
      const lines = safeText(font, a.text).split('\n')
      lines.forEach((line, i) => {
        const [x, y] = localToUser(a, 0, a.size * (TEXT_ASCENT + i * TEXT_LINE))
        page.drawText(line, { x, y, size: a.size, font, color: color(a.color), opacity, rotate: degrees(a.rot) })
      })
      break
    }
    case 'image': {
      let img = imageCache.get(a.src) as Awaited<ReturnType<PDFDocument['embedPng']>> | undefined
      if (!img) {
        const { bytes, mime } = dataUrlToBytes(a.src)
        const norm = await normalizeImage(bytes, mime)
        img = norm.type === 'png' ? await doc.embedPng(norm.bytes) : await doc.embedJpg(norm.bytes)
        imageCache.set(a.src, img)
      }
      const [x, y] = localToUser(a, 0, a.h)
      page.drawImage(img, { x, y, width: a.w, height: a.h, opacity, rotate: degrees(a.rot) })
      break
    }
    case 'note': {
      const corners = [localToUser(a, 0, 0), localToUser(a, NOTE_SIZE, NOTE_SIZE)]
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      const [r, g, b] = hexToRgb01(a.color)
      const annot = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        Contents: PDFHexString.fromText(a.text),
        T: PDFHexString.fromText(a.author ?? 'Quire'),
        Name: 'Comment',
        C: [r, g, b],
        F: 4,
        Open: false
      })
      page.node.addAnnot(doc.context.register(annot))
      break
    }
    case 'redact':
      // Handled by applyRedactions after everything else is baked.
      break
  }
}

export async function bakeAnnotations(bytes: Uint8Array, pageIds: string[], annots: Annot[]): Promise<Uint8Array> {
  const drawable = annots.filter((a) => a.kind !== 'redact')
  if (!drawable.length) return bytes
  const doc = await openDoc(bytes)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = doc.getPages()
  const cache = new Map<string, unknown>()
  for (const a of drawable) {
    const idx = pageIds.indexOf(a.page)
    if (idx < 0) continue
    await drawAnnot(doc, pages[idx], a, font, cache)
  }
  return saveDoc(doc)
}

/**
 * True redaction: each affected page is rasterized with black boxes burned in, then the original
 * page (text, vectors, images, annotations) is replaced, so nothing under the box survives.
 */
export async function applyRedactions(bytes: Uint8Array, byPage: Map<number, Rect[]>, onProgress?: Progress): Promise<Uint8Array> {
  if (!byPage.size) return bytes
  const pdf = await loadPdf(bytes)
  const doc = await openDoc(bytes)
  let done = 0
  for (const [index, rects] of byPage) {
    onProgress?.(done++, byPage.size, 'Redacting')
    const p = await pdf.getPage(index + 1)
    const scale = 2.5
    const canvas = await renderPageToCanvas(p, scale, 0, 'print')
    const vp = p.getViewport({ scale, rotation: 0 })
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#000'
    for (const r of rects) {
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle([r.x, r.y, r.x + r.w, r.y + r.h])
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
    }
    const img = await doc.embedJpg(await canvasToBytes(canvas, 'image/jpeg', 0.92))
    const old = doc.getPage(index)
    const [vx0, vy0, vx1, vy1] = p.view
    const fresh = doc.insertPage(index, [vx1 - vx0, vy1 - vy0])
    fresh.drawImage(img, { x: 0, y: 0, width: vx1 - vx0, height: vy1 - vy0 })
    fresh.setRotation(old.getRotation())
    doc.removePage(index + 1)
  }
  pdf.destroy()
  onProgress?.(byPage.size, byPage.size)
  return saveDoc(doc)
}

export interface ExportOptions {
  pageIds: string[]
  annots: Annot[]
  password?: string
  onProgress?: Progress
}

/** Produce the final file: bake annotations, burn in redactions, and re-encrypt if needed. */
export async function exportPdf(bytes: Uint8Array, opts: ExportOptions): Promise<Uint8Array> {
  let out = await bakeAnnotations(bytes, opts.pageIds, opts.annots)
  const redactions = new Map<number, Rect[]>()
  for (const a of opts.annots) {
    if (a.kind !== 'redact') continue
    const idx = opts.pageIds.indexOf(a.page)
    if (idx < 0) continue
    if (!redactions.has(idx)) redactions.set(idx, [])
    redactions.get(idx)!.push({ x: a.x, y: a.y, w: a.w, h: a.h })
  }
  out = await applyRedactions(out, redactions, opts.onProgress)
  if (opts.password) out = await encrypt(out, { userPassword: opts.password, ownerPassword: opts.password })
  return out
}

// ---------------------------------------------------------------------------
// Stamping: watermark, header/footer, OCR text layer

export interface WatermarkOptions {
  text: string
  size: number
  color: string
  opacity: number
  angle: number
  layout: 'center' | 'tile'
  bold: boolean
  pages: number[]
}

export async function addWatermark(bytes: Uint8Array, o: WatermarkOptions): Promise<Uint8Array> {
  const doc = await openDoc(bytes)
  const font = await doc.embedFont(o.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica)
  const text = safeText(font, o.text)
  const tw = font.widthOfTextAtSize(text, o.size)
  const th = o.size * 0.7
  const pages = doc.getPages()
  const a = (o.angle * Math.PI) / 180
  for (const i of o.pages) {
    const page = pages[i]
    const f = visualFrame(page.getCropBox(), page.getRotation().angle)
    const stamp = (cx: number, cy: number) => {
      // Offset from the text's center back to its baseline origin, rotated by the visual angle.
      const ox = cx - (Math.cos(a) * tw) / 2 + (Math.sin(a) * th) / 2
      const oy = cy - (Math.sin(a) * tw) / 2 - (Math.cos(a) * th) / 2
      const [x, y] = f.toUser(ox, oy)
      page.drawText(text, { x, y, size: o.size, font, color: color(o.color), opacity: o.opacity, rotate: degrees(o.angle + f.rot) })
    }
    if (o.layout === 'center') {
      stamp(f.vw / 2, f.vh / 2)
    } else {
      const stepX = tw * Math.abs(Math.cos(a)) + o.size * 3
      const stepY = tw * Math.abs(Math.sin(a)) + o.size * 3
      let row = 0
      for (let cy = stepY / 2; cy < f.vh + stepY; cy += stepY, row++) {
        for (let cx = (row % 2 ? stepX / 2 : 0); cx < f.vw + stepX; cx += stepX) stamp(cx, cy)
      }
    }
  }
  return saveDoc(doc)
}

export interface HeaderFooterOptions {
  /** Slots: tl, tc, tr, bl, bc, br. Tokens: {page} {total} {date} {name} */
  slots: Partial<Record<'tl' | 'tc' | 'tr' | 'bl' | 'bc' | 'br', string>>
  size: number
  color: string
  margin: number
  startAt: number
  pages: number[]
  name: string
}

export async function addHeaderFooter(bytes: Uint8Array, o: HeaderFooterOptions): Promise<Uint8Array> {
  const doc = await openDoc(bytes)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = doc.getPages()
  const total = o.pages.length
  const date = new Date().toLocaleDateString()
  o.pages.forEach((pi, n) => {
    const page = pages[pi]
    const f = visualFrame(page.getCropBox(), page.getRotation().angle)
    for (const [slot, tpl] of Object.entries(o.slots)) {
      if (!tpl?.trim()) continue
      const text = safeText(
        font,
        tpl
          .replace(/\{page\}/g, String(n + o.startAt))
          .replace(/\{total\}/g, String(total + o.startAt - 1))
          .replace(/\{date\}/g, date)
          .replace(/\{name\}/g, o.name)
      )
      const tw = font.widthOfTextAtSize(text, o.size)
      const vx = slot[1] === 'l' ? o.margin : slot[1] === 'c' ? (f.vw - tw) / 2 : f.vw - o.margin - tw
      const vy = slot[0] === 't' ? f.vh - o.margin - o.size * 0.75 : o.margin
      const [x, y] = f.toUser(vx, vy)
      page.drawText(text, { x, y, size: o.size, font, color: color(o.color), rotate: degrees(f.rot) })
    }
  })
  return saveDoc(doc)
}

export interface OcrWord {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Add an invisible, selectable text layer from OCR words (pixel coords from an unrotated render at `scale`). */
export async function addTextLayer(bytes: Uint8Array, pagesWords: Map<number, { words: OcrWord[]; scale: number }>): Promise<Uint8Array> {
  const doc = await openDoc(bytes)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = doc.getPages()
  for (const [pi, { words, scale }] of pagesWords) {
    const page = pages[pi]
    const box = page.getCropBox()
    for (const w of words) {
      const text = safeText(font, w.text).trim()
      if (!text) continue
      const width = (w.x1 - w.x0) / scale
      const height = (w.y1 - w.y0) / scale
      const natural = font.widthOfTextAtSize(text, height) || 1
      const size = Math.max(2, Math.min(height * 3, (height * width) / natural))
      page.drawText(text, {
        x: box.x + w.x0 / scale,
        y: box.y + box.height - w.y1 / scale + height * 0.15,
        size,
        font,
        renderMode: TextRenderingMode.Invisible
      })
    }
  }
  return saveDoc(doc)
}

// ---------------------------------------------------------------------------
// Security & metadata

export interface EncryptOptions {
  userPassword?: string
  ownerPassword?: string
  permissions?: {
    printing?: boolean
    modifying?: boolean
    copying?: boolean
    annotating?: boolean
    fillingForms?: boolean
    documentAssembly?: boolean
  }
}

export async function encrypt(bytes: Uint8Array, o: EncryptOptions): Promise<Uint8Array> {
  const doc = await openDoc(bytes)
  const p = o.permissions
  doc.encrypt({
    userPassword: o.userPassword ?? '',
    ownerPassword: o.ownerPassword || o.userPassword || crypto.randomUUID(),
    permissions: p
      ? {
          printing: p.printing ? 'highResolution' : false,
          modifying: p.modifying,
          copying: p.copying,
          annotating: p.annotating,
          fillingForms: p.fillingForms,
          contentAccessibility: true,
          documentAssembly: p.documentAssembly
        }
      : undefined
  })
  return doc.save({ useObjectStreams: false })
}

export interface Metadata {
  title: string
  author: string
  subject: string
  keywords: string
  creator: string
  producer: string
  created?: string
  modified?: string
}

export async function getMetadata(bytes: Uint8Array): Promise<Metadata> {
  const doc = await openDoc(bytes)
  const d = (x?: Date) => (x ? x.toLocaleString() : undefined)
  return {
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    subject: doc.getSubject() ?? '',
    keywords: doc.getKeywords() ?? '',
    creator: doc.getCreator() ?? '',
    producer: doc.getProducer() ?? '',
    created: d(doc.getCreationDate()),
    modified: d(doc.getModificationDate())
  }
}

export async function setMetadata(bytes: Uint8Array, m: Metadata): Promise<Uint8Array> {
  const doc = await openDoc(bytes)
  doc.setTitle(m.title)
  doc.setAuthor(m.author)
  doc.setSubject(m.subject)
  doc.setKeywords(m.keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean))
  doc.setCreator(m.creator)
  doc.setProducer(m.producer)
  doc.setModificationDate(new Date())
  return saveDoc(doc)
}

// ---------------------------------------------------------------------------
// Forms

export interface FormField {
  name: string
  type: 'text' | 'checkbox' | 'dropdown' | 'radio' | 'list' | 'signature' | 'other'
  value: string | boolean | string[]
  options?: string[]
  multiline?: boolean
  readOnly: boolean
}

export async function getFormFields(bytes: Uint8Array): Promise<FormField[]> {
  const doc = await openDoc(bytes)
  const form = doc.getForm()
  return form.getFields().map((f): FormField => {
    const base = { name: f.getName(), readOnly: f.isReadOnly() }
    if (f instanceof PDFTextField) return { ...base, type: 'text', value: f.getText() ?? '', multiline: f.isMultiline() }
    if (f instanceof PDFCheckBox) return { ...base, type: 'checkbox', value: f.isChecked() }
    if (f instanceof PDFDropdown) return { ...base, type: 'dropdown', value: f.getSelected()[0] ?? '', options: f.getOptions() }
    if (f instanceof PDFOptionList) return { ...base, type: 'list', value: f.getSelected(), options: f.getOptions() }
    if (f instanceof PDFRadioGroup) return { ...base, type: 'radio', value: f.getSelected() ?? '', options: f.getOptions() }
    if (f instanceof PDFSignature) return { ...base, type: 'signature', value: '' }
    return { ...base, type: 'other', value: '' }
  })
}

export async function fillForm(bytes: Uint8Array, values: Record<string, string | boolean | string[]>): Promise<Uint8Array> {
  const doc = await openDoc(bytes)
  const form = doc.getForm()
  for (const [name, v] of Object.entries(values)) {
    const f = form.getFieldMaybe(name)
    if (!f || f.isReadOnly()) continue
    if (f instanceof PDFTextField) f.setText(String(v))
    else if (f instanceof PDFCheckBox) (v ? f.check() : f.uncheck())
    else if (f instanceof PDFDropdown) v ? f.select(String(v)) : f.clear()
    else if (f instanceof PDFOptionList) Array.isArray(v) && v.length ? f.select(v) : f.clear()
    else if (f instanceof PDFRadioGroup) v ? f.select(String(v)) : f.clear()
  }
  try {
    form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica))
  } catch {
    /* some exotic fields have no appearance to regenerate */
  }
  return saveDoc(doc)
}

/** Flatten form fields into static page content. */
export async function flattenForm(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await openDoc(bytes)
  const form = doc.getForm()
  try {
    form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica))
  } catch {
    /* ignore */
  }
  form.flatten()
  return saveDoc(doc)
}

// ---------------------------------------------------------------------------
// Conversion

export interface ImagesToPdfOptions {
  pageSize: 'fit' | 'a4' | 'letter'
  orientation: 'auto' | 'portrait' | 'landscape'
  margin: number
}

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const

export async function imagesToPdf(
  images: { bytes: Uint8Array; mime: string }[],
  o: ImagesToPdfOptions,
  onProgress?: Progress
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < images.length; i++) {
    onProgress?.(i, images.length)
    const norm = await normalizeImage(images[i].bytes, images[i].mime)
    const img = norm.type === 'png' ? await doc.embedPng(norm.bytes) : await doc.embedJpg(norm.bytes)
    if (o.pageSize === 'fit') {
      const w = norm.width * 0.75 + o.margin * 2
      const h = norm.height * 0.75 + o.margin * 2
      doc.addPage([w, h]).drawImage(img, { x: o.margin, y: o.margin, width: norm.width * 0.75, height: norm.height * 0.75 })
      continue
    }
    let [pw, ph]: readonly number[] = PAGE_SIZES[o.pageSize]
    const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && norm.width > norm.height)
    if (landscape) [pw, ph] = [ph, pw]
    const page = doc.addPage([pw, ph])
    const s = Math.min((pw - o.margin * 2) / norm.width, (ph - o.margin * 2) / norm.height)
    const w = norm.width * s
    const h = norm.height * s
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h })
  }
  onProgress?.(images.length, images.length)
  return saveDoc(doc)
}

// ---------------------------------------------------------------------------
// Compression: re-encode embedded raster images, keep text and vectors intact.

export interface CompressPreset {
  maxDim: number
  quality: number
}

export const COMPRESS_PRESETS: Record<'light' | 'balanced' | 'strong', CompressPreset> = {
  light: { maxDim: 2600, quality: 0.85 },
  balanced: { maxDim: 1800, quality: 0.7 },
  strong: { maxDim: 1100, quality: 0.5 }
}

function nameOf(v: unknown): string | undefined {
  if (v instanceof PDFName) return v.decodeText()
  if (v instanceof PDFArray && v.size() === 1) return nameOf(v.get(0))
  return undefined
}

export async function compressPdf(
  bytes: Uint8Array,
  preset: CompressPreset,
  onProgress?: Progress
): Promise<{ bytes: Uint8Array; images: number; recompressed: number }> {
  const doc = await openDoc(bytes)
  const ctx = doc.context
  const candidates: [PDFRef, PDFRawStream][] = []
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) candidates.push([ref, obj])
  }
  let recompressed = 0
  for (let i = 0; i < candidates.length; i++) {
    onProgress?.(i, candidates.length, 'Optimizing images')
    const [ref, stream] = candidates[i]
    const dict = stream.dict
    try {
      const filter = nameOf(dict.get(PDFName.of('Filter')))
      const width = (dict.get(PDFName.of('Width')) as PDFNumber | undefined)?.asNumber() ?? 0
      const height = (dict.get(PDFName.of('Height')) as PDFNumber | undefined)?.asNumber() ?? 0
      const bpc = (dict.get(PDFName.of('BitsPerComponent')) as PDFNumber | undefined)?.asNumber() ?? 8
      let cs = dict.lookup(PDFName.of('ColorSpace'))
      let comps = 0
      const csName = nameOf(cs)
      if (csName === 'DeviceRGB') comps = 3
      else if (csName === 'DeviceGray') comps = 1
      else if (cs instanceof PDFArray && nameOf(cs.get(0)) === 'ICCBased') {
        const icc = ctx.lookup(cs.get(1))
        const n = icc instanceof PDFRawStream ? (icc.dict.get(PDFName.of('N')) as PDFNumber | undefined)?.asNumber() : undefined
        comps = n === 3 || n === 1 ? n : 0
        cs = undefined
      }
      if (!comps || width < 64 || height < 64) continue
      if (dict.get(PDFName.of('ImageMask')) || dict.get(PDFName.of('Mask')) || dict.get(PDFName.of('Decode'))) continue

      let source: CanvasImageSource
      if (filter === 'DCTDecode') {
        source = await createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }))
      } else if (filter === 'FlateDecode' && bpc === 8 && !dict.get(PDFName.of('DecodeParms'))) {
        const raw = decodePDFRawStream(stream).decode()
        if (raw.length < width * height * comps) continue
        const rgba = new Uint8ClampedArray(width * height * 4)
        for (let p = 0, q = 0; p < width * height; p++, q += comps) {
          rgba[p * 4] = raw[q]
          rgba[p * 4 + 1] = raw[comps === 3 ? q + 1 : q]
          rgba[p * 4 + 2] = raw[comps === 3 ? q + 2 : q]
          rgba[p * 4 + 3] = 255
        }
        source = await createImageBitmap(new ImageData(rgba, width, height))
      } else continue

      const s = Math.min(1, preset.maxDim / Math.max(width, height))
      const nw = Math.max(1, Math.round(width * s))
      const nh = Math.max(1, Math.round(height * s))
      const canvas = document.createElement('canvas')
      canvas.width = nw
      canvas.height = nh
      const c2d = canvas.getContext('2d')!
      c2d.imageSmoothingQuality = 'high'
      c2d.drawImage(source, 0, 0, nw, nh)
      if ('close' in source) (source as ImageBitmap).close()
      const jpeg = await canvasToBytes(canvas, 'image/jpeg', preset.quality)
      if (jpeg.length >= stream.contents.length * 0.95) continue

      const nd = dict.clone(ctx)
      nd.set(PDFName.of('Width'), PDFNumber.of(nw))
      nd.set(PDFName.of('Height'), PDFNumber.of(nh))
      nd.set(PDFName.of('Filter'), PDFName.of('DCTDecode'))
      nd.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8))
      nd.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'))
      nd.set(PDFName.of('Length'), PDFNumber.of(jpeg.length))
      nd.delete(PDFName.of('DecodeParms'))
      ctx.assign(ref, PDFRawStream.of(nd, jpeg))
      recompressed++
    } catch {
      /* leave images we can't decode untouched */
    }
  }
  onProgress?.(candidates.length, candidates.length)
  return { bytes: await saveDoc(doc), images: candidates.length, recompressed }
}

// ---------------------------------------------------------------------------
// Digital signatures: placeholder + appearance. The main process fills in the actual CMS signature.

/** Bytes reserved for the CMS signature (certificate chain + optional RFC 3161 timestamp token). */
export const SIGNATURE_BYTES = 20000
const BYTE_RANGE_PLACEHOLDER = '**********'

export interface SignaturePlaceholderOptions {
  name: string
  reason?: string
  location?: string
  /** When the document is already signed, append an incremental update so earlier signatures stay valid. */
  incremental: boolean
  visible?: { pageIndex: number; rect: Rect; image?: string | null; dateText: string }
}

function fitSize(font: PDFFont, text: string, maxWidth: number, maxSize: number): number {
  const w = font.widthOfTextAtSize(text, 1) || 1
  return Math.max(4, Math.min(maxSize, maxWidth / w))
}

async function signatureAppearance(doc: PDFDocument, rot: number, o: SignaturePlaceholderOptions, v: NonNullable<SignaturePlaceholderOptions['visible']>) {
  const lw = rot % 180 ? v.rect.h : v.rect.w
  const lh = rot % 180 ? v.rect.w : v.rect.h
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const script = await doc.embedFont(StandardFonts.HelveticaBoldOblique)
  const fonts = { F1: regular, F2: bold, F3: script }
  const ops = []
  const pad = Math.min(lw, lh) * 0.08
  const split = lw * 0.48
  const text = (key: keyof typeof fonts, str: string, x: number, y: number, size: number, rgb: [number, number, number]) => {
    const f = fonts[key]
    ops.push(beginText(), setFontAndSize(key, size), setFillingRgbColor(...rgb), moveText(x, y), showText(f.encodeText(safeText(f, str))), endText())
  }
  const xobjects: Record<string, PDFRef> = {}
  if (v.image) {
    const { bytes, mime } = dataUrlToBytes(v.image)
    const norm = await normalizeImage(bytes, mime)
    const img = norm.type === 'png' ? await doc.embedPng(norm.bytes) : await doc.embedJpg(norm.bytes)
    const maxW = split - pad * 2
    const maxH = lh - pad * 2
    const s = Math.min(maxW / norm.width, maxH / norm.height)
    const w = norm.width * s
    const h = norm.height * s
    xobjects.Im1 = img.ref
    ops.push(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, pad + (maxW - w) / 2, (lh - h) / 2), drawObject('Im1'), popGraphicsState())
  } else {
    const size = fitSize(script, o.name, split - pad * 2, lh * 0.45)
    text('F3', o.name, pad, (lh - size * 0.7) / 2, size, [0.12, 0.16, 0.45])
  }
  const lines: [keyof typeof fonts, string][] = [
    ['F1', 'Digitally signed by'],
    ['F2', o.name],
    ['F1', `Date: ${v.dateText}`],
    ...(o.reason ? ([['F1', `Reason: ${o.reason}`]] as [keyof typeof fonts, string][]) : []),
    ...(o.location ? ([['F1', `Location: ${o.location}`]] as [keyof typeof fonts, string][]) : [])
  ]
  const colW = lw - split - pad
  const lineH = (lh - pad * 2) / lines.length
  const size = Math.min(lineH * 0.8, ...lines.map(([k, str]) => fitSize(fonts[k], str, colW, 14)))
  lines.forEach(([k, str], i) => text(k, str, split, lh - pad - lineH * (i + 0.5) - size * 0.35, size, [0.1, 0.1, 0.14]))

  const t = (rot * Math.PI) / 180
  const c = Math.round(Math.cos(t))
  const sn = Math.round(Math.sin(t))
  const ap = doc.context.formXObject(ops, {
    BBox: [0, 0, lw, lh],
    Matrix: [c, sn, -sn, c, 0, 0],
    Resources: { Font: { F1: regular.ref, F2: bold.ref, F3: script.ref }, XObject: xobjects }
  })
  return doc.context.register(ap)
}

export async function addSignaturePlaceholder(bytes: Uint8Array, o: SignaturePlaceholderOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, forIncrementalUpdate: o.incremental })
  const ctx = doc.context
  const form = doc.getForm()
  const existing = form.getFields().filter((f) => f instanceof PDFSignature).length
  const placeholder = PDFName.of(BYTE_RANGE_PLACEHOLDER)
  const sig = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [PDFNumber.of(0), placeholder, placeholder, placeholder],
    Contents: PDFHexString.of('0'.repeat(SIGNATURE_BYTES * 2)),
    M: PDFString.fromDate(new Date()),
    Name: PDFHexString.fromText(o.name),
    ...(o.reason ? { Reason: PDFHexString.fromText(o.reason) } : {}),
    ...(o.location ? { Location: PDFHexString.fromText(o.location) } : {})
  })
  const sigRef = ctx.register(sig)
  // Walk the page tree directly: doc.getPage() normalizes the page (wrapping its content streams),
  // which would show up as a content change to earlier signatures.
  const pageRefs: PDFRef[] = []
  doc.catalog.Pages().traverse((_node, ref) => {
    if (_node instanceof PDFPageLeaf) pageRefs.push(ref)
  })
  const pageRef = pageRefs[o.visible?.pageIndex ?? 0]
  const leaf = ctx.lookup(pageRef) as PDFPageLeaf
  const page = { ref: pageRef, node: leaf, getRotation: () => ({ angle: leaf.Rotate()?.asNumber() ?? 0 }) }
  let rect = [0, 0, 0, 0]
  let apRef: PDFRef | undefined
  if (o.visible) {
    const r = o.visible.rect
    rect = [r.x, r.y, r.x + r.w, r.y + r.h]
    apRef = await signatureAppearance(doc, normRot(page.getRotation().angle), o, o.visible)
  }
  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: rect,
    V: sigRef,
    T: PDFHexString.fromText(`Signature${existing + 1}`),
    F: 132,
    P: page.ref,
    ...(apRef ? { AP: { N: apRef } } : {})
  })
  const widgetRef = ctx.register(widget)
  page.node.addAnnot(widgetRef)
  form.acroForm.addField(widgetRef)
  form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3))
  // Object streams would compress the signature dictionary, so they're off for signed output.
  return o.incremental ? doc.commit({ useObjectStreams: false }) : doc.save({ useObjectStreams: false, updateFieldAppearances: false })
}

/** Fast check for signature dictionaries without decoding the whole file. */
export function hasSignatures(bytes: Uint8Array): boolean {
  const needle = [47, 66, 121, 116, 101, 82, 97, 110, 103, 101] // "/ByteRange"
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    if (bytes[i] !== 47) continue
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}
