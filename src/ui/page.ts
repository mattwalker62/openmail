export const escapeHtml = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A plain page shell. Every interpolated value must already be escaped. */
export const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${escapeHtml(title)} · openmail</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1rem;color:#1a1a1a}` +
  `label{display:block;margin:.8rem 0 .2rem}input,select{font:inherit;width:100%;padding:.5rem;border:1px solid #bbb;border-radius:.4rem}` +
  `button{font:inherit;margin-top:1rem;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer}` +
  `.muted{color:#666}.error{color:#a40000}</style></head><body>${body}</body></html>`;
