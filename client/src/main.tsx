import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Navigate, Outlet, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell, useMe } from '@/components/app-shell';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { ApprovePage } from '@/pages/approve';
import { LoginPage, SignupPage } from '@/pages/auth';
import { ContactsPage } from '@/pages/contacts';
import { EmailsPage } from '@/pages/emails';
import { HomePage } from '@/pages/home';
import { AgentPage, ContextPage, PoliciesPage, SuppressionsPage } from '@/pages/settings';
import './app.css';

/** "/" goes to the first business the owner owns. */
function Home() {
  const { data } = useMe();
  if (!data) return <Skeleton className="h-40 w-full" />;
  const first = data.tenants[0];
  return first ? <Navigate to="/t/$tenantId" params={{ tenantId: first.id }} /> : <p>Your account does not own a business yet.</p>;
}

const root = createRootRoute({ component: () => <Outlet /> });
const shell = createRoute({ getParentRoute: () => root, id: 'shell', component: AppShell });
const home = createRoute({ getParentRoute: () => shell, path: '/', component: Home });
const tenant = createRoute({ getParentRoute: () => shell, path: '/t/$tenantId' });
const overview = createRoute({ getParentRoute: () => tenant, path: '/', component: HomePage });
const emails = createRoute({ getParentRoute: () => tenant, path: '/emails', component: EmailsPage });
const contacts = createRoute({ getParentRoute: () => tenant, path: '/contacts', component: ContactsPage });
const suppressions = createRoute({ getParentRoute: () => tenant, path: '/suppressions', component: SuppressionsPage });
const policies = createRoute({ getParentRoute: () => tenant, path: '/automations', component: PoliciesPage });
const context = createRoute({ getParentRoute: () => tenant, path: '/context', component: ContextPage });
const agent = createRoute({ getParentRoute: () => tenant, path: '/agent', component: AgentPage });
const login = createRoute({ getParentRoute: () => root, path: '/login', component: LoginPage });
const signup = createRoute({ getParentRoute: () => root, path: '/signup', component: SignupPage });
const approve = createRoute({ getParentRoute: () => shell, path: '/approve/$campaignId', component: ApprovePage });

const router = createRouter({
  routeTree: root.addChildren([login, signup, shell.addChildren([home, tenant.addChildren([overview, emails, contacts, suppressions, policies, context, agent]), approve])]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
