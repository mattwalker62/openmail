import { useState } from 'react';
import { BarChart3, LayoutDashboard, Send, UserPlus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const params = () => new URLSearchParams(window.location.search);

async function submit(path: string, body: Record<string, string>): Promise<string> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as { redirect?: string; error?: string };
  if (!res.ok || !out.redirect) throw new Error(out.error ?? 'Something went wrong. Try again.');
  return out.redirect;
}

function useSubmit(path: string) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: React.FormEvent<HTMLFormElement>, extra: Record<string, string> = {}) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const fields = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      window.location.assign(await submit(path, { ...fields, ...extra }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return { error, busy, onSubmit };
}

/** Split screen: the form on a dark panel, a quiet picture of the product beside it. */
function AuthLayout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="dark flex flex-col bg-neutral-950 p-8 text-neutral-50">
        <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Send className="size-5" /> openmail
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center">
          <h1 className="mb-8 font-serif text-4xl tracking-tight">{title}</h1>
          {children}
        </div>
      </div>
      <div className="hidden flex-col justify-center overflow-hidden bg-neutral-900 pl-16 text-neutral-50 lg:flex">
        <h2 className="max-w-md font-serif text-4xl leading-tight tracking-tight">Your agents write. You approve. It sends.</h2>
        <p className="mt-4 max-w-md text-sm text-neutral-400">
          One email service for every business you run. Agents draft and schedule through MCP; nothing reaches a list until you say so.
        </p>
        <ProductPicture />
      </div>
    </div>
  );
}

/** A static sketch of the dashboard, drawn with the same tokens; no real data. */
function ProductPicture() {
  const nav = [
    [LayoutDashboard, 'Overview'],
    [Send, 'Emails'],
    [Users, 'Contacts'],
    [BarChart3, 'Automations'],
  ] as const;
  return (
    <div className="relative mt-10 -mr-24 flex h-80 rounded-l-xl border border-neutral-800 bg-neutral-950 text-xs">
      <div className="w-40 border-r border-neutral-800 p-3">
        <div className="mb-4 flex items-center gap-1.5 font-medium">
          <Send className="size-3.5" /> openmail
        </div>
        {nav.map(([Icon, label], i) => (
          <div key={label} className={`mb-1 flex items-center gap-2 rounded px-2 py-1.5 ${i === 0 ? 'bg-neutral-800' : 'text-neutral-400'}`}>
            <Icon className="size-3.5" /> {label}
          </div>
        ))}
      </div>
      <div className="flex-1 p-4">
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-neutral-800 bg-neutral-800">
          {['Sent', 'Waiting', 'Contacts'].map((l) => (
            <div key={l} className="bg-neutral-950 p-3">
              <div className="text-neutral-500">{l}</div>
              <div className="mt-2 h-3 w-12 rounded bg-neutral-700" />
            </div>
          ))}
        </div>
        <svg viewBox="0 0 300 80" className="mt-6 h-24 w-full text-neutral-500" preserveAspectRatio="none">
          <polyline points="0,70 40,64 80,60 120,52 160,48 200,40 240,30 300,18" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
      <div className="absolute -bottom-6 left-6 flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 shadow-lg">
        <UserPlus className="size-4 text-neutral-400" />
        <div>
          <div className="font-medium">Waiting for you</div>
          <div className="text-neutral-400">Your agent drafted this week's issue</div>
        </div>
      </div>
    </div>
  );
}

function ErrorLine({ error }: { error: string }) {
  return error ? (
    <p role="alert" className="text-sm text-red-400">
      {error}
    </p>
  ) : null;
}

export function LoginPage() {
  const { error, busy, onSubmit } = useSubmit('/login');
  return (
    <AuthLayout title="Sign in to openmail">
      <form className="flex flex-col gap-4" onSubmit={(e) => onSubmit(e, { next: params().get('next') ?? '/' })}>
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <ErrorLine error={error} />
        <Button type="submit" size="lg" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <p className="text-sm text-neutral-400">
          Invited as an owner?{' '}
          <a className="text-neutral-50 underline underline-offset-4" href="/signup">
            Create your account
          </a>
        </p>
      </form>
    </AuthLayout>
  );
}

export function SignupPage() {
  const { error, busy, onSubmit } = useSubmit('/signup');
  return (
    <AuthLayout title="Create your account">
      <form className="flex flex-col gap-4" onSubmit={(e) => onSubmit(e, { invite: params().get('invite') ?? '' })}>
        <div className="grid gap-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" autoComplete="name" required autoFocus />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="email">Email (the one you were invited with)</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password (12+ characters)</Label>
          <Input id="password" name="password" type="password" minLength={12} autoComplete="new-password" required />
        </div>
        <ErrorLine error={error} />
        <Button type="submit" size="lg" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  );
}
