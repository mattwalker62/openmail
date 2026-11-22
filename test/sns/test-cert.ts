/**
 * Build a throwaway RSA key and a minimal X.509 certificate around its public key, at test time.
 * openmail's parser walks the certificate's DER structure to the SubjectPublicKeyInfo; trust in the
 * real thing comes from fetching it over TLS from sns.<region>.amazonaws.com, not from a chain. No
 * key material is ever committed.
 */
function der(tag: number, body: Uint8Array): Uint8Array {
  const len = body.length;
  const head =
    len < 0x80 ? [tag, len] : len < 0x100 ? [tag, 0x81, len] : [tag, 0x82, (len >> 8) & 0xff, len & 0xff];
  return new Uint8Array([...head, ...body]);
}
const seq = (...parts: Uint8Array[]) => der(0x30, new Uint8Array(parts.flatMap((p) => [...p])));
const int = (n: number) => der(0x02, new Uint8Array([n]));
const empty = () => seq();

export async function makeTestSigner(): Promise<{ certPem: string; sign: (data: string) => Promise<string> }> {
  const keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', keys.publicKey)) as ArrayBuffer);
  // tbsCertificate: [0] version, serial, signature alg, issuer, validity, subject, subjectPublicKeyInfo
  const tbs = seq(der(0xa0, int(2)), int(1), empty(), empty(), empty(), empty(), spki);
  const cert = seq(tbs, empty(), der(0x03, new Uint8Array([0])));
  const b64 = btoa(String.fromCharCode(...cert));
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  return {
    certPem,
    sign: async (data) => {
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(data));
      return btoa(String.fromCharCode(...new Uint8Array(sig)));
    },
  };
}
