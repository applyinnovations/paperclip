import { useEffect, useState, type FormEvent } from "react";
import { authApi, type SsoProvider } from "../api/auth";
import { Button } from "./ui/button";

export function SsoAccountLink() {
  const [providers, setProviders] = useState<SsoProvider[]>([]);
  const [provider, setProvider] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void authApi.getSsoProviders().then(items => {
      if (active) { setProviders(items); setProvider(items[0]?.providerId ?? ""); }
    });
    return () => { active = false; };
  }, []);
  if (!providers.length) return null;
  async function link(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const url = await authApi.linkSso(provider, password, window.location.pathname);
      setPassword("");
      window.location.assign(url);
    } catch (failure) {
      setPassword(""); setBusy(false);
      setError(failure instanceof Error ? failure.message : "Could not link this account.");
    }
  }
  return <section className="rounded-xl border border-border bg-card p-5 space-y-3">
    <h2 className="text-sm font-semibold">Link an SSO account</h2>
    <p className="text-sm text-muted-foreground">Confirm your local Paperclip password, then sign in with the provider using the same email. Local password sign-in remains available.</p>
    <form onSubmit={link} className="space-y-3">
      <label className="block text-sm">Identity provider
        <select aria-label="Identity provider" value={provider} onChange={e => setProvider(e.target.value)} disabled={busy}
          className="block w-full rounded-md border border-input bg-background px-3 py-2">
          {providers.map(item => <option key={item.providerId} value={item.providerId}>{item.displayName}</option>)}
        </select>
      </label>
      <label className="block text-sm">Current Paperclip password
        <input aria-label="Current Paperclip password" type="password" autoComplete="current-password" required value={password}
          onChange={e => setPassword(e.target.value)} disabled={busy} className="block w-full rounded-md border border-input bg-background px-3 py-2" />
      </label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy || !password}>{busy ? "Connecting..." : "Link SSO account"}</Button>
    </form>
  </section>;
}
