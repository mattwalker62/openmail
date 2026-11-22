import { randomToken, sha256Hex } from '../lib/address';

export interface KeyIdentity {
  keyId: string;
  tenantId: string;
}

/** Looks a key hash up in D1; null when unknown or revoked; throws when D1 is unavailable. */
export type KeyLookup = (keyHash: string) => Promise<KeyIdentity | null>;

export type KeyAuth = ({ ok: true } & KeyIdentity) | { ok: false; status: 401 | 503 };

const STALE_IF_ERROR_MS = 5 * 60 * 1000;

export const generateApiKey = (): string => `om_${randomToken(32)}`;

export const hashApiKey = (key: string): Promise<string> => sha256Hex(key);

/**
 * Validates app API keys against D1 on every request, so a revoked key is refused at once
 * (eng review D6). When D1 errors, a key this isolate validated in the last 5 minutes is still
 * accepted, so a database blip does not stop login mail; an unseen key gets 503.
 */
export function createKeyAuthenticator(lookup: KeyLookup, now: () => number = Date.now) {
  const lastGood = new Map<string, { identity: KeyIdentity; at: number }>();

  return async function authenticate(key: string): Promise<KeyAuth> {
    const keyHash = await hashApiKey(key);
    try {
      const identity = await lookup(keyHash);
      if (!identity) {
        lastGood.delete(keyHash);
        return { ok: false, status: 401 };
      }
      lastGood.set(keyHash, { identity, at: now() });
      return { ok: true, ...identity };
    } catch {
      const cached = lastGood.get(keyHash);
      if (cached && now() - cached.at <= STALE_IF_ERROR_MS) return { ok: true, ...cached.identity };
      return { ok: false, status: 503 };
    }
  };
}
