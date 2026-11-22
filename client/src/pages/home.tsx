import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ArrowRight, Bot, CalendarClock, CircleCheck, MailWarning, NotebookPen, PenLine, Send, ShieldAlert, UserPlus } from 'lucide-react';
import { PageHeader, useMe } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { ago, num, pct } from '@/lib/format';

type Home = {
  days: number;
  period: { newSubscribers: number; emailsSent: number; awaitingApproval: number; scheduled: number; bouncesAndComplaints: number };
  totals: { contacts: number; contactsAtStart: number };
  scorecard: { sent: number; bounceRate: number | null; complaintRate: number | null; unsubscribeRate: number | null };
  recent: { lastSend: { subject: string; sentAt: number; delivered: number } | null; lastSignup: { email: string; at: number } | null };
  contactsOverTime: Array<{ date: string; total: number }>;
  recommendations: Array<{ kind: string; title: string; detail: string; href: string }>;
};

const REC_ICON: Record<string, typeof Send> = { approve: CircleCheck, finish_draft: PenLine, write_to_readers: Send, add_context: NotebookPen };

export function HomePage() {
  const { tenantId } = useParams({ strict: false }) as { tenantId: string };
  const [days, setDays] = useState('7');
  const { data: me } = useMe();
  const { data: h } = useQuery({ queryKey: ['home', tenantId, days], queryFn: () => api<Home>(`/t/${tenantId}/home?days=${days}`) });
  const business = me?.tenants.find((t) => t.id === tenantId)?.name;
  const range = `Last ${days} days`;

  return (
    <>
      <PageHeader
        title={business ? `${business}` : 'Overview'}
        description="How your audience is doing."
        actions={
          <div className="flex items-center gap-2">
            <Select value={days} onValueChange={(v) => setDays(String(v))}>
              <SelectTrigger className="w-36">
                <SelectValue>{(v: string) => `Last ${v} days`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" nativeButton={false} render={<Link to="/t/$tenantId/agent" params={{ tenantId }} />}>
              <Bot /> Ask your agent
            </Button>
          </div>
        }
      />

      {!h ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="flex flex-col gap-8">
          <section>
            <SectionTitle title="Recent activity" />
            <Card className="gap-0 py-0">
              <ActivityRow
                icon={Send}
                label="Last email sent"
                text={h.recent.lastSend ? `"${h.recent.lastSend.subject}" reached ${num(h.recent.lastSend.delivered)} inboxes` : 'Nothing sent yet'}
                when={h.recent.lastSend?.sentAt}
              />
              <ActivityRow icon={UserPlus} label="Last signup" text={h.recent.lastSignup?.email ?? 'No contacts yet'} when={h.recent.lastSignup?.at} border />
            </Card>
          </section>

          <section>
            <SectionTitle title={days === '7' ? 'This week' : range} />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              <StatCard icon={UserPlus} value={h.period.newSubscribers} label="new subscribers" range={range} />
              <StatCard icon={Send} value={h.period.emailsSent} label="emails sent" range={range} />
              <StatCard
                icon={CircleCheck}
                value={h.period.awaitingApproval}
                label="waiting for approval"
                range="Now"
                link={h.period.awaitingApproval ? { to: '/t/$tenantId/emails', text: 'Review' } : undefined}
                tenantId={tenantId}
              />
              <StatCard icon={CalendarClock} value={h.period.scheduled} label="emails scheduled" range="Upcoming" />
              <StatCard
                icon={MailWarning}
                value={h.period.bouncesAndComplaints}
                label="bounces and complaints"
                range={range}
                link={{ to: '/t/$tenantId/suppressions', text: 'See suppressions' }}
                tenantId={tenantId}
              />
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <Card>
                  <CardContent>
                    <div className="text-sm text-muted-foreground">Total contacts</div>
                    <div className="mt-2 text-4xl font-semibold tracking-tight">{num(h.totals.contacts)}</div>
                    <Change now={h.totals.contacts} before={h.totals.contactsAtStart} days={days} />
                  </CardContent>
                </Card>
                <Card>
                  <CardContent>
                    <div className="text-sm text-muted-foreground">Emails sent</div>
                    <div className="mt-2 text-4xl font-semibold tracking-tight">{num(h.scorecard.sent)}</div>
                    <div className="mt-2 text-xs text-muted-foreground">{range}</div>
                  </CardContent>
                </Card>
              </div>
              <Card className="flex-1">
                <CardHeader>
                  <CardTitle className="flex justify-between text-sm font-normal text-muted-foreground">
                    Contacts over time <span className="text-xs">{range}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Sparkline points={h.contactsOverTime} />
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Performance scorecard</CardTitle>
                {h.scorecard.sent === 0 && <Badge variant="secondary">No sends in this range</Badge>}
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <ScoreRow label="Open rate" value={null} pending />
                <ScoreRow label="Click rate" value={null} pending />
                <ScoreRow label="Bounce rate" value={h.scorecard.bounceRate} />
                <ScoreRow label="Unsubscribe rate" value={h.scorecard.unsubscribeRate} />
                <ScoreRow label="Spam complaint rate" value={h.scorecard.complaintRate} />
              </CardContent>
            </Card>
          </div>

          {h.recommendations.length > 0 && (
            <section>
              <SectionTitle title="Recommended actions" />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {h.recommendations.map((r) => {
                  const Icon = REC_ICON[r.kind] ?? ShieldAlert;
                  return (
                    <a key={r.kind} href={r.href} className="flex gap-3 rounded-xl border bg-card p-4 hover:bg-accent/50">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <Icon className="size-4" />
                      </div>
                      <div>
                        <div className="text-sm font-medium">{r.title}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{r.detail}</div>
                      </div>
                    </a>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <h2 className="mb-3 text-sm font-medium">{title}</h2>;
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

function StatCard(props: {
  icon: typeof Send;
  value: number;
  label: string;
  range: string;
  link?: { to: '/t/$tenantId/emails' | '/t/$tenantId/suppressions'; text: string };
  tenantId?: string;
}) {
  const Icon = props.icon;
  return (
    <Card className="gap-3 py-4">
      <CardContent className="flex h-full flex-col px-4">
        <div className="flex items-center justify-between">
          <div className="flex size-8 items-center justify-center rounded-md bg-muted">
            <Icon className="size-4 text-muted-foreground" />
          </div>
          <span className="text-xs text-muted-foreground">{props.range}</span>
        </div>
        <div className={`mt-3 text-3xl font-semibold tracking-tight ${props.value === 0 ? 'text-muted-foreground/60' : ''}`}>{num(props.value)}</div>
        <div className="text-sm">{props.label}</div>
        {props.link && props.tenantId && (
          <Link to={props.link.to} params={{ tenantId: props.tenantId }} className="mt-auto pt-3 text-xs font-medium hover:underline">
            {props.link.text} <ArrowRight className="inline size-3" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function Change({ now, before, days }: { now: number; before: number; days: string }) {
  const diff = now - before;
  const text = before === 0 ? (diff > 0 ? `+${num(diff)}` : 'No change') : `${diff >= 0 ? '+' : ''}${((diff / before) * 100).toFixed(1)}%`;
  return (
    <div className="mt-2 text-xs text-muted-foreground">
      <span className={diff > 0 ? 'font-medium text-emerald-600' : ''}>{text}</span> vs {days} days ago
    </div>
  );
}

function ScoreRow({ label, value, pending }: { label: string; value: number | null; pending?: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        {pending ? <Badge variant="outline">Not connected yet</Badge> : <span className="font-medium tabular-nums">{pct(value)}</span>}
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-muted">
        {!pending && value !== null && <div className="h-full rounded-full bg-foreground" style={{ width: `${Math.min(100, value * 100)}%` }} />}
      </div>
    </div>
  );
}

/** A plain SVG line: enough for one series, no chart library. */
function Sparkline({ points }: { points: Array<{ date: string; total: number }> }) {
  const W = 400;
  const H = 120;
  const max = Math.max(1, ...points.map((p) => p.total));
  const min = Math.min(...points.map((p) => p.total));
  const span = Math.max(1, max - min);
  const xy = points.map((p, i) => [(i / Math.max(1, points.length - 1)) * W, H - 8 - ((p.total - min) / span) * (H - 16)] as const);
  const last = points.at(-1);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-32 w-full" preserveAspectRatio="none" role="img" aria-label="Contacts over time">
        <polyline points={xy.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{points[0]?.date}</span>
        <span>
          {last?.date} · {num(last?.total ?? 0)}
        </span>
      </div>
    </div>
  );
}
