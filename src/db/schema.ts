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
