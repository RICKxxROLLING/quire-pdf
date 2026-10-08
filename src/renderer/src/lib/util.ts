export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '')
}

export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6)
  const n = parseInt(full, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function rgb01ToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('')
}

/**
 * Parse a page range string like "1-3, 5, 8-" (1-based, inclusive) into 0-based indices.
 * Supports "all", "odd", "even". Returns indices in the order written, de-duplicated.
 */
export function parseRanges(input: string, total: number): number[] {
  const s = input.trim().toLowerCase()
  if (!s || s === 'all') return Array.from({ length: total }, (_, i) => i)
  if (s === 'odd') return Array.from({ length: total }, (_, i) => i).filter((i) => i % 2 === 0)
  if (s === 'even') return Array.from({ length: total }, (_, i) => i).filter((i) => i % 2 === 1)
  const out: number[] = []
  const seen = new Set<number>()
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/)
    let a: number, b: number
    if (m) {
      a = m[1] ? parseInt(m[1]) : 1
      b = m[2] ? parseInt(m[2]) : total
    } else if (/^\d+$/.test(part)) {
      a = b = parseInt(part)
    } else {
      throw new Error(`Couldn't understand “${part}”`)
    }
    if (a < 1 || b < 1 || a > total || b > total) throw new Error(`Page ${Math.max(a, b)} is out of range (1–${total})`)
    const step = a <= b ? 1 : -1
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) {
      if (!seen.has(i - 1)) {
        seen.add(i - 1)
        out.push(i - 1)
      }
    }
  }
  return out
}

/** Split a range string into groups: "1-3, 4-6" → [[0,1,2],[3,4,5]]. */
export function parseRangeGroups(input: string, total: number): number[][] {
  return input
    .split(/[,;]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => parseRanges(p, total))
}

export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const [head, body] = dataUrl.split(',')
  const mime = head.match(/data:([^;]+)/)?.[1] ?? 'application/octet-stream'
  const bin = atob(body)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { bytes, mime }
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.readAsDataURL(new Blob([bytes], { type: mime }))
  })
}

export function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[
      ext ?? ''
    ] ?? 'application/octet-stream'
  )
}

/** Load any browser-decodable image and normalize to PNG or JPEG bytes that pdf-lib can embed. */
export async function normalizeImage(
  bytes: Uint8Array,
  mime: string
): Promise<{ bytes: Uint8Array; type: 'png' | 'jpg'; width: number; height: number }> {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }))
  const { width, height } = bmp
  if (mime === 'image/png' || mime === 'image/jpeg') {
    bmp.close()
    return { bytes, type: mime === 'image/png' ? 'png' : 'jpg', width, height }
  }
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  return { bytes: dataUrlToBytes(c.toDataURL('image/png')).bytes, type: 'png', width, height }
}

export const isMac = navigator.userAgent.includes('Mac')
export const modKey = isMac ? '⌘' : 'Ctrl'
