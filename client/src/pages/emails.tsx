import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, post, type CampaignRow } from '@/lib/api';

type Action = 'pause' | 'resume' | 'cancel' | 'resend-unknowns';

export function EmailsPage() {
  const { tenantId } = useParams({ strict: false }) as { tenantId: string };
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['overview', tenantId],
    queryFn: () => api<{ waiting: CampaignRow[]; campaigns: CampaignRow[] }>(`/t/${tenantId}/overview`),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: Action }) => post(`/t/${tenantId}/campaigns/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['overview', tenantId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <PageHeader title="Emails" description="Sends waiting for you, and everything sent recently." />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Waiting for your approval</CardTitle>
          <CardDescription>Nothing goes out until you approve it.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : data?.waiting.length ? (
            <Table>
              <TableBody>
                {data.waiting.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.subject}</TableCell>
                    <TableCell>{c.list}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{c.requestedBy === 'agent' ? 'Asked by an agent' : 'Asked by an app'}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" render={<Link to="/approve/$campaignId" params={{ campaignId: c.id }} />}>
                        Review
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing is waiting for you.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Campaigns</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : data?.campaigns.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>List</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="max-w-72 truncate font-medium">{c.subject}</TableCell>
                    <TableCell>{c.list}</TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} pauseReason={c.pauseReason} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.sent}/{c.recipients ?? '–'}
                    </TableCell>
                    <TableCell className="space-x-1 text-right">
                      {(c.status === 'approved' || c.status === 'sending') && (
                        <Button size="sm" variant="outline" onClick={() => act.mutate({ id: c.id, action: 'pause' })}>
                          Pause
                        </Button>
                      )}
                      {c.status === 'paused' && c.pauseReason === 'owner' && (
                        <Button size="sm" variant="outline" onClick={() => act.mutate({ id: c.id, action: 'resume' })}>
                          Resume
                        </Button>
                      )}
                      {c.unknown > 0 && (
                        <Button size="sm" variant="outline" onClick={() => act.mutate({ id: c.id, action: 'resend-unknowns' })}>
                          Resend {c.unknown} unknown
                        </Button>
                      )}
                      {c.status !== 'sent' && c.status !== 'cancelled' && (
                        <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: c.id, action: 'cancel' })}>
                          Cancel
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No campaigns yet.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
