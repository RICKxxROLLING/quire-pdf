// Test/debug hook, only loaded when the app is launched with QUIRE_DEBUG=1.
import * as store from './store'
import * as ops from './lib/ops'
import * as text from './lib/text'
import * as pdf from './lib/pdfjs'
import * as ocr from './lib/ocr'
;(window as unknown as { __q: unknown }).__q = { ...store, ops, text, pdf, ocr }
