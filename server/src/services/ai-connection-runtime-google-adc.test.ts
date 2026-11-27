import { describe, expect, it } from "vitest";
import { keepsAmbientGoogleAdc } from "./ai-connection-runtime.js";

describe("keepsAmbientGoogleAdc", () => {
  it("keeps the host Google ADC only for harnesses that cannot use it as AI auth", () => {
    expect(keepsAmbientGoogleAdc("claude_local")).toBe(true);
    expect(keepsAmbientGoogleAdc("codex_local")).toBe(true);
    // Google ADC is (or may be) the AI credential here; unknown harnesses stay blanked by default.
    for (const harness of ["gemini_local", "antigravity_runtime", "opencode_local", "hermes_local", "pi_local", "grok_local", "copilot_runtime", "unsupported"]) {
      expect(keepsAmbientGoogleAdc(harness)).toBe(false);
    }
  });
});
