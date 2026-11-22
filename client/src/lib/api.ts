/** Calls the Worker's dashboard API with the owner's session cookie. A 401 sends them to sign in. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(401, 'Signed out');
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? body.reason ?? `Request failed (${res.status})`);
  return body;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });

export interface Me {
  email: string;
  tenants: Array<{ id: string; name: string; slug: string }>;
}

export interface CampaignRow {
  id: string;
  subject: string;
  list: string;
  status: string;
  pauseReason: string | null;
  requestedBy: 'agent' | 'app';
  recipients: number | null;
  sent: number;
  unknown: number;
  createdAt: number;
}
