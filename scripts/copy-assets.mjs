// Copies runtime assets (pdf.js cmaps/fonts, Tesseract OCR engine) into the renderer's public dir.
import { cpSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const nm = 'node_modules'
const out = 'src/renderer/public/vendor'
mkdirSync(out, { recursive: true })

const copies = [
  [join(nm, 'pdfjs-dist/cmaps'), join(out, 'pdfjs/cmaps')],
  [join(nm, 'pdfjs-dist/standard_fonts'), join(out, 'pdfjs/standard_fonts')],
  [join(nm, 'tesseract.js/dist/worker.min.js'), join(out, 'tesseract/worker.min.js')],
  [join(nm, 'tesseract.js-core/tesseract-core-lstm.wasm.js'), join(out, 'tesseract/tesseract-core-lstm.wasm.js')],
  [join(nm, 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js'), join(out, 'tesseract/tesseract-core-simd-lstm.wasm.js')]
]
for (const [from, to] of copies) {
  if (!existsSync(from)) throw new Error(`Missing asset: ${from}`)
  cpSync(from, to, { recursive: true })
}
console.log('assets copied')
