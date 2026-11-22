import type { Env } from '../env';
import type { LaneKind, SesLane } from './ses';

export interface TenantLaneConfig {
  secretPrefix: string;
  txRegion: string;
  txConfigurationSet: string;
  bulkRegion: string;
  bulkConfigurationSet: string;
}

/**
 * Build a tenant's SES lane from Worker secrets named `<prefix>_<TX|BULK>_ACCESS_KEY_ID` and
 * `<prefix>_<TX|BULK>_SECRET_ACCESS_KEY` (synced from Infisical). Returns null when a secret is missing.
 */
export function resolveLane(env: Env, tenant: TenantLaneConfig, kind: LaneKind): SesLane | null {
  const tag = kind === 'transactional' ? 'TX' : 'BULK';
  const secrets = env as unknown as Record<string, string | undefined>;
  const accessKeyId = secrets[`${tenant.secretPrefix}_${tag}_ACCESS_KEY_ID`];
  const secretAccessKey = secrets[`${tenant.secretPrefix}_${tag}_SECRET_ACCESS_KEY`];
  if (!accessKeyId || !secretAccessKey) return null;
  return kind === 'transactional'
    ? { accessKeyId, secretAccessKey, region: tenant.txRegion, configurationSet: tenant.txConfigurationSet }
    : { accessKeyId, secretAccessKey, region: tenant.bulkRegion, configurationSet: tenant.bulkConfigurationSet };
}
