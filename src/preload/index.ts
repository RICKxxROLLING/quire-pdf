import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { UpdateState } from '../main/updater'

export type { UpdateState }

export interface FileEntry {
  path: string
  name: string
  data: Uint8Array
  size: number
  modified: number
}

export interface DigitalId {
  id: string
  name: string
  email?: string
  org?: string
  issuer: string
  validFrom: string
  validTo: string
  selfSigned: boolean
  file: string
}

export interface SignatureInfo {
  index: number
  signer: string
  email?: string
  issuer: string
  reason?: string
  location?: string
  signedAt?: string
  timestamp?: string
  intact: boolean
  coversWholeFile: boolean
  trusted: boolean
  trustAnchor?: string
  selfSigned: boolean
  certValidAtSigning: boolean
  certValidTo?: string
  error?: string
}

export interface RecentEntry {
  path: string
  name: string
  modified: number
  size: number
}

const api = {
  debug: process.argv.includes('--quire-debug'),
  ready: (): Promise<{ platform: string; version: string; openPaths: string[] }> => ipcRenderer.invoke('app:ready'),
  confirmClose: (): Promise<void> => ipcRenderer.invoke('app:confirm-close'),
  setTheme: (t: 'light' | 'dark' | 'system'): Promise<boolean> => ipcRenderer.invoke('app:set-theme', t),
  openDialog: (opts?: { kind?: 'pdf' | 'image' | 'any'; multi?: boolean }): Promise<FileEntry[]> =>
    ipcRenderer.invoke('dialog:open', opts ?? {}),
  readFile: (path: string): Promise<FileEntry> => ipcRenderer.invoke('fs:read', path),
  saveDialog: (defaultName: string, data: Uint8Array, ext?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:save', { defaultName, data, ext }),
  writeFile: (path: string, data: Uint8Array): Promise<string> => ipcRenderer.invoke('fs:write', path, data),
  saveMany: (files: { name: string; data: Uint8Array }[]): Promise<string | null> =>
    ipcRenderer.invoke('dialog:save-many', files),
  getRecent: (): Promise<RecentEntry[]> => ipcRenderer.invoke('recent:get'),
  addRecent: (path: string): Promise<void> => ipcRenderer.invoke('recent:add', path),
  clearRecent: (): Promise<void> => ipcRenderer.invoke('recent:clear'),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  signing: {
    listIds: (): Promise<DigitalId[]> => ipcRenderer.invoke('sign:list-ids'),
    createId: (o: { name: string; email?: string; org?: string; password: string }): Promise<DigitalId> => ipcRenderer.invoke('sign:create-id', o),
    pickIdFile: (): Promise<string | null> => ipcRenderer.invoke('sign:pick-id-file'),
    importId: (path: string, password: string): Promise<DigitalId> => ipcRenderer.invoke('sign:import-id', path, password),
    removeId: (id: string): Promise<void> => ipcRenderer.invoke('sign:remove-id', id),
    exportId: (id: string): Promise<string | null> => ipcRenderer.invoke('sign:export-id', id),
    sign: (o: { pdf: Uint8Array; idId: string; password: string; timestamp: boolean }): Promise<Uint8Array> => ipcRenderer.invoke('sign:sign', o),
    verify: (pdf: Uint8Array): Promise<SignatureInfo[]> => ipcRenderer.invoke('sign:verify', pdf)
  },
  update: {
    get: (): Promise<UpdateState> => ipcRenderer.invoke('update:get'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    openPage: (): Promise<void> => ipcRenderer.invoke('update:open-page'),
    onState: (cb: (s: UpdateState) => void) => {
      const h = (_: unknown, s: UpdateState) => cb(s)
      ipcRenderer.on('update:state', h)
      return () => ipcRenderer.removeListener('update:state', h)
    }
  },
  onOpenPaths: (cb: (paths: string[]) => void) => {
    const h = (_: unknown, p: string[]) => cb(p)
    ipcRenderer.on('app:open-paths', h)
    return () => ipcRenderer.removeListener('app:open-paths', h)
  },
  onMenu: (cb: (cmd: string) => void) => {
    const h = (_: unknown, c: string) => cb(c)
    ipcRenderer.on('app:menu', h)
    return () => ipcRenderer.removeListener('app:menu', h)
  },
  onCloseRequest: (cb: () => void) => {
    const h = () => cb()
    ipcRenderer.on('app:close-request', h)
    return () => ipcRenderer.removeListener('app:close-request', h)
  }
}

export type QuireApi = typeof api
contextBridge.exposeInMainWorld('quire', api)
