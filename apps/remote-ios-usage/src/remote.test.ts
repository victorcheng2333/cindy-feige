// Unit: the new controller must keep account ownership, partial failures and
// logout fencing. Existing Mobile tests do not exercise this independent client.
import { beforeEach, expect, it, vi } from "vitest";
const vault = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: vi.fn(async (key: string) => vault.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    vault.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    vault.delete(key);
  }),
}));
beforeEach(() => vault.clear());
import { Remote } from "./remote";
import * as SecureStore from "expo-secure-store";
import {
  AuthApiError,
  type CindyAuthClient,
} from "../../../packages/auth-client/src/index";
const make = () => {
  const r = new Remote({} as CindyAuthClient);
  const invoke = vi.fn();
  r.connect = vi.fn(async () => ({ openLink: vi.fn(), invoke }) as any);
  return { r, invoke };
};
it("keeps two Claude accounts separate and rejects an unscoped legacy reply", async () => {
  const { r, invoke } = make();
  invoke.mockImplementation(async (_d, p) => ({
    ok: true,
    result:
      p.channel === "maker:provider:list"
        ? {
            providers: ["a", "b"].map((id) => ({
              id,
              name: id,
              connected: true,
              auth: { method: "oauth", native: "claude" },
            })),
          }
        : p.args[0] === "a"
          ? {
              providerId: "a",
              fiveHour: { utilization: 78 },
              sevenDay: { utilization: 28 },
            }
          : { fiveHour: { utilization: 0 } },
  }));
  const result = await r.usage("mac");
  expect(result[0].windows.map((w) => w.left)).toEqual([22, 72]);
  expect(result[1]).toMatchObject({ failed: true, windows: [] });
});
it("fails the catalog read rather than presenting a fake empty success", async () => {
  const { r, invoke } = make();
  invoke.mockResolvedValue({ ok: false });
  await expect(r.usage("mac")).rejects.toThrow();
});
it("does not send a new invoke after logout during connection", async () => {
  const { r, invoke } = make();
  r.connect = vi.fn(async () => {
    await r.logout();
    return { openLink: vi.fn(), invoke } as any;
  });
  await expect(r.usage("mac")).rejects.toThrow("连接已结束");
  expect(invoke).not.toHaveBeenCalled();
});

// User-reported regression: cold launch and Back must not destroy a saved login.
// Minimal input: a valid vault session plus a failed refresh; no real keychain/network.
const tokens = {
  accessToken: "test-access",
  refreshToken: "test-refresh",
  membership: {
    id: "member",
    kind: "org" as const,
    role: "member" as const,
    displayName: "Test",
    email: null,
    orgId: "xd",
    orgName: "XD",
  },
};
it("keeps logout retryable when keychain deletion fails, then removes the saved login on retry", async () => {
  const remote = new Remote({} as CindyAuthClient);
  await remote.saveSession(tokens);
  vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(
    new Error("keychain unavailable"),
  );
  await expect(remote.logout()).rejects.toThrow("退出登录未完成");
  expect(remote.tokens).toEqual(tokens);
  expect(vault.has("usage-cn-session")).toBe(true);
  await remote.logout();
  expect(remote.tokens).toBeNull();
  const restarted = new Remote({} as CindyAuthClient);
  await restarted.restoreSession();
  expect(restarted.tokens).toBeNull();
});
it("restores login before network access and keeps it after disconnect/back", async () => {
  const auth = { refresh: vi.fn() } as unknown as CindyAuthClient;
  const r = new Remote(auth);
  await r.saveSession(tokens);
  r.disconnect();
  const restarted = new Remote(auth);
  await restarted.restoreSession();
  expect(restarted.tokens).toEqual(tokens);
  expect(auth.refresh).not.toHaveBeenCalled();
  await restarted.logout();
  const afterLogout = new Remote(auth);
  await afterLogout.restoreSession();
  expect(afterLogout.tokens).toBeNull();
});
it("retains login on transient refresh failure but clears a definitively rejected refresh token", async () => {
  const auth = {
    refresh: vi.fn().mockRejectedValue(new Error("network")),
  } as unknown as CindyAuthClient;
  const r = new Remote(auth);
  await r.saveSession(tokens);
  await expect(r.accessToken(true)).rejects.toThrow("network");
  expect(r.tokens).toEqual(tokens);
  expect(vault.has("usage-cn-session")).toBe(true);
  vi.mocked(auth.refresh).mockRejectedValue(
    new AuthApiError("INVALID_REFRESH_TOKEN", 401, "invalid"),
  );
  await expect(r.accessToken(true)).rejects.toThrow();
  expect(r.tokens).toBeNull();
  expect(vault.has("usage-cn-session")).toBe(false);
});
it("does not resurrect a login when a late refresh completes after logout", async () => {
  let finish!: (value: typeof tokens) => void;
  const auth = {
    refresh: vi.fn(
      () =>
        new Promise<typeof tokens>((resolve) => {
          finish = resolve;
        }),
    ),
  } as unknown as CindyAuthClient;
  const r = new Remote(auth);
  await r.saveSession(tokens);
  const pending = r.accessToken(true);
  const rejected = expect(pending).rejects.toThrow("取消");
  await r.logout();
  finish({ ...tokens, accessToken: "late" });
  await rejected;
  expect(r.tokens).toBeNull();
  expect(vault.has("usage-cn-session")).toBe(false);
});
it("reads ChatGPT generic quota instead of the most recent model-specific bucket and isolates custom accounts", async () => {
  const { r, invoke } = make();
  const generic = {
    primary: { usedPercent: 32, windowMinutes: 300 },
    secondary: { usedPercent: 0, windowMinutes: 10080 },
  };
  const special = { primary: { usedPercent: 99, windowMinutes: 60 } };
  invoke.mockImplementation(async (_d, p) => ({
    ok: true,
    result:
      p.channel === "maker:provider:list"
        ? {
            providers: ["openai", "second"].map((id) => ({
              id,
              connected: true,
              auth: { method: "oauth", native: "codex" },
            })),
          }
        : p.args.length
          ? { providerId: "openai", rateLimits: generic }
          : {
              account: { planType: "pro" },
              rateLimits: special,
              rateLimitsByLimitId: { codex: generic, special },
            },
  }));
  const result = await r.usage("mac");
  expect(result[0]).toMatchObject({
    service: "ChatGPT",
    plan: "pro",
    failed: false,
  });
  expect(result[0].windows.map((w) => [w.minutes, w.left])).toEqual([
    [300, 68],
    [10080, 100],
  ]);
  expect(result[1]).toMatchObject({ failed: true, windows: [] });
  expect(
    invoke.mock.calls
      .filter((c) => c[1].channel !== "maker:provider:list")
      .map((c) => c[1]),
  ).toEqual([
    { channel: "maker:usage:codex-rate-limits", args: [] },
    { channel: "maker:usage:codex-rate-limits", args: ["second"] },
  ]);
});

// Mixed host catalog order must not interleave services in the phone overview.
it("groups Anthropic accounts before OpenAI while retaining order within each service", async () => {
  const { r, invoke } = make();
  const providers = [
    ["openai", "codex"],
    ["claude-b", "claude"],
    ["openai-other", "codex"],
    ["claude-a", "claude"],
  ].map(([id, native]) => ({
    id,
    connected: true,
    auth: { method: "oauth", native },
  }));
  invoke.mockImplementation(async (_d, p) => ({
    ok: true,
    result:
      p.channel === "maker:provider:list"
        ? { providers }
        : { providerId: p.args[0] ?? "openai" },
  }));
  expect((await r.usage("mac")).map((account) => account.id)).toEqual([
    "claude-b",
    "claude-a",
    "openai",
    "openai-other",
  ]);
});

it("blocks a new refresh while keychain deletion is pending so logout cannot resurrect the session", async () => {
  const auth = {
    refresh: vi.fn().mockResolvedValue(tokens),
  } as unknown as CindyAuthClient;
  const remote = new Remote(auth);
  await remote.saveSession(tokens);
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementationOnce(
    (key) =>
      new Promise<void>((resolve) => {
        finish = () => {
          vault.delete(key);
          resolve();
        };
        entered();
      }),
  );
  const logout = remote.logout();
  await started;
  await expect(remote.accessToken(true)).rejects.toThrow("正在退出登录");
  await expect(remote.saveSession(tokens)).rejects.toThrow("正在退出登录");
  await expect(remote.connect()).rejects.toThrow("正在退出登录");
  expect(auth.refresh).not.toHaveBeenCalled();
  finish();
  await logout;
  const restarted = new Remote(auth);
  await restarted.restoreSession();
  expect(restarted.tokens).toBeNull();
});
