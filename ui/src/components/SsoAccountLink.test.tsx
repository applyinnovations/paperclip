// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsoAccountLink } from "./SsoAccountLink";
const auth = vi.hoisted(() => ({ getSsoProviders: vi.fn(), linkSso: vi.fn() }));
vi.mock("../api/auth", () => ({ authApi: auth }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  auth.getSsoProviders.mockResolvedValue([]);
  auth.linkSso.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe("SSO linking controls", () => {
  it("stays absent when no SSO provider is available", async () => {
    await act(async () => root.render(<SsoAccountLink />));
    expect(container.textContent).toBe("");
  });
  it("requires the current password and clears it after a rejected link", async () => {
    auth.getSsoProviders.mockResolvedValue([{ providerId: "keycloak", displayName: "Keycloak", type: "keycloak" }]);
    auth.linkSso.mockRejectedValue(new Error("Confirm the current local password before linking."));
    await act(async () => root.render(<SsoAccountLink />));
    expect(container.querySelector("button")?.disabled).toBe(true);
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "synthetic-password");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(auth.linkSso).toHaveBeenCalledWith("keycloak", "synthetic-password", window.location.pathname);
    expect(input.value).toBe("");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Confirm the current local password");
  });
});
