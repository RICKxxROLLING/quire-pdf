import type { PDFDocumentProxy } from 'pdfjs-dist'
import { renderPageToCanvas } from './pdfjs'

/** Small LRU of rendered thumbnails keyed by pdf instance + page + width, with limited concurrency. */
const cache = new Map<string, ImageBitmap>()
const docKeys = new WeakMap<PDFDocumentProxy, string>()
let docCounter = 0
const MAX = 400
let running = 0
const queue: (() => void)[] = []

const keyFor = (pdf: PDFDocumentProxy, index: number, width: number) => {
  let k = docKeys.get(pdf)
  if (!k) docKeys.set(pdf, (k = `d${++docCounter}`))
  return `${k}:${index}:${Math.round(width)}`
}

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      running++
      fn()
        .then(resolve, reject)
        .finally(() => {
          running--
          queue.shift()?.()
        })
    }
    if (running < 3) run()
    else queue.push(run)
  })
}

export function cachedThumb(pdf: PDFDocumentProxy, index: number, width: number): ImageBitmap | undefined {
  return cache.get(keyFor(pdf, index, width))
}

export async function renderThumb(pdf: PDFDocumentProxy, index: number, width: number): Promise<ImageBitmap> {
  const key = keyFor(pdf, index, width)
  const hit = cache.get(key)
  if (hit) return hit
  return schedule(async () => {
    const page = await pdf.getPage(index + 1)
    const vp = page.getViewport({ scale: 1 })
    const scale = (width * devicePixelRatio) / vp.width
    const canvas = await renderPageToCanvas(page, scale)
    const bmp = await createImageBitmap(canvas)
    cache.set(key, bmp)
    if (cache.size > MAX) {
      const first = cache.keys().next().value!
      cache.get(first)?.close()
      cache.delete(first)
    }
    return bmp
  })
}
