import { useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, post } from '@/lib/api';

interface Intent {
  id: string;
  tenantId: string;
  status: string;
  pauseReason: string | null;
  subject: string;
  html: string;
  draftVersion: number;
  draftChanged: boolean;
  list: string;
  recipients: number;
  fromAddress: string;
  scheduledAt: number;
  requestedBy: 'agent' | 'app';
  canApprove: boolean;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-4 border-b py-2.5 text-sm last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Shows the exact send intent. Opening it changes nothing; only the Approve button does. */
export function ApprovePage() {
  const { campaignId } = useParams({ strict: false }) as { campaignId: string };
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['intent', campaignId], queryFn: () => api<Intent>(`/approve/${campaignId}`) });
  const approve = useMutation({
    mutationFn: () => post<{ ok: true; recipientCount: number }>(`/approve/${campaignId}`),
    onSuccess: (r) => {
      toast.success(`Approved. Sending to ${r.recipientCount} people.`);
      void navigate({ to: '/t/$tenantId', params: { tenantId: data!.tenantId } });
    },
    onError: (e: Error) => toast.error(`Not approved: ${e.message.replace('_', ' ')}`),
  });

  if (isLoading || !data) return <Skeleton className="h-96 w-full" />;
  const when = new Date(data.scheduledAt);

  return (
    <>
      <PageHeader
        title="Approve this send?"
        description={data.requestedBy === 'agent' ? 'An agent drafted this and asked you to approve it.' : 'An app asked to send this.'}
        actions={<StatusBadge status={data.status} pauseReason={data.pauseReason} />}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <Card>
          <CardHeader>
            <CardTitle>What will be sent</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Row label="Subject">{data.subject}</Row>
              <Row label="Draft">Version {data.draftVersion}</Row>
              <Row label="To">
                {data.list} · <span className="font-medium">{data.recipients} recipients</span>
              </Row>
              <Row label="From">{data.fromAddress}</Row>
              <Row label="When">{when <= new Date() ? 'Right away' : when.toLocaleString()}</Row>
            </dl>
            <div className="mt-6">
              {data.canApprove ? (
                <Button size="lg" className="w-full" disabled={approve.isPending} onClick={() => approve.mutate()}>
                  {approve.isPending ? 'Approving…' : `Approve and send to ${data.recipients}`}
                </Button>
              ) : data.draftChanged ? (
                <p className="text-sm text-muted-foreground">The draft changed after this request. Ask for a new approval.</p>
              ) : (
                <p className="text-sm text-muted-foreground">There is nothing to approve.</p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Preview</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <iframe title="Email preview" sandbox="" srcDoc={data.html} className="h-[32rem] w-full border-t bg-white" />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
