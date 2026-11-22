import { Badge } from '@/components/ui/badge';

const LABEL: Record<string, string> = {
  awaiting_approval: 'Needs approval',
  approved: 'Approved',
  sending: 'Sending',
  paused: 'Paused',
  cancelled: 'Cancelled',
  sent: 'Sent',
};
const REASON: Record<string, string> = {
  owner: 'by you',
  audience_changed: 'list changed',
  draft_changed: 'draft changed',
  sending_error: 'sending error',
};

export function StatusBadge({ status, pauseReason }: { status: string; pauseReason?: string | null }) {
  const variant = status === 'awaiting_approval' || status === 'paused' ? 'secondary' : status === 'cancelled' ? 'outline' : 'default';
  const reason = status === 'paused' && pauseReason ? ` · ${REASON[pauseReason] ?? pauseReason}` : '';
  return <Badge variant={variant}>{(LABEL[status] ?? status) + reason}</Badge>;
}
