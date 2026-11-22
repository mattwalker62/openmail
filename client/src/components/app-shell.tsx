import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Bot, ChevronsUpDown, LayoutDashboard, LogOut, Mail, NotebookPen, Send, ShieldOff, Users, Workflow } from 'lucide-react';
import { api, type Me } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';

const NAV = [
  { to: '/t/$tenantId', label: 'Overview', icon: LayoutDashboard, exact: true },
  { to: '/t/$tenantId/emails', label: 'Emails', icon: Mail },
  { to: '/t/$tenantId/contacts', label: 'Contacts', icon: Users },
  { to: '/t/$tenantId/automations', label: 'Automations', icon: Workflow },
] as const;

const SETTINGS = [
  { to: '/t/$tenantId/suppressions', label: 'Suppressions', icon: ShieldOff },
  { to: '/t/$tenantId/context', label: 'Voice notes', icon: NotebookPen },
  { to: '/t/$tenantId/agent', label: 'Agent setup', icon: Bot },
] as const;

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
}

/** OpenSEO-style shell: business switcher at the top of a sectioned sidebar, the page beside it. */
export function AppShell() {
  const { data: me } = useMe();
  const params = useParams({ strict: false }) as { tenantId?: string; campaignId?: string };
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  // The approval link carries only the campaign, so take the business from the send itself.
  const { data: intent } = useQuery({
    queryKey: ['intent', params.campaignId],
    queryFn: () => api<{ tenantId: string }>(`/approve/${params.campaignId}`),
    enabled: !!params.campaignId,
  });
  const tenantId = params.tenantId ?? intent?.tenantId ?? (params.campaignId ? undefined : me?.tenants[0]?.id);
  const current = me?.tenants.find((t) => t.id === tenantId);

  return (
    <div className="flex min-h-screen bg-muted/30">
      <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r bg-sidebar p-3">
        <div className="flex items-center gap-2 px-2 pb-3 pt-1 text-base font-semibold tracking-tight">
          <Send className="size-4" /> openmail
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center justify-between rounded-lg border bg-background px-3 py-2 text-left text-sm shadow-xs hover:bg-accent">
            <span className="truncate font-medium">{current?.name ?? 'Choose a business'}</span>
            <ChevronsUpDown className="size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            {me?.tenants.map((t) => (
              <DropdownMenuItem key={t.id} onClick={() => navigate({ to: '/t/$tenantId', params: { tenantId: t.id } })}>
                {t.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {tenantId && <NavGroup items={NAV} tenantId={tenantId} path={path} className="mt-5" />}
        {tenantId && <NavGroup title="Settings" items={SETTINGS} tenantId={tenantId} path={path} className="mt-5" />}

        <div className="mt-auto">
          <Separator className="my-3" />
          <div className="truncate px-2 text-xs text-muted-foreground">{me?.email}</div>
          <form method="post" action="/logout">
            <button type="submit" className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent">
              <LogOut className="size-4" /> Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-8">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function NavGroup({
  title,
  items,
  tenantId,
  path,
  className,
}: {
  title?: string;
  items: ReadonlyArray<{ to: string; label: string; icon: typeof Send; exact?: boolean }>;
  tenantId: string;
  path: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {title && <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">{title}</div>}
      <nav className="flex flex-col gap-0.5">
        {items.map(({ to, label, icon: Icon, exact }) => {
          const href = to.replace('$tenantId', tenantId);
          const active = exact ? path === href || path === `${href}/` : path.startsWith(href);
          return (
            <Link
              key={to}
              to={to}
              params={{ tenantId }}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent',
                active && 'bg-sidebar-accent font-medium',
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}
