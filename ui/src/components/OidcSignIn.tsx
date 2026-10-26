import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { oidcApi } from "@/api/oidc";
import { useLocation } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Without `callbackURL`, the provider returns the user to the current page, org prefix and query included. */
export function OidcSignIn({ callbackURL, link = false }: { callbackURL?: string; link?: boolean }) {
  const location = useLocation();
  const returnTo = callbackURL ?? `${location.pathname}${location.search}`;
  const [password, setPassword] = useState("");
  const provider = useQuery({ queryKey: ["auth", "oidc-provider"], queryFn: oidcApi.getProvider, retry: false });
  const mutation = useMutation({
    mutationFn: async () => {
      if (provider.data) await oidcApi.begin(provider.data.providerId, returnTo, link ? password : undefined);
    },
    onSettled: () => setPassword(""),
  });
  if (!provider.data) return null;
  return (
    <div className="mt-4 space-y-3">
      {link && <>
        <h2 className="text-base font-medium">Single sign-on</h2>
        <p className="text-sm text-muted-foreground">Confirm your Paperclip password, then sign in to the provider with the same email to link your account.</p>
        <Label htmlFor="oidc-link-password">Current Paperclip password</Label>
        <Input id="oidc-link-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </>}
      <Button type="button" variant="outline" className="w-full" disabled={mutation.isPending || (link && !password)} onClick={() => mutation.mutate()}>
        {mutation.isPending ? "Connecting…" : `${link ? "Link" : "Continue with"} ${provider.data.displayName}`}
      </Button>
      {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
    </div>
  );
}
