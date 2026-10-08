/**
 * Certificate-based PDF signing and verification (PKCS#7 / CMS detached, adbe.pkcs7.detached).
 * Runs in the main process so private keys never enter the renderer.
 */
import forge from 'node-forge'
import { X509Certificate, createHash, generateKeyPairSync, randomBytes, randomUUID, verify as cryptoVerify } from 'crypto'
import { rootCertificates } from 'tls'
import { app, net } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

const A = forge.asn1
const U = A.Class.UNIVERSAL
const T = A.Type
const OID_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14'
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4'
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5'
export const DEFAULT_TSA = 'http://timestamp.digicert.com'

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

// ---------------------------------------------------------------------------
// Digital ID store (PKCS#12 files in userData, password-protected; passwords are never stored)

const idDir = () => join(app.getPath('userData'), 'digital-ids')
const indexFile = () => join(idDir(), 'index.json')

export async function listIds(): Promise<DigitalId[]> {
  try {
    const list = JSON.parse(await fs.readFile(indexFile(), 'utf8')) as DigitalId[]
    const out: DigitalId[] = []
    for (const d of list) {
      try {
        await fs.access(d.file)
        out.push(d)
      } catch {
        /* file removed */
      }
    }
    return out
  } catch {
    return []
  }
}

async function saveIndex(list: DigitalId[]): Promise<void> {
  await fs.mkdir(idDir(), { recursive: true })
  await fs.writeFile(indexFile(), JSON.stringify(list, null, 2))
}

function attr(cert: forge.pki.Certificate, field: 'subject' | 'issuer', name: string): string | undefined {
  const a = cert[field].getField(name)
  return a ? String(a.value) : undefined
}

function describe(cert: forge.pki.Certificate, file: string, id: string): DigitalId {
  const selfSigned = cert.isIssuer(cert)
  return {
    id,
    name: attr(cert, 'subject', 'CN') ?? 'Unnamed',
    email: attr(cert, 'subject', 'E') ?? attr(cert, 'subject', 'emailAddress'),
    org: attr(cert, 'subject', 'O'),
    issuer: selfSigned ? 'Self-signed' : (attr(cert, 'issuer', 'CN') ?? attr(cert, 'issuer', 'O') ?? 'Unknown issuer'),
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    selfSigned,
    file
  }
}

interface LoadedId {
  key: forge.pki.rsa.PrivateKey
  cert: forge.pki.Certificate
  chain: forge.pki.Certificate[]
}

function loadP12(der: Buffer, password: string): LoadedId {
  let p12: forge.pkcs12.Pkcs12Pfx
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(A.fromDer(der.toString('binary')), password)
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    if (/mac could not be verified|invalid password|decrypt/i.test(msg)) throw new Error('Incorrect password for this digital ID.')
    if (/OID is not RSA/i.test(msg)) throw new Error('Only RSA digital IDs are supported (this one uses a different key type).')
    throw new Error(`This file isn't a readable digital ID: ${msg}`)
  }
  const bags = (type: string) => p12.getBags({ bagType: type })[type] ?? []
  const keyBag = bags(forge.pki.oids.pkcs8ShroudedKeyBag)[0] ?? bags(forge.pki.oids.keyBag)[0]
  const key = keyBag?.key as forge.pki.rsa.PrivateKey | undefined
  if (!key) throw new Error('This digital ID has no private key (only RSA keys are supported).')
  const certs = bags(forge.pki.oids.certBag)
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => !!c)
  const cert = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(key.n))
  if (!cert) throw new Error("This digital ID's certificate doesn't match its private key.")
  return { key, cert, chain: certs.filter((c) => c !== cert) }
}

export async function importId(path: string, password: string): Promise<DigitalId> {
  const der = await fs.readFile(path)
  const { cert } = loadP12(der, password)
  const id = randomUUID()
  const file = join(idDir(), `${id}.p12`)
  await fs.mkdir(idDir(), { recursive: true })
  await fs.writeFile(file, der)
  const info = describe(cert, file, id)
  await saveIndex([...(await listIds()), info])
  return info
}

export async function createId(o: { name: string; email?: string; org?: string; password: string; years?: number }): Promise<DigitalId> {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  const key = forge.pki.privateKeyFromPem(pair.privateKey)
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(pair.publicKey)
  cert.serialNumber = '01' + randomBytes(15).toString('hex')
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + (o.years ?? 5))
  const subject: forge.pki.CertificateField[] = [{ shortName: 'CN', value: o.name }]
  if (o.org) subject.push({ shortName: 'O', value: o.org })
  if (o.email) subject.push({ name: 'emailAddress', value: o.email })
  cert.setSubject(subject)
  cert.setIssuer(subject)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true },
    { name: 'subjectKeyIdentifier' }
  ])
  cert.sign(key, forge.md.sha256.create())
  // 3DES keeps the .p12 importable by older Windows and Acrobat versions.
  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], o.password, { algorithm: '3des', friendlyName: o.name })
  const id = randomUUID()
  const file = join(idDir(), `${id}.p12`)
  await fs.mkdir(idDir(), { recursive: true })
  await fs.writeFile(file, Buffer.from(A.toDer(p12).getBytes(), 'binary'))
  const info = describe(cert, file, id)
  await saveIndex([...(await listIds()), info])
  return info
}

export async function removeId(id: string): Promise<void> {
  const list = await listIds()
  const d = list.find((x) => x.id === id)
  if (d) await fs.rm(d.file, { force: true })
  await saveIndex(list.filter((x) => x.id !== id))
}

// ---------------------------------------------------------------------------
// Signing

export async function signPdf(o: { pdf: Uint8Array; idId: string; password: string; timestamp: boolean; tsaUrl?: string }): Promise<Uint8Array> {
  const d = (await listIds()).find((x) => x.id === o.idId)
  if (!d) throw new Error('Digital ID not found.')
  const loaded = loadP12(await fs.readFile(d.file), o.password)
  const now = new Date()
  if (now > loaded.cert.validity.notAfter) throw new Error('This digital ID has expired.')

  const buf = Buffer.from(o.pdf)
  const latin = buf.toString('latin1')
  // The placeholder written by the renderer: the last one is the signature we're filling.
  const brMatches = [...latin.matchAll(/\/ByteRange\s*\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/g)]
  const contentsMatches = [...latin.matchAll(/<(0{2000,})>/g)]
  const br = brMatches[brMatches.length - 1]
  const cm = contentsMatches[contentsMatches.length - 1]
  if (!br || !cm) throw new Error('Signature placeholder not found.')
  const start = cm.index!
  const end = start + cm[0].length
  const range = [0, start, end, buf.length - end]
  const brText = `/ByteRange [${range.join(' ')}]`
  if (brText.length > br[0].length) throw new Error('Byte range placeholder too small.')
  buf.write(brText.padEnd(br[0].length, ' '), br.index!, 'latin1')

  const data = Buffer.concat([buf.subarray(0, start), buf.subarray(end)])
  const cms = await createCms(data, loaded, o.timestamp ? (o.tsaUrl ?? DEFAULT_TSA) : null)
  const hex = cms.toString('hex')
  if (hex.length > cm[1].length) throw new Error('Signature is larger than the reserved space.')
  buf.write(hex.padEnd(cm[1].length, '0'), start + 1, 'latin1')
  return new Uint8Array(buf)
}

async function createCms(data: Buffer, id: LoadedId, tsaUrl: string | null): Promise<Buffer> {
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(data.toString('binary'))
  p7.addCertificate(id.cert)
  for (const c of id.chain) p7.addCertificate(c)
  p7.addSigner({
    key: id.key,
    certificate: id.cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() as unknown as string }
    ]
  })
  p7.sign({ detached: true })
  const asn1 = p7.toAsn1()
  if (tsaUrl) await addTimestamp(asn1, tsaUrl)
  return Buffer.from(A.toDer(asn1).getBytes(), 'binary')
}

const children = (n: forge.asn1.Asn1) => n.value as forge.asn1.Asn1[]

function signerInfoOf(contentInfo: forge.asn1.Asn1): forge.asn1.Asn1 {
  const signedData = children(children(contentInfo)[1])[0]
  const sd = children(signedData)
  return children(sd[sd.length - 1])[0]
}

/** RFC 3161: timestamp the signature value and attach the token as an unsigned attribute. */
async function addTimestamp(contentInfo: forge.asn1.Asn1, url: string): Promise<void> {
  const si = signerInfoOf(contentInfo)
  const sig = children(si).find((n) => n.tagClass === U && n.type === T.OCTETSTRING)!
  const imprint = createHash('sha256').update(Buffer.from(sig.value as string, 'binary')).digest()
  const nonce = randomBytes(8)
  nonce[0] &= 0x7f
  const req = A.create(U, T.SEQUENCE, true, [
    A.create(U, T.INTEGER, false, A.integerToDer(1).getBytes()),
    A.create(U, T.SEQUENCE, true, [
      A.create(U, T.SEQUENCE, true, [A.create(U, T.OID, false, A.oidToDer(forge.pki.oids.sha256).getBytes()), A.create(U, T.NULL, false, '')]),
      A.create(U, T.OCTETSTRING, false, imprint.toString('binary'))
    ]),
    A.create(U, T.INTEGER, false, nonce.toString('binary')),
    A.create(U, T.BOOLEAN, false, String.fromCharCode(0xff))
  ])
  let res: Response
  try {
    res = await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: Buffer.from(A.toDer(req).getBytes(), 'binary')
    })
  } catch {
    throw new Error("Couldn't reach the timestamp server. Check your connection, or sign without a timestamp.")
  }
  if (!res.ok) throw new Error(`The timestamp server returned an error (${res.status}).`)
  const resp = A.fromDer(Buffer.from(await res.arrayBuffer()).toString('binary'))
  const statusNode = children(children(resp)[0])[0]
  const status = A.derToInteger(forge.util.createBuffer(statusNode.value as string))
  const token = children(resp)[1]
  if (status > 1 || !token) throw new Error('The timestamp server rejected the request.')
  children(si).push(
    A.create(A.Class.CONTEXT_SPECIFIC, 1, true, [
      A.create(U, T.SEQUENCE, true, [A.create(U, T.OID, false, A.oidToDer(OID_TIMESTAMP_TOKEN).getBytes()), A.create(U, T.SET, true, [token])])
    ])
  )
}

// ---------------------------------------------------------------------------
// Verification

export interface SignatureInfo {
  index: number
  fieldName?: string
  signer: string
  email?: string
  issuer: string
  reason?: string
  location?: string
  signedAt?: string
  timestamp?: string
  /** The signed bytes hash correctly and the signature verifies with the signer's key. */
  intact: boolean
  /** The signature covers the whole file (nothing appended afterwards). */
  coversWholeFile: boolean
  /** Chains to a root in the system trust bundle. */
  trusted: boolean
  trustAnchor?: string
  selfSigned: boolean
  certValidAtSigning: boolean
  certValidTo?: string
  error?: string
}

const HASHES: Record<string, string> = {
  [forge.pki.oids.sha1]: 'sha1',
  [forge.pki.oids.sha256]: 'sha256',
  [forge.pki.oids.sha384]: 'sha384',
  [forge.pki.oids.sha512]: 'sha512'
}

function pdfString(dictText: string, key: string): string | undefined {
  const m = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f\\s]*>)`).exec(dictText)
  if (!m) return undefined
  const raw = m[1]
  let bytes: Buffer
  if (raw.startsWith('<')) bytes = Buffer.from(raw.slice(1, -1).replace(/\s+/g, ''), 'hex')
  else {
    const s = raw
      .slice(1, -1)
      .replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) =>
        /^[0-7]+$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e
      )
    bytes = Buffer.from(s, 'latin1')
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  return bytes.toString('latin1')
}

function pdfDate(s?: string): string | undefined {
  const m = s && /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(s)
  if (!m) return undefined
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', z, oh = '00', om = '00'] = m
  const tz = !z || z === 'Z' ? 'Z' : `${z}${oh}:${om}`
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${tz}`)
  return isNaN(+date) ? undefined : date.toISOString()
}

let roots: X509Certificate[] | null = null
const trustRoots = () => (roots ??= rootCertificates.map((p) => new X509Certificate(p)))

const cn = (dn: string) => /CN=([^\n,]+)/.exec(dn)?.[1] ?? /O=([^\n,]+)/.exec(dn)?.[1] ?? dn

export function verifySignatures(pdf: Uint8Array): SignatureInfo[] {
  const buf = Buffer.from(pdf)
  const latin = buf.toString('latin1')
  const out: SignatureInfo[] = []
  let index = 0
  for (const m of latin.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
    const [a, b, c, d] = m.slice(1, 5).map(Number)
    const objStart = latin.lastIndexOf(' obj', m.index!)
    const objEnd = latin.indexOf('endobj', m.index!)
    const dict = latin.slice(objStart < 0 ? Math.max(0, m.index! - 4000) : objStart, objEnd < 0 ? m.index! + 4000 : objEnd)
    const info: SignatureInfo = {
      index: index++,
      signer: pdfString(dict, 'Name') ?? 'Unknown signer',
      issuer: '',
      reason: pdfString(dict, 'Reason'),
      location: pdfString(dict, 'Location'),
      signedAt: pdfDate(pdfString(dict, 'M')),
      intact: false,
      coversWholeFile: c + d === buf.length,
      trusted: false,
      selfSigned: false,
      certValidAtSigning: false
    }
    out.push(info)
    try {
      if (latin[b] !== '<' || latin[c - 1] !== '>') throw new Error('Malformed signature contents')
      const der = Buffer.from(latin.slice(b + 1, c - 1), 'hex')
      const cms = A.fromDer(der.toString('binary'), { parseAllBytes: false } as never)
      const signedData = children(children(cms)[1])[0]
      const sd = children(signedData)
      const certNode = sd.find((n) => n.tagClass === A.Class.CONTEXT_SPECIFIC && n.type === 0)
      const certs = (certNode ? children(certNode) : []).map((n) => new X509Certificate(Buffer.from(A.toDer(n).getBytes(), 'binary')))
      const si = children(children(sd[sd.length - 1])[0])
      const sid = si[1]
      const serial = Buffer.from((children(sid)[1].value as string) ?? '', 'binary').toString('hex').replace(/^0+/, '').toUpperCase()
      const signerCert = certs.find((x) => x.serialNumber.replace(/^0+/, '').toUpperCase() === serial) ?? certs[0]
      if (!signerCert) throw new Error('No signer certificate')
      const digestOid = A.derToOid(forge.util.createBuffer(children(si[2])[0].value as string))
      const hashName = HASHES[digestOid] ?? 'sha256'
      const authAttrs = si.find((n) => n.tagClass === A.Class.CONTEXT_SPECIFIC && n.type === 0)
      const unauth = si.find((n) => n.tagClass === A.Class.CONTEXT_SPECIFIC && n.type === 1)
      const sigValue = Buffer.from(si.find((n) => n.tagClass === U && n.type === T.OCTETSTRING)!.value as string, 'binary')

      const content = Buffer.concat([buf.subarray(a, a + b), buf.subarray(c, c + d)])
      const digest = createHash(hashName).update(content).digest()
      let signedBytes: Buffer
      let digestOk: boolean
      if (authAttrs) {
        const attrs = children(authAttrs)
        const md = attrs.find((x) => A.derToOid(forge.util.createBuffer(children(x)[0].value as string)) === OID_MESSAGE_DIGEST)
        const mdValue = md ? Buffer.from(children(children(md)[1])[0].value as string, 'binary') : Buffer.alloc(0)
        digestOk = mdValue.equals(digest)
        const st = attrs.find((x) => A.derToOid(forge.util.createBuffer(children(x)[0].value as string)) === OID_SIGNING_TIME)
        if (st) {
          const t = children(children(st)[1])[0]
          const date = t.type === T.UTCTIME ? A.utcTimeToDate(t.value as string) : A.generalizedTimeToDate(t.value as string)
          info.signedAt ??= date.toISOString()
        }
        // Authenticated attributes are signed as a SET (tag 0x31), not the implicit [0] tag.
        signedBytes = Buffer.from(A.toDer(authAttrs).getBytes(), 'binary')
        signedBytes[0] = 0x31
      } else {
        digestOk = true
        signedBytes = content
      }
      const sigOk = cryptoVerify(hashName, signedBytes, signerCert.publicKey, sigValue)
      info.intact = digestOk && sigOk
      if (!digestOk) info.error = 'The document was changed after it was signed.'
      else if (!sigOk) info.error = 'The signature does not match the certificate.'

      if (unauth) {
        for (const at of children(unauth)) {
          if (A.derToOid(forge.util.createBuffer(children(at)[0].value as string)) !== OID_TIMESTAMP_TOKEN) continue
          try {
            const token = children(children(at)[1])[0]
            const tsd = children(children(children(token)[1])[0])
            const eContent = children(tsd[2])
            const tst = A.fromDer(children(eContent[1])[0].value as string)
            const gen = children(tst).find((n) => n.tagClass === U && n.type === T.GENERALIZEDTIME)
            if (gen) info.timestamp = A.generalizedTimeToDate(gen.value as string).toISOString()
          } catch {
            /* unreadable timestamp */
          }
        }
      }

      info.signer = cn(signerCert.subject) || info.signer
      info.email = /emailAddress=([^\n,]+)/.exec(signerCert.subject)?.[1]
      info.certValidTo = new Date(signerCert.validTo).toISOString()
      const when = new Date(info.timestamp ?? info.signedAt ?? Date.now())
      info.certValidAtSigning = when >= new Date(signerCert.validFrom) && when <= new Date(signerCert.validTo)
      // checkIssued() requires keyCertSign, which end-entity certs rightly lack, so compare names and verify the self-signature.
      info.selfSigned = signerCert.subject === signerCert.issuer && safeVerify(signerCert, signerCert)
      info.issuer = info.selfSigned ? 'Self-signed' : cn(signerCert.issuer)

      // Walk the chain to a trusted root.
      let cur = signerCert
      for (let depth = 0; depth < 8; depth++) {
        const root = trustRoots().find((r) => cur.checkIssued(r) && safeVerify(cur, r))
        if (root || trustRoots().some((r) => r.fingerprint256 === cur.fingerprint256)) {
          info.trusted = true
          info.trustAnchor = cn((root ?? cur).subject)
          break
        }
        const parent = certs.find((x) => x !== cur && cur.checkIssued(x) && safeVerify(cur, x))
        if (!parent) break
        cur = parent
      }
    } catch (e) {
      info.error = `Couldn't read this signature: ${(e as Error).message}`
    }
  }
  return out
}

function safeVerify(child: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return child.verify(issuer.publicKey)
  } catch {
    return false
  }
}
