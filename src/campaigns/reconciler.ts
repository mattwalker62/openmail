import type { Db } from '../db/client';

export interface PageMessage {
  campaignId: string;
  contactIds: string[];
}

export const PAGE_SIZE = 100;
/** How long a full pass waits before re-publishing recipients still pending (lost or failed messages). */
export const LEASE_MS = 2 * 60 * 1000;
const MAX_PAGES_PER_RUN = 50;

interface DispatchRow {
  campaign_id: string;
  cursor: string;
  lease_until: number | null;
  status: string;
}

/**
 * The outbox side of sending (eng review D10). Runs every minute. For each approved campaign that is
 * due, it publishes pending recipients in pages of at most 100, checkpointing the cursor after every
 * page, so a crash or a failed publish resumes where it stopped. When a pass reaches the end with
 * recipients still unsent, it waits out a lease and then starts again from the beginning; the
 * consumer's conditional claim makes any repeat harmless. A campaign with nothing left is sent.
 */
export async function reconcile(d: Db, publish: (msg: PageMessage) => Promise<void>, now: number): Promise<void> {
  const due = await d.$client
    .prepare(
      `select x.campaign_id, x.cursor, x.lease_until, c.status from dispatches x join campaigns c on c.id = x.campaign_id
       where x.done = 0 and c.status in ('approved', 'sending') and c.scheduled_at <= ?1`,
    )
    .bind(now)
    .all<DispatchRow>();

  for (const row of due.results) {
    try {
      await reconcileOne(d, publish, row, now);
    } catch (err) {
      // Leave the checkpoint where it is; the next run resumes from it.
      console.error(`reconcile ${row.campaign_id}:`, err);
    }
  }
}

async function reconcileOne(d: Db, publish: (msg: PageMessage) => Promise<void>, row: DispatchRow, now: number) {
  if (row.lease_until !== null && now < row.lease_until) return;
  let cursor = row.lease_until !== null ? '' : row.cursor;

  for (let pages = 0; pages < MAX_PAGES_PER_RUN; pages++) {
    const page = await d.$client
      .prepare(
        `select contact_id from campaign_recipients where campaign_id = ?1 and status = 'pending' and contact_id > ?2
         order by contact_id limit ${PAGE_SIZE}`,
      )
      .bind(row.campaign_id, cursor)
      .all<{ contact_id: string }>();
    if (page.results.length === 0) break;

    const contactIds = page.results.map((r) => r.contact_id);
    await publish({ campaignId: row.campaign_id, contactIds });
    cursor = contactIds[contactIds.length - 1]!;
    await d.$client.batch([
      d.$client.prepare('update dispatches set cursor = ?2, lease_until = null where campaign_id = ?1').bind(row.campaign_id, cursor),
      d.$client.prepare(`update campaigns set status = 'sending' where id = ?1 and status = 'approved'`).bind(row.campaign_id),
    ]);
    if (contactIds.length < PAGE_SIZE) break;
  }

  const left = await d.$client
    .prepare(`select count(*) as n from campaign_recipients where campaign_id = ?1 and status in ('pending', 'sending', 'failed_retryable')`)
    .bind(row.campaign_id)
    .first<{ n: number }>();
  if (left?.n === 0) {
    await d.$client.batch([
      d.$client.prepare('update dispatches set done = 1 where campaign_id = ?1').bind(row.campaign_id),
      d.$client.prepare(`update campaigns set status = 'sent' where id = ?1 and status in ('approved', 'sending')`).bind(row.campaign_id),
    ]);
    return;
  }
  const more = await d.$client
    .prepare(`select 1 from campaign_recipients where campaign_id = ?1 and status = 'pending' and contact_id > ?2 limit 1`)
    .bind(row.campaign_id, cursor)
    .first();
  if (!more) {
    await d.$client.prepare('update dispatches set cursor = ?2, lease_until = ?3 where campaign_id = ?1').bind(row.campaign_id, cursor, now + LEASE_MS).run();
  }
}
