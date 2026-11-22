import { useParams } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { ago, num } from '@/lib/format';

type Contact = { id: string; email: string; name: string | null; createdAt: number; lists: string[]; status: string };
type Page = { total: number; contacts: Contact[]; nextCursor: string | null };

const STATUS: Record<string, { label: string; variant: 'secondary' | 'outline' | 'destructive' }> = {
  subscribed: { label: 'Subscribed', variant: 'secondary' },
  unsubscribed: { label: 'Unsubscribed', variant: 'outline' },
  bounced: { label: 'Bounced', variant: 'destructive' },
  complained: { label: 'Complained', variant: 'destructive' },
  erased: { label: 'Erased', variant: 'outline' },
};

export function ContactsPage() {
  const { tenantId } = useParams({ strict: false }) as { tenantId: string };
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['contacts', tenantId, q],
    initialPageParam: '',
    queryFn: ({ pageParam }) => api<Page>(`/t/${tenantId}/contacts?q=${encodeURIComponent(q)}&cursor=${encodeURIComponent(pageParam)}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = data?.pages.flatMap((p) => p.contacts) ?? [];
  const total = data?.pages[0]?.total;

  return (
    <>
      <PageHeader title="Contacts" description={total === undefined ? 'Everyone on your lists.' : `${num(total)} ${q ? 'matching' : 'in total'}.`} />
      <div className="relative mb-4 max-w-sm">
        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-8" placeholder="Search by email" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </div>
      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Lists</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right">Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    {q ? 'No contacts match that search.' : 'No contacts yet. Your apps add them through the API.'}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-4 font-medium">{c.email}</TableCell>
                  <TableCell className="text-muted-foreground">{c.name ?? '–'}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {c.lists.map((l) => (
                        <Badge key={l} variant="outline">
                          {l}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS[c.status]?.variant ?? 'outline'}>{STATUS[c.status]?.label ?? c.status}</Badge>
                  </TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground">{ago(c.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </>
  );
}
