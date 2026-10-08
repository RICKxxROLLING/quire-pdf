import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const base = new URL('./vendor/pdfjs/', document.baseURI).href

export class PasswordRequired extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? 'Incorrect password' : 'Password required')
  }
}

export async function loadPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    // pdf.js transfers the buffer to its worker, so always hand it a copy.
    data: bytes.slice(),
    password,
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    isEvalSupported: false,
    enableXfa: false
  })
  try {
    return await task.promise
  } catch (e: unknown) {
    const err = e as { name?: string; code?: number }
    if (err?.name === 'PasswordException') throw new PasswordRequired(err.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD)
    throw e
  }
}

/**
 * Render a page into a fresh canvas. `rotation` is absolute; omit to use the page's own.
 * Background jobs pass intent 'print': pdf.js paces 'display' renders with requestAnimationFrame,
 * which pauses whenever the window isn't painting (minimized or behind other windows).
 */
export async function renderPageToCanvas(
  page: PDFPageProxy,
  scale: number,
  rotation?: number,
  intent: 'display' | 'print' = 'display'
): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale, rotation: rotation ?? page.rotate })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const ctx = canvas.getContext('2d')!
  await page.render({ canvasContext: ctx, viewport, background: '#ffffff', intent }).promise
  return canvas
}

/**
 * Encode a canvas synchronously. (toBlob defers to idle time and can stall indefinitely while the
 * window is in the background, which would hang long-running saves.)
 */
export function canvasToBytes(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality = 0.9): Promise<Uint8Array> {
  const url = canvas.toDataURL(type, quality)
  const bin = atob(url.slice(url.indexOf(',') + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return Promise.resolve(out)
}

export { pdfjs }
export type { PDFDocumentProxy, PDFPageProxy }
