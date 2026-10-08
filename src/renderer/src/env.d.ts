/// <reference types="vite/client" />
import type { QuireApi } from '../../preload'

declare global {
  interface Window {
    quire: QuireApi
  }
}
export {}
