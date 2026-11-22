import { describe, expect, it } from 'vitest';
import { createKeyAuthenticator, type KeyLookup } from '../../src/auth/api-keys';

const FIVE_MIN = 5 * 60 * 1000;

describe('createKeyAuthenticator (D1 per request, stale-if-error)', () => {
  it('checks the database on every request, so a revoked key is refused at once', async () => {
    let revoked = false;
    const lookup: KeyLookup = async () => (revoked ? null : { keyId: 'k1', tenantId: 't1' });
    const auth = createKeyAuthenticator(lookup, () => 0);

    expect(await auth('om_key')).toEqual({ ok: true, keyId: 'k1', tenantId: 't1' });
    revoked = true;
    expect(await auth('om_key')).toEqual({ ok: false, status: 401 });
  });

  it('reuses a validation from the last 5 minutes when the database errors', async () => {
    let now = 0;
    let fail = false;
    const lookup: KeyLookup = async () => {
      if (fail) throw new Error('D1 unavailable');
      return { keyId: 'k1', tenantId: 't1' };
    };
    const auth = createKeyAuthenticator(lookup, () => now);

    await auth('om_key');
    fail = true;
    now = FIVE_MIN - 1;
    expect(await auth('om_key')).toEqual({ ok: true, keyId: 'k1', tenantId: 't1' });
    now = FIVE_MIN + 1;
    expect(await auth('om_key')).toEqual({ ok: false, status: 503 });
  });

  it('answers 503 for a key it has never validated when the database errors', async () => {
    const auth = createKeyAuthenticator(async () => {
      throw new Error('D1 unavailable');
    }, () => 0);

    expect(await auth('om_never_seen')).toEqual({ ok: false, status: 503 });
  });
});
