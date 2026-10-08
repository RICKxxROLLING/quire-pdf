import { exportBytes, getDoc, setBusy, toast } from '@/store'
import { canvasToBytes, loadPdf, renderPageToCanvas } from './pdfjs'

/** Print via a hidden iframe of rendered page images, so annotations and redactions print exactly as saved. */
export async function printDoc(id: string): Promise<void> {
  const doc = getDoc(id)
  if (!doc) return
  const urls: string[] = []
  try {
    setBusy('Preparing to print…', 0)
    const bytes = await exportBytes(id, { keepPassword: false })
    const pdf = await loadPdf(bytes)
    const sizes: { w: number; h: number }[] = []
    for (let i = 1; i <= pdf.numPages; i++) {
      setBusy('Preparing to print…', (i - 1) / pdf.numPages)
      const page = await pdf.getPage(i)
      const canvas = await renderPageToCanvas(page, 150 / 72, undefined, 'print')
      const vp = page.getViewport({ scale: 1 })
      sizes.push({ w: vp.width, h: vp.height })
      urls.push(URL.createObjectURL(new Blob([await canvasToBytes(canvas, 'image/jpeg', 0.92)], { type: 'image/jpeg' })))
    }
    await pdf.destroy()
    setBusy(null)

    const iframe = document.createElement('iframe')
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    document.body.appendChild(iframe)
    const d = iframe.contentDocument!
    const first = sizes[0] ?? { w: 612, h: 792 }
    d.open()
    d.write(`<!doctype html><html><head><title>${doc.name.replace(/</g, '&lt;')}</title><style>
      @page { size: ${first.w}pt ${first.h}pt; margin: 0 }
      html, body { margin: 0; padding: 0 }
      img { display: block; width: 100vw; height: 100vh; object-fit: contain; page-break-after: always; break-after: page }
      img:last-child { page-break-after: auto; break-after: auto }
    </style></head><body>${urls.map((u) => `<img src="${u}">`).join('')}</body></html>`)
    d.close()
    await Promise.all(Array.from(d.images).map((img) => (img.complete ? Promise.resolve() : new Promise((r) => (img.onload = img.onerror = r)))))
    iframe.contentWindow!.focus()
    iframe.contentWindow!.print()
    setTimeout(() => {
      iframe.remove()
      urls.forEach((u) => URL.revokeObjectURL(u))
    }, 60_000)
  } catch (e) {
    setBusy(null)
    urls.forEach((u) => URL.revokeObjectURL(u))
    toast(`Print failed: ${(e as Error).message}`, 'error')
  }
}
