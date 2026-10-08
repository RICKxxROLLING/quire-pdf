import { BadgeCheck, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import type { Doc } from '@/types'
import type { SignatureInfo } from '../../../preload'
import { openDialog, setPanel } from '@/store'

type Level = 'valid' | 'warn' | 'invalid'

export function sigStatus(s: SignatureInfo): { level: Level; title: string; detail: string } {
  if (!s.intact) return { level: 'invalid', title: 'Invalid signature', detail: s.error ?? 'The signature could not be verified.' }
  const identity = s.trusted
    ? `Identity verified by ${s.trustAnchor}`
    : s.selfSigned
      ? 'Identity not verified (self-signed certificate)'
      : `Identity not verified (issuer “${s.issuer}” isn’t a trusted authority)`
  const level: Level = s.trusted && s.certValidAtSigning ? 'valid' : 'warn'
  const title = s.trusted ? 'Valid signature' : 'Valid signature, unverified signer'
  const later = s.coversWholeFile ? '' : ' Later revisions were added after this signature.'
  const cert = s.certValidAtSigning ? '' : ' The certificate was not valid at the signing time.'
  return { level, title, detail: identity + '.' + later + cert }
}

const ICONS = { valid: ShieldCheck, warn: ShieldAlert, invalid: ShieldX }
const COLORS = { valid: 'var(--success)', warn: '#d97706', invalid: 'var(--danger)' }
const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : undefined)

export function SignatureBanner({ doc }: { doc: Doc }) {
  const sigs = doc.signatures
  if (!sigs?.length) return null
  const levels = sigs.map((s) => sigStatus(s).level)
  const level: Level = levels.includes('invalid') ? 'invalid' : levels.includes('warn') ? 'warn' : 'valid'
  const Icon = ICONS[level]
  const names = [...new Set(sigs.map((s) => s.signer))].join(', ')
  const text =
    level === 'invalid'
      ? 'At least one signature is invalid.'
      : level === 'warn'
        ? 'The document is unchanged, but a signer’s identity isn’t verified.'
        : 'All signatures are valid.'
  return (
    <div className={`sig-banner ${level}`}>
      <Icon size={16} style={{ color: COLORS[level], flex: 'none' }} />
      <span>
        <b>Signed by {names}.</b> {text}
        {doc.dirty ? ' Saving your changes will invalidate the signatures.' : ''}
      </span>
      <button className="btn sm" onClick={() => setPanel('signatures')}>
        Details
      </button>
    </div>
  )
}

export function SignaturesPanel({ doc }: { doc: Doc }) {
  const sigs = doc.signatures
  return (
    <div style={{ paddingBottom: 16 }}>
      {!doc.original && <div className="panel-empty">This document has no digital signatures.</div>}
      {doc.original && !sigs && <div className="panel-empty">Checking signatures…</div>}
      {sigs?.map((s) => {
        const st = sigStatus(s)
        const Icon = ICONS[st.level]
        const rows: [string, string | undefined][] = [
          ['Signed', fmt(s.signedAt)],
          ['Timestamp', fmt(s.timestamp)],
          ['Reason', s.reason],
          ['Location', s.location],
          ['Issuer', s.issuer],
          ['Cert expires', fmt(s.certValidTo)]
        ]
        return (
          <div key={s.index} className="sig-card">
            <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
              <Icon size={20} style={{ color: COLORS[st.level], flex: 'none', marginTop: 1 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 620 }}>{s.signer}</div>
                {s.email && <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>{s.email}</div>}
                <div style={{ color: COLORS[st.level], fontWeight: 560, fontSize: 12, marginTop: 4 }}>{st.title}</div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.45 }}>{st.detail}</div>
            <dl>
              {rows
                .filter((r) => r[1])
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
            </dl>
          </div>
        )
      })}
      <div style={{ padding: '4px 12px' }}>
        <button className="btn" style={{ width: '100%' }} onClick={() => openDialog('digitalSign', doc.id)}>
          <BadgeCheck size={15} /> {sigs?.length ? 'Add a signature…' : 'Digitally sign…'}
        </button>
      </div>
    </div>
  )
}
