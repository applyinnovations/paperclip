// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OidcSignIn } from "./OidcSignIn";

const mocks = vi.hoisted(() => ({ getProvider: vi.fn(), begin: vi.fn() }));
vi.mock("@/api/oidc", () => ({ oidcApi: mocks }));

describe("OIDC sign-in and explicit account linking", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.getProvider.mockResolvedValue({ providerId: "team", displayName: "Team identity" });
    mocks.begin.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  async function mount(link = false) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><OidcSignIn callbackURL="/invite/example" link={link} /></QueryClientProvider>));
    await flush();
  }
  it("hides the control when no provider is available", async () => {
    mocks.getProvider.mockResolvedValue(null);
    await mount();
    expect(container.querySelector("button")).toBeNull();
  });
  it("returns the signed-in user to the invitation", async () => {
    await mount();
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Continue with Team identity");
    await act(async () => button.click());
    expect(mocks.begin).toHaveBeenCalledWith("team", "/invite/example", undefined);
  });
  it("requires a password for linking and clears it after failure", async () => {
    mocks.begin.mockRejectedValue(new Error("Cannot link this account."));
    await mount(true);
    const button = container.querySelector("button")!;
    const input = container.querySelector("input")!;
    expect(button.disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "local-password");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    await flush();
    expect(mocks.begin).toHaveBeenCalledWith("team", "/invite/example", "local-password");
    expect(input.value).toBe("");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Cannot link this account.");
  });
});
