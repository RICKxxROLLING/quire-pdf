import { useEffect, useState } from 'react'
import { BadgeCheck, Download, KeyRound, MapPin, Plus, Trash2, Upload } from 'lucide-react'
import type { Doc } from '@/types'
import type { DigitalId } from '../../../preload'
import {
  closeDialog,
  confirmDialog,
  dropTab,
  exportBytes,
  openPaths,
  setSigDraft,
  setTool,
  toast,
  useStore,
  withBusy
} from '@/store'
import { Check, Field, Modal } from '@/components/ui'
import { addSignaturePlaceholder } from '@/lib/ops'
import { baseName } from '@/lib/util'

const REASONS = ['I approve this document', 'I am the author of this document', 'I have reviewed this document', 'I agree to the terms']

function signingDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const tz = `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${tz}`
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

export function DigitalSignDialog({ doc }: { doc: Doc }) {
  const draft = useStore((s) => s.sigDraft)
  const author = useStore((s) => s.author)
  const [ids, setIds] = useState<DigitalId[] | null>(null)
  const [mode, setMode] = useState<'pick' | 'create' | 'import'>('pick')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const saved: string[] = (() => {
    try {
      return JSON.parse(localStorage.getItem('quire.signatures') ?? '[]')
    } catch {
      return []
    }
  })()

  const reload = async () => {
    const list = await window.quire.signing.listIds()
    setIds(list)
    if (!list.length) setMode('create')
    else if (!list.some((x) => x.id === draft.idId)) setSigDraft({ idId: list[0].id })
  }
  useEffect(() => {
    reload()
  }, [])

  const placement = draft.placement?.docId === doc.id ? draft.placement : undefined
  const id = ids?.find((x) => x.id === draft.idId)
  const expired = id ? new Date(id.validTo) < new Date() : false
  const existing = doc.signatures?.length ?? 0
  const incremental = existing > 0 && !doc.dirty && !doc.password && !!doc.original

  const place = () => {
    closeDialog()
    setTool('sigbox')
    toast('Drag a box on the page where the signature should appear')
  }

  const sign = async () => {
    if (!id) return
    setError(null)
    if (existing && !incremental) {
      const r = await confirmDialog({
        title: 'Existing signatures will be removed',
        message: 'This document has unsaved changes, so its current signatures can no longer be kept. The signed copy will only contain your new signature.',
        ok: 'Continue',
        cancel: 'Cancel'
      })
      if (r !== 'ok') return
    }
    let failed: string | null = null
    const signed = await withBusy('Signing…', async () => {
      try {
        const base = incremental ? doc.original! : await exportBytes(doc.id, { keepPassword: false })
        const prepared = await addSignaturePlaceholder(base, {
          name: id.name,
          reason: draft.reason.trim() || undefined,
          location: draft.location.trim() || undefined,
          incremental,
          visible:
            draft.visible && placement
              ? { pageIndex: placement.page, rect: placement.rect, image: draft.image ?? null, dateText: signingDate() }
              : undefined
        })
        return await window.quire.signing.sign({ pdf: prepared, idId: id.id, password, timestamp: draft.timestamp })
      } catch (e) {
        // Electron prefixes IPC errors; keep only the human-readable part.
        failed = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        return undefined
      }
    })
    if (failed) return setError(failed)
    if (!signed) return
    const path = await window.quire.saveDialog(`${baseName(doc.name)} (signed).pdf`, signed)
    if (!path) return
    closeDialog()
    setSigDraft({ placement: undefined })
    const stale = useStore.getState().tabs.find((t) => t.path === path)
    if (stale) dropTab(stale.id)
    await openPaths([path])
    toast('Document signed', 'success', { label: 'Show in folder', run: () => window.quire.reveal(path) })
  }

  const canSign = !!id && !expired && !!password && (!draft.visible || !!placement)

  return (
    <Modal
      title="Digitally sign"
      subtitle="A certificate-based signature proves who signed and reveals any later changes."
      icon={BadgeCheck}
      color="#0ea5e9"
      wide
      onClose={closeDialog}
      footerLeft={
        mode === 'pick' && ids?.length ? (
          incremental ? (
            `Adds signature #${existing + 1}. Existing signatures stay valid.`
          ) : (
            'Signing finalizes the file. Later edits will show as changes.'
          )
        ) : undefined
      }
      footer={
        mode === 'pick' ? (
          <>
            <button className="btn" onClick={closeDialog}>
              Cancel
            </button>
            <button className="btn primary" disabled={!canSign} onClick={sign}>
              Sign & save…
            </button>
          </>
        ) : undefined
      }
    >
      {mode === 'create' && <CreateId onDone={(created) => (setSigDraft({ idId: created.id }), setMode('pick'), reload())} onCancel={ids?.length ? () => setMode('pick') : undefined} defaultName={author} />}
      {mode === 'import' && <ImportId onDone={(imported) => (setSigDraft({ idId: imported.id }), setMode('pick'), reload())} onCancel={() => setMode('pick')} />}
      {mode === 'pick' && ids && (
        <>
          <Field label="Digital ID">
            <div className="id-list">
              {ids.map((d) => {
                const exp = new Date(d.validTo) < new Date()
                return (
                  <div key={d.id} className={`id-card ${draft.idId === d.id ? 'on' : ''}`} onClick={() => setSigDraft({ idId: d.id })}>
                    <div className="id-ic">
                      <KeyRound size={16} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="t">{d.name}</div>
                      <div className="d">
                        {[d.email, d.selfSigned ? 'Self-signed' : `Issued by ${d.issuer}`, exp ? 'Expired' : `Valid until ${fmtDate(d.validTo)}`].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <button
                      className="icon-btn sm"
                      title="Back up this ID (.p12)"
                      onClick={async (e) => {
                        e.stopPropagation()
                        const p = await window.quire.signing.exportId(d.id)
                        if (p) toast('Digital ID exported', 'success', { label: 'Show', run: () => window.quire.reveal(p) })
                      }}
                    >
                      <Download size={14} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title="Remove"
                      onClick={async (e) => {
                        e.stopPropagation()
                        const r = await confirmDialog({
                          title: `Remove “${d.name}”?`,
                          message: "Quire's copy of this digital ID will be deleted. Documents you already signed stay valid. Export a backup first if you might need it again.",
                          ok: 'Remove',
                          danger: true
                        })
                        if (r !== 'ok') return
                        await window.quire.signing.removeId(d.id)
                        reload()
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn sm" onClick={() => setMode('create')}>
                <Plus size={13} /> Create new ID
              </button>
              <button className="btn sm" onClick={() => setMode('import')}>
                <Upload size={13} /> Import .p12 / .pfx
              </button>
            </div>
          </Field>

          <div className="row">
            <Field label="Reason">
              <input className="input" list="sig-reasons" value={draft.reason} onChange={(e) => setSigDraft({ reason: e.target.value })} />
              <datalist id="sig-reasons">
                {REASONS.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </Field>
            <Field label="Location (optional)">
              <input className="input" placeholder="e.g. Seattle, WA" value={draft.location} onChange={(e) => setSigDraft({ location: e.target.value })} />
            </Field>
          </div>

          <Field label="Appearance">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="segmented">
                <button className={draft.visible ? 'on' : ''} onClick={() => setSigDraft({ visible: true })}>
                  Visible on page
                </button>
                <button className={!draft.visible ? 'on' : ''} onClick={() => setSigDraft({ visible: false })}>
                  Invisible
                </button>
              </div>
              {draft.visible &&
                (placement ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-2)' }}>
                    <MapPin size={14} /> Page {placement.page + 1}, {Math.round(placement.rect.w)} × {Math.round(placement.rect.h)} pt
                    <button className="btn sm" onClick={place}>
                      Move
                    </button>
                  </span>
                ) : (
                  <button className="btn sm primary" onClick={place}>
                    <MapPin size={13} /> Place on page…
                  </button>
                ))}
            </div>
          </Field>
          {draft.visible && (
            <Field label="Show inside the signature box">
              <div className="sig-list">
                <div className={`sig-item ${!draft.image ? 'on' : ''}`} onClick={() => setSigDraft({ image: null })} style={{ fontStyle: 'italic', fontWeight: 700, color: '#1f2a73' }}>
                  {id?.name ?? 'Your name'}
                </div>
                {saved.map((src) => (
                  <div key={src} className={`sig-item ${draft.image === src ? 'on' : ''}`} onClick={() => setSigDraft({ image: src })}>
                    <img src={src} />
                  </div>
                ))}
              </div>
            </Field>
          )}

          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Digital ID password">
              <input
                className="input"
                type="password"
                value={password}
                placeholder="Required each time you sign"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canSign && sign()}
                style={error ? { borderColor: 'var(--danger)' } : undefined}
              />
            </Field>
            <div style={{ paddingBottom: 7 }}>
              <Check checked={draft.timestamp} onChange={(v) => setSigDraft({ timestamp: v })}>
                Add trusted timestamp (needs internet)
              </Check>
            </div>
          </div>
          {error && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</div>}
          {expired && <div className="note warn">This digital ID has expired. Create or import a new one to sign.</div>}
          {id?.selfSigned && (
            <div className="note">
              Self-signed IDs prove the document hasn't changed, but recipients' apps will show your identity as unverified until they choose to trust it. For a
              trusted green checkmark in Adobe Acrobat, import an ID from a certificate authority on Adobe's trust list.
            </div>
          )}
          {doc.password && <div className="note warn">This document is password-protected. The signed copy will be saved without the password.</div>}
        </>
      )}
    </Modal>
  )
}

function CreateId(props: { onDone: (d: DigitalId) => void; onCancel?: () => void; defaultName: string }) {
  const [name, setName] = useState(props.defaultName)
  const [email, setEmail] = useState('')
  const [org, setOrg] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = name.trim() && pw.length >= 6 && pw === pw2
  const create = async () => {
    setBusy(true)
    try {
      props.onDone(await window.quire.signing.createId({ name: name.trim(), email: email.trim() || undefined, org: org.trim() || undefined, password: pw }))
      toast('Digital ID created', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="note">
        Creates a self-signed digital ID stored on this computer and protected by your password. It's valid for 5 years. Back it up with the export button so you
        can sign on other devices.
      </div>
      <div className="row">
        <Field label="Full name">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email (optional)">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <Field label="Organization (optional)">
        <input className="input" value={org} onChange={(e) => setOrg(e.target.value)} />
      </Field>
      <div className="row">
        <Field label="Password (6+ characters)">
          <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label="Confirm password" hint={pw2 && pw !== pw2 ? "Passwords don't match" : undefined}>
          <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {props.onCancel && (
          <button className="btn" onClick={props.onCancel}>
            Back
          </button>
        )}
        <button className="btn primary" disabled={!ok || busy} onClick={create}>
          {busy ? 'Creating…' : 'Create digital ID'}
        </button>
      </div>
    </>
  )
}

function ImportId(props: { onDone: (d: DigitalId) => void; onCancel: () => void }) {
  const [path, setPath] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pick = async () => setPath(await window.quire.signing.pickIdFile())
  useEffect(() => {
    pick()
  }, [])
  const run = async () => {
    setError(null)
    try {
      props.onDone(await window.quire.signing.importId(path!, pw))
      toast('Digital ID imported', 'success')
    } catch (e) {
      setError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  return (
    <>
      <Field label="Digital ID file">
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" readOnly value={path ?? ''} placeholder="Choose a .p12 or .pfx file" />
          <button className="btn" onClick={pick}>
            Browse…
          </button>
        </div>
      </Field>
      <Field label="Password for this file">
        <input className="input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && path && run()} />
      </Field>
      {error && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</div>}
      <div className="note">Quire keeps an encrypted copy of the file. Your password is never stored — you'll enter it each time you sign.</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={props.onCancel}>
          Back
        </button>
        <button className="btn primary" disabled={!path || !pw} onClick={run}>
          Import
        </button>
      </div>
    </>
  )
}
