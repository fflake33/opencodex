import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { config } from "../helpers/management-relative-send-paths";
import { managementFetch as fetch } from "../helpers/management-auth";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Preserve the original file's budget for multi-step server flows on Windows.
setDefaultTimeout(60_000);

const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-provider-context-windows-"));
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let isolatedCodexHome: IsolatedCodexHome;
let resolvedError: ReturnType<typeof spyOn<typeof destinationPolicy, "providerDestinationResolvedError">>;

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-provider-context-codex-");
  // These cases exercise persisted metadata, not the operator's DNS or destination policy.
  resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
});

afterEach(() => {
  resolvedError.mockRestore();
  isolatedCodexHome.restore();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

// #1409: the add/edit form's payload type has no member for contextWindow or
// modelContextWindows, so an overwrite arrives without them. Registry enrichment then fills
// the absent fields from the seed and the stored row loses the user's values — for
// opencode-go the seed is exactly {"kimi-k3": 262144}, which is what the reporter found in
// place of their deepseek-v4-flash override.
describe("provider POST overwrite preserves hand-edited context windows (#1409)", () => {
  async function seedProvider(url: URL, extra: Record<string, unknown>): Promise<Response> {
    return fetch(new URL("/api/providers", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "opencode-go",
        provider: { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k", ...extra },
      }),
    });
  }

  function freshHome(): void {
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));
  }

  test("an omitted modelContextWindows keeps the user's map, without registry seed keys", async () => {
    freshHome();
    const server = startServer(0);
    try {
      expect((await seedProvider(server.url, {
        modelContextWindows: { "deepseek-v4-flash": 900000 },
        modelAutoCompactTokenLimits: { "deepseek-v4-flash": 120000 },
      })).status).toBe(200);
      expect((await seedProvider(server.url, {})).status).toBe(200);

      // The user's key survives, and the registry seed is NOT persisted into user config:
      // router.ts fills registry values beneath user entries at resolve time, so writing
      // them here would be a side effect of an unrelated save.
      expect(loadConfig().providers["opencode-go"]?.modelContextWindows).toEqual({ "deepseek-v4-flash": 900000 });
      expect(loadConfig().providers["opencode-go"]?.modelAutoCompactTokenLimits)
        .toEqual({ "deepseek-v4-flash": 120000 });
    } finally {
      await server.stop(true);
    }
  });

  test("a submitted modelContextWindows updates that key and keeps the others", async () => {
    freshHome();
    const server = startServer(0);
    try {
      expect((await seedProvider(server.url, {
        modelContextWindows: { "deepseek-v4-flash": 900000 },
        modelAutoCompactTokenLimits: { "deepseek-v4-flash": 120000 },
      })).status).toBe(200);
      expect((await seedProvider(server.url, {
        modelContextWindows: { "kimi-k3": 300000 },
        modelAutoCompactTokenLimits: { "kimi-k3": 90000 },
      })).status).toBe(200);

      expect(loadConfig().providers["opencode-go"]?.modelContextWindows)
        .toEqual({ "deepseek-v4-flash": 900000, "kimi-k3": 300000 });
      expect(loadConfig().providers["opencode-go"]?.modelAutoCompactTokenLimits)
        .toEqual({ "deepseek-v4-flash": 120000, "kimi-k3": 90000 });
    } finally {
      await server.stop(true);
    }
  });

  test("an omitted contextWindow keeps the user's scalar", async () => {
    freshHome();
    const server = startServer(0);
    try {
      expect((await seedProvider(server.url, { contextWindow: 777000 })).status).toBe(200);
      expect((await seedProvider(server.url, {})).status).toBe(200);

      expect(loadConfig().providers["opencode-go"]?.contextWindow).toBe(777000);
    } finally {
      await server.stop(true);
    }
  });

  test("a submitted contextWindow still wins", async () => {
    freshHome();
    const server = startServer(0);
    try {
      expect((await seedProvider(server.url, { contextWindow: 777000 })).status).toBe(200);
      expect((await seedProvider(server.url, { contextWindow: 512000 })).status).toBe(200);

      expect(loadConfig().providers["opencode-go"]?.contextWindow).toBe(512000);
    } finally {
      await server.stop(true);
    }
  });

  test("a brand-new provider still receives the registry seed", async () => {
    freshHome();
    const server = startServer(0);
    try {
      expect((await seedProvider(server.url, {})).status).toBe(200);

      // No prior row exists, so enrichment is authoritative and the seed must land.
      expect(loadConfig().providers["opencode-go"]?.modelContextWindows).toBeDefined();
    } finally {
      await server.stop(true);
    }
  });

  test("PATCH can still delete a key with an explicit null", async () => {
    freshHome();
    const server = startServer(0);
    try {
      expect((await seedProvider(server.url, { modelContextWindows: { "deepseek-v4-flash": 900000 } })).status).toBe(200);

      const patch = await fetch(new URL("/api/providers?name=opencode-go", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelContextWindows: { "deepseek-v4-flash": null } }),
      });
      expect(patch.status).toBe(200);

      // Deletion is an explicit null through PATCH, which the POST carry-over must not undo.
      expect(loadConfig().providers["opencode-go"]?.modelContextWindows?.["deepseek-v4-flash"]).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});
