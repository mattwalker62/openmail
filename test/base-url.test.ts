import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { envForRequest } from '../src/base-url';

const env = (preview?: string) => ({ PUBLIC_BASE_URL: 'https://mail.example.com', ...(preview ? { OPENMAIL_PREVIEW: preview } : {}) }) as unknown as Env;

describe('envForRequest', () => {
  it('in production keeps the configured address, whatever host a request claims', () => {
    const e = envForRequest(env(), new Request('https://evil.example/login'));
    expect(e.PUBLIC_BASE_URL).toBe('https://mail.example.com');
  });

  it("in a Preview uses the address the request came in on, so links and redirects stay on that Preview", () => {
    const e = envForRequest(env('1'), new Request('https://feature-x-openmail.acct.workers.dev/login?next=/'));
    expect(e.PUBLIC_BASE_URL).toBe('https://feature-x-openmail.acct.workers.dev');
  });

  it('keeps every other binding', () => {
    const base = { ...env('1'), DB: { marker: true } } as unknown as Env;
    expect((envForRequest(base, new Request('https://p.workers.dev/')) as unknown as { DB: unknown }).DB).toEqual({ marker: true });
  });
});
