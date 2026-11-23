import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { ArrowRight, CalendarDays, CircleCheck, NotebookPen, PenLine, Send, ShieldAlert, UserPlus } from 'lucide-react';
import { PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { ago, num, pct } from '@/lib/format';

type Home = {
  days: number;
  period: { newSubscribers: number; emailsSent: number; awaitingApproval: number; scheduled: number; bouncesAndComplaints: number };
  previous: { newSubscribers: number; emailsSent: number };
  totals: { contacts: number; contactsAtStart: number };
  scorecard: { sent: number; bounces: number; complaints: number; bounceRate: number | null; complaintRate: number | null; unsubscribeRate: number | null };
  recent: { lastSend: { subject: string; sentAt: number; delivered: number } | null; lastSignup: { email: string; at: number } | null };
  contactsOverTime: Array<{ date: string; total: number }>;
  previousContactsOverTime: Array<{ date: string; total: number }>;
  sentPerDay: Array<{ date: string; sent: number }>;
  recommendations: Array<{ kind: string; title: string; detail: string; href: string }>;
};

const REC_ICON: Record<string, typeof Send> = { approve: CircleCheck, finish_draft: PenLine, write_to_readers: Send, add_context: NotebookPen };
const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric' });

const contactsChart = {
  total: { label: 'This period', color: 'var(--foreground)' },
  previous: { label: 'Previous period', color: 'var(--muted-foreground)' },
} satisfies ChartConfig;
const sentChart = { sent: { label: 'Emails sent', color: 'var(--foreground)' } } satisfies ChartConfig;

export function HomePage() {
  const { tenantId } = useParams({ strict: false }) as { tenantId: string };
  const [days, setDays] = useState('30');
  const { data: h } = useQuery({ queryKey: ['home', tenantId, days], queryFn: () => api<Home>(`/t/${tenantId}/home?days=${days}`) });

  return (
    <>
      <PageHeader
        title="Overview"
        actions={
          <Select value={days} onValueChange={(v) => setDays(String(v))}>
            <SelectTrigger className="w-40">
              <CalendarDays className="size-4 text-muted-foreground" />
              <SelectValue>{(v: string) => `Last ${v} days`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      {!h ? (
        <Skeleton className="h-[40rem] w-full" />
      ) : (
        <div className="flex flex-col gap-6">
          {h.period.awaitingApproval > 0 && (
            <div className="flex items-center justify-between gap-4 rounded-xl border bg-card px-5 py-3 text-sm">
              <span>
                <span className="font-medium">{h.period.awaitingApproval === 1 ? '1 send is waiting for you' : `${h.period.awaitingApproval} sends are waiting for you`}</span>
                <span className="text-muted-foreground"> · nothing goes out until you approve it</span>
              </span>
              <Button size="sm" nativeButton={false} render={<Link to="/t/$tenantId/emails" params={{ tenantId }} />}>
                Review <ArrowRight />
              </Button>
            </div>
          )}

          <Card className="gap-0 overflow-hidden py-0">
            <div className="grid grid-cols-2 divide-x divide-y md:grid-cols-3 md:divide-y-0 xl:grid-cols-6">
              <Stat label="Sent" value={num(h.scorecard.sent)} sub={`${num(h.previous.emailsSent)} previous`} />
              <Stat label="Delivered" pending />
              <Stat label="Opened" pending />
              <Stat label="Clicked" pending />
              <Stat label="Bounced" value={h.scorecard.sent ? num(h.scorecard.bounces) : undefined} sub={pct(h.scorecard.bounceRate)} />
              <Stat label="Complaints" value={h.scorecard.sent ? num(h.scorecard.complaints) : undefined} sub={pct(h.scorecard.complaintRate)} />
            </div>

            <div className="border-t p-6">
              <ChartHeading
                title="Subscribers"
                value={num(h.totals.contacts)}
                note={`${h.period.newSubscribers >= 0 ? '+' : ''}${num(h.period.newSubscribers)} in ${days} days`}
                legend={
                  <>
                    <LegendKey line label={`Last ${days} days`} value={h.period.newSubscribers} />
                    <LegendKey dashed label={`Previous ${days} days`} value={h.previous.newSubscribers} />
                  </>
                }
              />
              <ChartContainer config={contactsChart} className="mt-4 h-64 w-full">
                <LineChart
                  data={h.contactsOverTime.map((p, i) => ({ date: p.date, total: p.total, previous: h.previousContactsOverTime[i]?.total }))}
                  margin={{ left: 0, right: 8, top: 8 }}
                >
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={40} tickFormatter={shortDate} />
                  <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => shortDate(String(v))} />} />
                  <Line isAnimationActive={false} dataKey="previous" stroke="var(--color-previous)" strokeDasharray="4 4" strokeWidth={1.5} dot={false} />
                  <Line isAnimationActive={false} dataKey="total" stroke="var(--color-total)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            </div>
          </Card>

          <Card className="py-0">
            <CardContent className="p-6">
              <ChartHeading
                title="Emails sent per day"
                value={num(h.period.emailsSent)}
                note={`${num(h.previous.emailsSent)} in the previous ${days} days`}
              />
              <div className="relative mt-4">
              {h.period.emailsSent === 0 && (
                <p className="absolute inset-0 z-10 flex items-center justify-center text-sm text-muted-foreground">No emails sent in this period</p>
              )}
              <ChartContainer config={sentChart} className="h-56 w-full">
                <BarChart data={h.sentPerDay} margin={{ left: 0, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={40} tickFormatter={shortDate} />
                  <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDate(String(v))} />} />
                  <Bar isAnimationActive={false} dataKey="sent" fill="var(--color-sent)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ChartContainer>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <h2 className="mb-3 text-sm font-medium">Recommended actions</h2>
              <div className="flex flex-col gap-2">
                {h.recommendations.length === 0 && <p className="text-sm text-muted-foreground">Nothing to do right now.</p>}
                {h.recommendations.map((r) => {
                  const Icon = REC_ICON[r.kind] ?? ShieldAlert;
                  return (
                    <a key={r.kind} href={r.href} className="flex items-center gap-3 rounded-xl border bg-card p-3 hover:bg-accent/50">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <Icon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{r.title}</div>
                        <div className="truncate text-xs text-muted-foreground">{r.detail}</div>
                      </div>
                      <ArrowRight className="size-4 text-muted-foreground" />
                    </a>
                  );
                })}
              </div>
            </section>
            <section>
              <h2 className="mb-3 text-sm font-medium">Recent activity</h2>
              <Card className="gap-0 py-0">
                <ActivityRow
                  icon={Send}
                  label="Last email"
                  text={h.recent.lastSend ? `"${h.recent.lastSend.subject}" to ${num(h.recent.lastSend.delivered)}` : 'Nothing sent yet'}
                  when={h.recent.lastSend?.sentAt}
                />
                <ActivityRow icon={UserPlus} label="Last signup" text={h.recent.lastSignup?.email ?? 'No contacts yet'} when={h.recent.lastSignup?.at} border />
              </Card>
            </section>
          </div>
        </div>
      )}
    </>
  );
}

/** One cell of the stat strip. `pending` marks numbers that need SES event tracking first. */
function Stat({ label, value, sub, pending }: { label: string; value?: string; sub?: string; pending?: boolean }) {
  return (
    <div className="p-5" title={pending ? 'Needs SES delivery, open and click tracking: not connected yet' : undefined}>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums tracking-tight ${value === undefined ? 'text-muted-foreground/50' : ''}`}>{value ?? '–'}</div>
      <div className="mt-1 text-xs text-muted-foreground">{pending ? 'Not connected yet' : (sub ?? '–')}</div>
    </div>
  );
}

function ChartHeading({ title, value, note, legend }: { title: string; value: string; note: string; legend?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="text-sm text-muted-foreground">{title}</div>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-3xl font-semibold tabular-nums tracking-tight">{value}</span>
          <span className="text-sm text-muted-foreground">{note}</span>
        </div>
      </div>
      {legend && <div className="flex gap-4 text-xs text-muted-foreground">{legend}</div>}
    </div>
  );
}

function LegendKey({ label, value, dashed }: { label: string; value: number; line?: boolean; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-4 border-t-2 ${dashed ? 'border-dashed border-muted-foreground' : 'border-foreground'}`} />
      {label} <span className="font-medium text-foreground tabular-nums">{num(value)}</span>
    </span>
  );
}

function ActivityRow({ icon: Icon, label, text, when, border }: { icon: typeof Send; label: string; text: string; when?: number; border?: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 text-sm ${border ? 'border-t' : ''}`}>
      <div className="flex size-8 items-center justify-center rounded-md bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1 truncate">
        <span className="font-medium">{label}</span> <span className="text-muted-foreground">{text}</span>
      </div>
      {when && <div className="shrink-0 text-xs text-muted-foreground">{ago(when)}</div>}
    </div>
  );
}
