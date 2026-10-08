import { createWorker } from 'tesseract.js'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { renderPageToCanvas } from './pdfjs'
import type { OcrWord } from './ops'

const base = new URL('./vendor/tesseract/', document.baseURI).href

export const OCR_LANGS: { code: string; name: string }[] = [
  { code: 'eng', name: 'English' },
  { code: 'spa', name: 'Spanish' },
  { code: 'fra', name: 'French' },
  { code: 'deu', name: 'German' },
  { code: 'ita', name: 'Italian' },
  { code: 'por', name: 'Portuguese' },
  { code: 'nld', name: 'Dutch' },
  { code: 'pol', name: 'Polish' },
  { code: 'rus', name: 'Russian' },
  { code: 'tur', name: 'Turkish' },
  { code: 'chi_sim', name: 'Chinese (Simplified)' },
  { code: 'jpn', name: 'Japanese' },
  { code: 'kor', name: 'Korean' }
]

export interface OcrResult {
  pages: Map<number, { words: OcrWord[]; scale: number }>
  text: string
  confidence: number
}

export async function runOcr(
  pdf: PDFDocumentProxy,
  pages: number[],
  lang: string,
  dpi: number,
  onProgress: (fraction: number, label: string) => void,
  signal: { cancelled: boolean }
): Promise<OcrResult> {
  onProgress(0, 'Loading OCR engine…')
  let pageIdx = 0
  const worker = await createWorker(lang, 1, {
    workerPath: base + 'worker.min.js',
    corePath: base,
    workerBlobURL: false,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress((pageIdx + m.progress) / pages.length, `Recognizing page ${pageIdx + 1} of ${pages.length}`)
      else if (m.status.includes('language')) onProgress(0, m.progress < 1 ? 'Downloading language data…' : 'Preparing…')
    }
  })
  const out = new Map<number, { words: OcrWord[]; scale: number }>()
  const texts: string[] = []
  let confSum = 0
  try {
    for (; pageIdx < pages.length; pageIdx++) {
      if (signal.cancelled) break
      const pi = pages[pageIdx]
      const page = await pdf.getPage(pi + 1)
      const scale = dpi / 72
      const canvas = await renderPageToCanvas(page, scale, 0, 'print')
      const { data } = await worker.recognize(canvas)
      const words = (data.words ?? []).map((w) => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }))
      out.set(pi, { words, scale })
      texts.push(data.text.trim())
      confSum += data.confidence
    }
  } finally {
    await worker.terminate()
  }
  return { pages: out, text: texts.join('\n\n\f'), confidence: pages.length ? confSum / pages.length : 0 }
}
