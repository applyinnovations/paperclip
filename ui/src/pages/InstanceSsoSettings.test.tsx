// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceSsoSettings } from "./InstanceSsoSettings";
const api = vi.hoisted(() => ({ getSso: vi.fn(), updateSso: vi.fn() }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: api }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
let root: Root;
let container: HTMLDivElement;
let settings: any;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings = { source: "database", enabled: true, providers: [{ providerId: "keycloak", type: "keycloak", clientId: "client", clientSecret: "synthetic-secret", issuer: "https://identity.example.test/realms/main" }] };
  api.getSso.mockImplementation(async () => settings);
  api.updateSso.mockReset(); api.updateSso.mockImplementation(async patch => { settings = { ...settings, ...patch }; return settings; });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><InstanceSsoSettings /></QueryClientProvider>));
  await flush(); await flush();
}
async function selectSource(value: string) {
  const select = container.querySelector('select[aria-label="SSO configuration source"]') as HTMLSelectElement;
  await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function save() {
  const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Save SSO Settings")!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click()); await flush();
}
describe("native SSO configuration source", () => {
  it("returns to operator configuration without overwriting stored provider secrets", async () => {
    await render(); await selectSource("operator"); await save();
    expect(api.updateSso).toHaveBeenCalledWith({ source: "operator" });
    expect(settings.providers[0].clientSecret).toBe("synthetic-secret");
    expect(container.textContent).not.toContain("automatically added to all");
    expect(container.textContent).toContain("Company access is granted separately");
  });
  it("persists an explicitly disabled database source", async () => {
    settings = { source: "operator", enabled: false, providers: [] };
    await render(); await selectSource("database"); await save();
    expect(api.updateSso).toHaveBeenCalledWith({ source: "database", enabled: false, providers: [] });
    expect((container.querySelector('select[aria-label="SSO configuration source"]') as HTMLSelectElement).value).toBe("database");
    expect(container.querySelector('[aria-label="Toggle SSO"]')?.getAttribute("aria-checked")).toBe("false");
  });
});
