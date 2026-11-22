import { useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, post, put } from '@/lib/api';

const KIND_LABEL: Record<string, string> = {
  hard_bounce: 'Hard bounces',
  complaint: 'Complaints',
  erased: 'Erased (deleted accounts)',
  unsubscribe: 'Unsubscribed from campaigns',
};

export function SuppressionsPage() {
  const { tenantId } = useParams({ strict: false }) as { tenantId: string };
  const { data } = useQuery({
    queryKey: ['suppressions', tenantId],
    queryFn: () => api<{ counts: Array<{ kind: string; count: number }> }>(`/t/${tenantId}/suppressions`),
  });
  return (
    <>
      <PageHeader title="Suppressions" description="Addresses this business will not mail. They are stored only as hashes, so this shows counts." />
      <Card>
        <CardContent>
          <Table>
            <TableBody>
              {data?.counts.length ? (
                data.counts.map((r) => (
                  <TableRow key={r.kind}>
                    <TableCell>{KIND_LABEL[r.kind] ?? r.kind}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="text-muted-foreground">None yet.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function CopyLine({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 font-mono text-sm">
      <span className="min-w-0 flex-1 truncate">{value}</span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

export function AgentPage() {
  const { tenantId } = useParams({ strict: false }) as { tenantId: string };
  const { data } = useQuery({ queryKey: ['agent', tenantId], queryFn: () => api<{ mcpUrl: string }>(`/t/${tenantId}/agent`) });
  const url = data?.mcpUrl ?? '';
  return (
    <>
      <PageHeader title="Agent setup" description="Connect Claude, ChatGPT or another agent. It can draft and ask you to approve; only you can approve a send." />
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>MCP server URL</CardTitle>
          <CardDescription>Your agent signs in with your owner account, and you pick this business.</CardDescription>
        </CardHeader>
        <CardContent>{url && <CopyLine value={url} />}</CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Claude</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">Settings → Connectors → Add custom connector → paste the URL.</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>ChatGPT</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">Settings → Connectors → Create → paste the URL, authentication OAuth.</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Claude Code</CardTitle>
          </CardHeader>
          <CardContent>{url && <CopyLine value={`claude mcp add --transport http openmail ${url}`} />}</CardContent>
        </Card>
      </div>
    </>
  );
}

const MAX_CONTEXT = 8000;

export function ContextPage() {
  const { tenantId } = useParams({ strict: false }) as { tenantId: string };
  const { data } = useQuery({ queryKey: ['context', tenantId], queryFn: () => api<{ context: string }>(`/t/${tenantId}/context`) });
  const [text, setText] = useState('');
  useEffect(() => setText(data?.context ?? ''), [data?.context]);
  const save = useMutation({
    mutationFn: () => put(`/t/${tenantId}/context`, { context: text }),
    onSuccess: () => toast.success('Saved'),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <>
      <PageHeader title="Voice notes" description="Agents read this before drafting: your voice, how you sign off, what to avoid." />
      <Card>
        <CardContent className="space-y-3">
          <Textarea rows={14} value={text} maxLength={MAX_CONTEXT} onChange={(e) => setText(e.target.value)} />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground tabular-nums">
              {text.length.toLocaleString()} / {MAX_CONTEXT.toLocaleString()}
            </span>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

interface Policy {
  id: string;
  campaignType: string;
  list: string;
  fromAddress: string;
  maxPerDay: number;
  keyName: string;
  revoked: boolean;
}

export function PoliciesPage() {
  const { tenantId } = useParams({ strict: false }) as { tenantId: string };
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['policies', tenantId],
    queryFn: () => api<{ policies: Policy[]; keys: Array<{ id: string; name: string }> }>(`/t/${tenantId}/policies`),
  });
  const [form, setForm] = useState({ apiKeyId: '', campaignType: '', list: '', fromAddress: '', maxPerDay: 1 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['policies', tenantId] });
  const create = useMutation({
    mutationFn: () => post(`/t/${tenantId}/policies`, form),
    onSuccess: () => {
      toast.success('Standing approval created');
      setForm({ apiKeyId: '', campaignType: '', list: '', fromAddress: '', maxPerDay: 1 });
      void refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revoke = useMutation({ mutationFn: (id: string) => post(`/t/${tenantId}/policies/${id}/revoke`), onSuccess: refresh });
  const field = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: k === 'maxPerDay' ? Number(e.target.value) : e.target.value });

  return (
    <>
      <PageHeader
        title="Automations"
        description="Let one app key send one kind of campaign to one list without asking each time. The first send still needs you, and a send pauses if the list changed by more than 10%."
      />
      <Card className="mb-6">
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>List</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Cap</TableHead>
                <TableHead>App key</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data && data.policies.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    None yet. Every send needs your approval.
                  </TableCell>
                </TableRow>
              )}
              {data?.policies.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.campaignType}</TableCell>
                  <TableCell>{p.list}</TableCell>
                  <TableCell>{p.fromAddress}</TableCell>
                  <TableCell>{p.maxPerDay}/day</TableCell>
                  <TableCell>{p.keyName}</TableCell>
                  <TableCell className="text-right">
                    {p.revoked ? (
                      <Badge variant="outline">Revoked</Badge>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => revoke.mutate(p.id)}>
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>New standing approval</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 md:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="space-y-2">
              <Label>App key</Label>
              <Select value={form.apiKeyId} onValueChange={(v) => setForm({ ...form, apiKeyId: String(v ?? '') })}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a key" />
                </SelectTrigger>
                <SelectContent>
                  {data?.keys.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="type">Campaign type</Label>
              <Input id="type" placeholder="daily" required value={form.campaignType} onChange={field('campaignType')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="list">List</Label>
              <Input id="list" required value={form.list} onChange={field('list')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="from">From address</Label>
              <Input id="from" required value={form.fromAddress} onChange={field('fromAddress')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cap">Sends per day</Label>
              <Input id="cap" type="number" min={1} max={24} value={form.maxPerDay} onChange={field('maxPerDay')} />
            </div>
            <div className="flex items-end">
              <Button type="submit" disabled={create.isPending || !form.apiKeyId}>
                Create
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
