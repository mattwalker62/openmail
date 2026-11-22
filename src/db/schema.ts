import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch('subsec') * 1000)`);

/**
 * A business that sends through openmail. Each tenant brings its own SES account; the credentials
 * live in Infisical and reach the Worker as secrets named from `secretPrefix`
 * (e.g. `SES_BEACON_TX_ACCESS_KEY_ID`). The database never holds key material.
 */
export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  fromAddress: text('from_address').notNull(),
  secretPrefix: text('secret_prefix').notNull(),
  txRegion: text('tx_region').notNull(),
  txConfigurationSet: text('tx_configuration_set').notNull(),
  bulkRegion: text('bulk_region').notNull(),
  bulkConfigurationSet: text('bulk_configuration_set').notNull(),
  bulkPerSecond: integer('bulk_per_second').notNull().default(14),
  context: text('context').notNull().default(''),
  createdAt: createdAt(),
});

/** App API keys. Only a SHA-256 hash is stored; the key is shown once at creation. */
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_keys_key_hash_idx').on(t.keyHash)],
);

export const contacts = sqliteTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    email: text('email').notNull(),
    /** SHA-256 of the address, so suppression checks can run inside one SQL statement. */
    addressHash: text('address_hash'),
    name: text('name'),
    externalId: text('external_id'),
    unsubscribeToken: text('unsubscribe_token').notNull(),
    unsubscribedAt: integer('unsubscribed_at', { mode: 'timestamp_ms' }),
    source: text('source'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('contacts_tenant_email_idx').on(t.tenantId, t.email),
    uniqueIndex('contacts_unsubscribe_token_idx').on(t.unsubscribeToken),
    index('contacts_tenant_external_idx').on(t.tenantId, t.externalId),
  ],
);

export const lists = sqliteTable(
  'lists',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('lists_tenant_name_idx').on(t.tenantId, t.name)],
);

export const listMembers = sqliteTable(
  'list_members',
  {
    listId: text('list_id')
      .notNull()
      .references(() => lists.id),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.listId, t.contactId] })],
);

/**
 * Addresses this tenant must not mail. `kind` decides what each stops:
 * - hard_bounce, complaint, erased: everything, login mail included;
 * - unsubscribe: campaigns only (a login link still goes out).
 * Keyed by a SHA-256 of the lowercased address so an erased contact leaves no plain address behind.
 */
export const suppressions = sqliteTable(
  'suppressions',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    addressHash: text('address_hash').notNull(),
    kind: text('kind', { enum: ['hard_bounce', 'complaint', 'erased', 'unsubscribe'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.addressHash, t.kind] })],
);

/** A versioned email body. Every update bumps `version`, which voids any approval of an older one. */
export const drafts = sqliteTable('drafts', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id),
  subject: text('subject').notNull(),
  html: text('html').notNull(),
  text: text('text'),
  version: integer('version').notNull().default(1),
  origin: text('origin', { enum: ['api', 'mcp'] }).notNull(),
  createdAt: createdAt(),
});

/**
 * A send intent: one draft version, to one list, from one address, at one time. An approval covers
 * exactly this intent; changing any part of it voids the approval.
 */
export const campaigns = sqliteTable(
  'campaigns',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    draftId: text('draft_id')
      .notNull()
      .references(() => drafts.id),
    draftVersion: integer('draft_version').notNull(),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id),
    fromAddress: text('from_address').notNull(),
    scheduledAt: integer('scheduled_at', { mode: 'timestamp_ms' }).notNull(),
    campaignType: text('campaign_type'),
    policyId: text('policy_id'),
    status: text('status', {
      enum: ['awaiting_approval', 'approved', 'sending', 'paused', 'cancelled', 'sent'],
    }).notNull(),
    pauseReason: text('pause_reason'),
    recipientCount: integer('recipient_count'),
    approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
    approvedBy: text('approved_by'),
    origin: text('origin', { enum: ['api', 'mcp'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('campaigns_tenant_status_idx').on(t.tenantId, t.status)],
);

/**
 * The recipient snapshot frozen at approval, and each recipient's delivery state:
 * pending → sending (claimed just before the SES call) → sent; failed_retryable returns to pending;
 * a `sending` row whose 2-minute lease expired becomes `unknown` and is never resent automatically.
 */
export const campaignRecipients = sqliteTable(
  'campaign_recipients',
  {
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    contactId: text('contact_id').notNull(),
    email: text('email').notNull(),
    unsubscribeToken: text('unsubscribe_token').notNull(),
    status: text('status', {
      enum: ['pending', 'sending', 'sent', 'failed_retryable', 'failed_permanent', 'unknown', 'suppressed'],
    })
      .notNull()
      .default('pending'),
    claimedAt: integer('claimed_at', { mode: 'timestamp_ms' }),
    claimBatch: text('claim_batch'),
    messageId: text('message_id'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    primaryKey({ columns: [t.campaignId, t.contactId] }),
    index('campaign_recipients_status_idx').on(t.campaignId, t.status),
  ],
);

/**
 * A standing approval: an app API key may send one campaign type to one list from one address,
 * up to `maxPerDay` times, without a human click. The first send under a policy still needs a
 * human approval, which becomes the baseline.
 */
export const policies = sqliteTable('policies', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id),
  apiKeyId: text('api_key_id')
    .notNull()
    .references(() => apiKeys.id),
  campaignType: text('campaign_type').notNull(),
  listId: text('list_id')
    .notNull()
    .references(() => lists.id),
  fromAddress: text('from_address').notNull(),
  maxPerDay: integer('max_per_day').notNull().default(1),
  baselineCampaignId: text('baseline_campaign_id'),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  createdAt: createdAt(),
});

/**
 * Outbox for an approved campaign. Approval writes it in the same batch as the snapshot; the
 * once-a-minute reconciler publishes recipient pages to the queue from `cursor`, and re-publishes
 * a page whose lease expired.
 */
export const dispatches = sqliteTable('dispatches', {
  campaignId: text('campaign_id')
    .primaryKey()
    .references(() => campaigns.id),
  cursor: text('cursor').notNull().default(''),
  leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
  done: integer('done', { mode: 'boolean' }).notNull().default(false),
});

/**
 * Pre-approved transactional templates (login link, password reset). `{{name}}` placeholders are
 * filled from the request's `data`, HTML-escaped in the html body. Managed only by the owner.
 */
export const templates = sqliteTable(
  'templates',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.name] })],
);

/** One row per transactional send, written after the send so it never delays it. No plain address. */
export const transactionalMessages = sqliteTable('transactional_messages', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  template: text('template').notNull(),
  addressHash: text('address_hash').notNull(),
  status: text('status', { enum: ['sent', 'failed', 'suppressed'] }).notNull(),
  messageId: text('message_id'),
  error: text('error'),
  createdAt: createdAt(),
});
