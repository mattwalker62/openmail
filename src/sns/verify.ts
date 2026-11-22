/**
 * Amazon SNS message signature verification, ported from Dollop's webhooks.ts with one tightening:
 * the signing certificate must come from `sns.<region>.amazonaws.com` exactly. Dollop accepted any
 * `sns.*.amazonaws.com` host, and some amazonaws.com hosts serve files other people control.
 */

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
  Signature?: string;
  SignatureVersion?: string;
  SigningCertURL?: string;
}

const SNS_HOST = /^sns\.[a-z]{2}(-gov)?-[a-z]+-\d\.amazonaws\.com$/;

export function isValidSnsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && SNS_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

export function isValidSigningCertUrl(url: string): boolean {
  if (!isValidSnsUrl(url)) return false;
  const { pathname } = new URL(url);
  return pathname.startsWith('/SimpleNotificationService-') && pathname.endsWith('.pem');
}

function stringToSign(m: SnsMessage): string {
  const fields =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const rec = m as unknown as Record<string, string | undefined>;
  return fields
    .filter((f) => rec[f] !== undefined)
    .map((f) => `${f}\n${rec[f]}\n`)
    .join('');
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Minimal DER walk to the certificate's SubjectPublicKeyInfo (WebCrypto imports SPKI, not X.509).
function readTlv(bytes: Uint8Array, offset: number) {
  const first = bytes[offset + 1]!;
  let length = first;
  let header = 2;
  if (first & 0x80) {
    const n = first & 0x7f;
    length = 0;
    for (let i = 0; i < n; i++) length = (length << 8) | bytes[offset + 2 + i]!;
    header = 2 + n;
  }
  return { tag: bytes[offset]!, start: offset + header, end: offset + header + length };
}

function spkiFromPem(pem: string): Uint8Array {
  const bytes = b64(pem.replace(/-----[^-]+-----|\s/g, ''));
  const cert = readTlv(bytes, 0);
  const tbs = readTlv(bytes, cert.start);
  let cursor = tbs.start;
  if (bytes[cursor] === 0xa0) cursor = readTlv(bytes, cursor).end; // version
  for (let i = 0; i < 5; i++) cursor = readTlv(bytes, cursor).end; // serial, sigAlg, issuer, validity, subject
  const spki = readTlv(bytes, cursor);
  if (spki.tag !== 0x30) throw new Error('certificate has no subject public key info');
  return bytes.slice(cursor, spki.end);
}

const certCache = new Map<string, CryptoKey>();

export async function verifySnsSignature(m: SnsMessage): Promise<boolean> {
  if (!m.Signature || !m.SigningCertURL || !m.SignatureVersion) return false;
  if (!isValidSigningCertUrl(m.SigningCertURL)) return false;
  const hash = m.SignatureVersion === '2' ? 'SHA-256' : 'SHA-1';
  const cacheKey = `${hash}:${m.SigningCertURL}`;
  try {
    let key = certCache.get(cacheKey);
    if (!key) {
      const res = await fetch(m.SigningCertURL);
      if (!res.ok) return false;
      key = await crypto.subtle.importKey('spki', spkiFromPem(await res.text()), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
      certCache.set(cacheKey, key);
    }
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(m.Signature), new TextEncoder().encode(stringToSign(m)));
  } catch {
    return false;
  }
}
