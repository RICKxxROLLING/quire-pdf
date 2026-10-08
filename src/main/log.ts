/**
 * Plain-text log at <userData>/logs/main.log (%APPDATA%\Quire\logs on Windows) for diagnosing problems on
 * users' machines, such as a window that never appears.
 */
import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'

let file: string | null = null

function logFile(): string {
  if (!file) {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'main.log')
    try {
      if (statSync(file).size > 1_000_000) renameSync(file, file + '.old')
    } catch {
      /* no log yet */
    }
  }
  return file
}

export function log(...parts: unknown[]): void {
  try {
    const text = parts
      .map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === 'string' ? p : JSON.stringify(p)))
      .join(' ')
    appendFileSync(logFile(), `[${new Date().toISOString()}] ${text}\n`)
  } catch {
    /* logging must never break the app */
  }
}
