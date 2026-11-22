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
  /** JSON array of SNS topic ARNs this tenant's SES events may arrive from (fail-closed allowlist). */
  snsTopicArns: text('sns_topic_arns').notNull().default('[]'),
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
    // Per tenant: one business's imported token can never collide with or reveal another's.
    uniqueIndex('contacts_tenant_unsubscribe_token_idx').on(t.tenantId, t.unsubscribeToken),
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
    /** JSON array of origins a URL value may point at (e.g. ["https://mattwalker.co"]). */
    linkOrigins: text('link_origins').notNull().default('[]'),
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

/**
 * SNS posts refused at /ses/:tenantId (bad signature, unknown topic), kept for investigation. Only
 * the envelope is stored: the body carries recipient addresses that erasure could not reach.
 */
export const webhookQuarantine = sqliteTable('webhook_quarantine', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id'),
  reason: text('reason').notNull(),
  topicArn: text('topic_arn'),
  messageId: text('message_id'),
  createdAt: createdAt(),
});

// ── Owners (Better Auth core tables) ─────────────────────────────────────────

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const users = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const sessions = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: ts('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
});

export const accounts = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: ts('access_token_expires_at'),
  refreshTokenExpiresAt: ts('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const verifications = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
});

/** Who owns which tenant. Only owners approve sends, manage policies and keys, or connect agents. */
export const memberships = sqliteTable(
  'memberships',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner'] }).notNull().default('owner'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

/** Sign-up is closed: an account can only be created for an email an admin invited to a tenant. */
export const ownerInvites = sqliteTable(
  'owner_invites',
  {
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    email: text('email').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.email] })],
);
