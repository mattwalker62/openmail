import type { Db } from '../db/client';
import { addressHash } from '../lib/address';
import type { OutboundEmail, SendResult } from '../transport/ses';
import { LEASE_MS, type PageMessage } from './reconciler';

export interface DeliveryDeps {
  /** Send one email on the tenant's bulk lane. */
  send: (tenantId: string, email: OutboundEmail) => Promise<SendResult>;
  /** Reserve `count` sends on the tenant's bulk lane; returns ms to wait first. */
  acquire: (tenantId: string, count: number, perSecond: number) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  publicBaseUrl: string;
}

interface Recipient {
  contact_id: string;
  email: string;
  unsubscribe_token: string;
  status: string;
  claimed_at: number | null;
}

/**
 * Deliver one page of a campaign (eng review A1, D9). Before anything is sent it re-checks that the
 * campaign is still live and its draft is still the approved version. Each recipient is claimed with
 * a conditional update (pending → sending) committed just before the SES call, so only one consumer
 * can send it. On redelivery a `sending` row is left alone while its 2-minute lease runs and marked
 * `unknown` after; neither is ever resent automatically. Sends are paced in chunks no larger than the
 * lane's per-second limit.
 */
export async function processPage(d: Db, deps: DeliveryDeps, msg: PageMessage, now: number): Promise<void> {
  const db = d.$client;
  const campaign = await db
    .prepare(
      `select c.id, c.tenant_id, c.status, c.draft_version, c.from_address, d.version, d.subject, d.html, d.text,
       t.bulk_per_second from campaigns c join drafts d on d.id = c.draft_id join tenants t on t.id = c.tenant_id
       where c.id = ?1`,
    )
    .bind(msg.campaignId)
    .first<{
      id: string;
      tenant_id: string;
      status: string;
      draft_version: number;
      from_address: string;
      version: number;
      subject: string;
      html: string;
      text: string | null;
      bulk_per_second: number;
    }>();
  if (!campaign || (campaign.status !== 'approved' && campaign.status !== 'sending')) return;
  if (campaign.version !== campaign.draft_version) {
    await db
      .prepare(`update campaigns set status = 'paused', pause_reason = 'draft_changed' where id = ?1 and status in ('approved', 'sending')`)
      .bind(campaign.id)
      .run();
    return;
  }

  const placeholders = msg.contactIds.map((_, i) => `?${i + 2}`).join(',');
  const rows = await db
    .prepare(
      `select contact_id, email, unsubscribe_token, status, claimed_at from campaign_recipients
       where campaign_id = ?1 and contact_id in (${placeholders})`,
    )
    .bind(campaign.id, ...msg.contactIds)
    .all<Recipient>();

  const batch = crypto.randomUUID();
  const claimed: Recipient[] = [];
  for (const r of rows.results) {
    if (r.status === 'sending') {
      if (r.claimed_at !== null && r.claimed_at < now - LEASE_MS) {
        await db
          .prepare(`update campaign_recipients set status = 'unknown' where campaign_id = ?1 and contact_id = ?2 and status = 'sending' and claimed_at = ?3`)
          .bind(campaign.id, r.contact_id, r.claimed_at)
          .run();
      }
      continue;
    }
    if (r.status !== 'pending') continue;

    const suppressed = await db
      .prepare(
        `select 1 from suppressions where tenant_id = ?1 and address_hash = ?2
         union all select 1 from contacts where id = ?3 and unsubscribed_at is not null limit 1`,
      )
      .bind(campaign.tenant_id, await addressHash(r.email), r.contact_id)
      .first();
    if (suppressed) {
      await db
        .prepare(`update campaign_recipients set status = 'suppressed' where campaign_id = ?1 and contact_id = ?2 and status = 'pending'`)
        .bind(campaign.id, r.contact_id)
        .run();
      continue;
    }

    const claim = await db
      .prepare(
        `update campaign_recipients set status = 'sending', claimed_at = ?3, claim_batch = ?4, attempts = attempts + 1
         where campaign_id = ?1 and contact_id = ?2 and status = 'pending'`,
      )
      .bind(campaign.id, r.contact_id, now, batch)
      .run();
    if (claim.meta.changes === 1) claimed.push(r);
  }

  const settle = (r: Recipient, status: string, extra: { messageId?: string; error?: string } = {}) =>
    db
      .prepare(
        `update campaign_recipients set status = ?3, message_id = coalesce(?4, message_id), last_error = ?5
         where campaign_id = ?1 and contact_id = ?2 and status = 'sending' and claim_batch = ?6`,
      )
      .bind(campaign.id, r.contact_id, status, extra.messageId ?? null, extra.error ?? null, batch)
      .run();

  const perSecond = Math.max(1, campaign.bulk_per_second);
  for (let i = 0; i < claimed.length; i += perSecond) {
    const chunk = claimed.slice(i, i + perSecond);
    const wait = await deps.acquire(campaign.tenant_id, chunk.length, perSecond);
    if (wait > 0) await deps.sleep(wait);

    for (const [j, r] of chunk.entries()) {
      const result = await deps.send(campaign.tenant_id, {
        to: r.email,
        from: campaign.from_address,
        subject: campaign.subject,
        html: campaign.html,
        ...(campaign.text ? { text: campaign.text } : {}),
        unsubscribeUrl: `${deps.publicBaseUrl}/u/${campaign.tenant_id}/${r.unsubscribe_token}`,
        tags: [{ name: 'campaign', value: campaign.id }],
      });
      if (result.ok) {
        await settle(r, 'sent', { messageId: result.messageId });
      } else if (result.type === 'retryable') {
        await settle(r, 'pending', { error: result.error });
      } else if (result.type === 'non_retryable') {
        await settle(r, 'failed_permanent', { error: result.error });
        if (result.shouldSuppress) {
          await db
            .prepare(`insert into suppressions (tenant_id, address_hash, kind) values (?1, ?2, 'hard_bounce') on conflict do nothing`)
            .bind(campaign.tenant_id, await addressHash(r.email))
            .run();
        }
      } else {
        // Fatal: the tenant's SES setup is broken. Stop, hand everything unsent back, and pause.
        for (const rest of [...chunk.slice(j), ...claimed.slice(i + perSecond)]) await settle(rest, 'pending');
        await db
          .prepare(`update campaigns set status = 'paused', pause_reason = 'sending_error' where id = ?1 and status in ('approved', 'sending')`)
          .bind(campaign.id)
          .run();
        return;
      }
    }
  }
}
