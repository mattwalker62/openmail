import type { Owner } from '../auth/better-auth';
import { escapeHtml } from './page';

const NAV: Array<[string, string]> = [
  ['', 'Overview'],
  ['/suppressions', 'Suppressions'],
  ['/agent', 'Agent setup'],
  ['/context', 'Context'],
  ['/policies', 'Standing approvals'],
];

/**
 * The dashboard shell, after OpenSEO's layout: a business switcher at the top of a sectioned sidebar,
 * and the page beside it. Every interpolated value is escaped by the caller.
 */
export function layout(owner: Owner, tenantId: string, active: string, title: string, body: string): string {
  const switcher = owner.tenants
    .map((t) => `<a class="biz${t.id === tenantId ? ' on' : ''}" href="/t/${escapeHtml(t.id)}">${escapeHtml(t.name)}</a>`)
    .join('');
  const nav = NAV.map(
    ([path, label]) => `<a class="nav${active === path ? ' on' : ''}" href="/t/${escapeHtml(tenantId)}${path}">${label}</a>`,
  ).join('');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)} · openmail</title><style>` +
    `*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#1a1a1a;display:flex;min-height:100vh;background:#f6f6f4}` +
    `aside{width:15rem;background:#ecece8;padding:1rem;display:flex;flex-direction:column;gap:.2rem}main{flex:1;padding:2rem;max-width:60rem}` +
    `.brand{font-weight:700;margin-bottom:.8rem}.biz,.nav{display:block;padding:.35rem .6rem;border-radius:.4rem;color:#1a1a1a;text-decoration:none}` +
    `.biz.on{background:#fff;font-weight:600}.nav.on{background:#d9d9d3}.sec{margin:.9rem 0 .2rem;font-size:.75rem;text-transform:uppercase;color:#666}` +
    `.card{background:#fff;border:1px solid #e2e2dc;border-radius:.6rem;padding:1rem 1.2rem;margin-bottom:1rem}table{width:100%;border-collapse:collapse}` +
    `td,th{text-align:left;padding:.4rem;border-bottom:1px solid #eee;vertical-align:top}form.inline{display:inline}` +
    `button{font:inherit;padding:.35rem .8rem;border-radius:.4rem;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer}` +
    `button.ghost{background:#fff;color:#1a1a1a}input,select,textarea{font:inherit;width:100%;padding:.45rem;border:1px solid #bbb;border-radius:.4rem}` +
    `label{display:block;margin:.6rem 0 .2rem}.muted{color:#666}.pill{font-size:.8rem;padding:.1rem .5rem;border-radius:1rem;background:#eee}code,pre{background:#f0f0ec;padding:.1rem .3rem;border-radius:.3rem}pre{padding:.8rem;overflow:auto}` +
    `</style></head><body><aside><div class="brand">openmail</div><div class="sec">Business</div>${switcher}<div class="sec">Manage</div>${nav}` +
    `<div style="flex:1"></div><form method="post" action="/logout"><button class="ghost" type="submit">Sign out</button></form>` +
    `<div class="muted" style="font-size:.8rem;margin-top:.4rem">${escapeHtml(owner.email)}</div></aside><main>${body}</main></body></html>`
  );
}
