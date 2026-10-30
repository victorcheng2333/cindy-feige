import {
  CindyAuthClient,
  AuthApiError,
  tokenPairSchema,
  type AuthTokenPair,
} from "../../../packages/auth-client/src/index";
import {
  DeviceLinkClient,
  PROTOCOL_VERSION,
} from "../../../packages/device-link/src/index";
import * as SecureStore from "expo-secure-store";
import endpoints from "../../../config/endpoint.json";
import { createRnWebSocket } from "./socket";
import { selectCodexUsageForModel } from "../../../packages/maker-shared/src/codexUsageBuckets";
const SESSION_KEY = "usage-cn-session";
let storageQueue: Promise<unknown> = Promise.resolve();
function store(action: () => Promise<void>) {
  const result = storageQueue.catch(() => {}).then(action);
  storageQueue = result;
  return result;
}
export type Device = {
  deviceId: string;
  name: string;
  online: boolean;
  remoteControlEnabled: boolean;
  platform: string;
};
export type Quota = {
  minutes: number | null;
  left: number;
  reset: number | null;
  label?: string;
};
export type Account = {
  id: string;
  name: string;
  plan: string;
  service: "Claude" | "ChatGPT";
  windows: Quota[];
  updated: number | null;
  failed: boolean;
};
export class Remote {
  tokens: AuthTokenPair | null = null;
  link: DeviceLinkClient | null = null;
  generation = 0;
  private refreshedAt = 0;
  private loggingOut = false;
  private refreshing: Promise<string> | null = null;
  constructor(readonly auth: CindyAuthClient) {}
  async saveSession(tokens: AuthTokenPair, generation = this.generation) {
    if (this.loggingOut) throw Error("正在退出登录，请稍后");
    if (generation !== this.generation) throw Error("登录已取消");
    await store(() =>
      SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(tokens), {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      }),
    );
    if (generation !== this.generation) throw Error("登录已取消");
    this.tokens = tokens;
    this.refreshedAt = Date.now();
  }
  async restoreSession() {
    await storageQueue.catch(() => {});
    const saved = await SecureStore.getItemAsync(SESSION_KEY);
    if (!saved) return;
    try {
      this.tokens = tokenPairSchema.parse(JSON.parse(saved));
    } catch {
      await store(() => SecureStore.deleteItemAsync(SESSION_KEY));
    }
  }
  disconnect() {
    this.generation++;
    this.link?.stop();
    this.link = null;
  }
  async accessToken(force = false): Promise<string> {
    if (this.loggingOut) throw Error("正在退出登录，请稍后");
    if (!this.tokens) throw Error("请先登录");
    if (!force && Date.now() - this.refreshedAt < 5 * 60_000)
      return this.tokens.accessToken;
    if (this.refreshing) return this.refreshing;
    const generation = this.generation,
      refreshToken = this.tokens.refreshToken;
    const pending = (async () => {
      try {
        const tokens = await this.auth.refresh(refreshToken);
        await this.saveSession(tokens, generation);
        return tokens.accessToken;
      } catch (error) {
        if (
          generation === this.generation &&
          error instanceof AuthApiError &&
          (error.statusCode === 401 ||
            ["INVALID_REFRESH_TOKEN", "SESSION_REVOKED"].includes(error.code))
        )
          await this.logout();
        throw error;
      }
    })();
    this.refreshing = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = null;
    }
  }
  static async create() {
    let id = await SecureStore.getItemAsync("usage-device");
    if (!id) {
      id = `usage-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await SecureStore.setItemAsync("usage-device", id);
    }
    const remote = new Remote(
      new CindyAuthClient({
        baseUrl: endpoints.authApiBaseUrl,
        region: "cn",
        deviceId: id,
        clientType: "mobile",
        locale: "zh-CN",
        fetch,
      }),
    );
    await remote.restoreSession();
    return remote;
  }
  async logout() {
    if (this.loggingOut) throw Error("正在退出登录，请稍后");
    this.loggingOut = true;
    this.generation++;
    this.link?.stop();
    this.link = null;
    try {
      await store(() => SecureStore.deleteItemAsync(SESSION_KEY));
      this.tokens = null;
      this.refreshedAt = 0;
    } catch {
      throw Error("退出登录未完成，无法清除本机登录记录，请重试。");
    } finally {
      this.loggingOut = false;
    }
  }
  async devices(): Promise<Device[]> {
    if (!this.tokens) throw Error("请先登录");
    const response = await fetch(
      `${endpoints.deviceLinkApiBaseUrl}/api/device-link/devices`,
      {
        headers: { Authorization: `Bearer ${await this.accessToken()}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      throw Error(
        response.status === 401 ? "登录已过期，请重新登录" : "设备列表读取失败",
      );
    return (await response.json()).devices.filter(
      (d: Device) => !["ios", "android"].includes(d.platform),
    );
  }
  async connect() {
    if (this.loggingOut) throw Error("正在退出登录，请稍后");
    if (!this.link) {
      this.link = new DeviceLinkClient({
        getWsUrl: () =>
          endpoints.deviceLinkApiBaseUrl.replace("https:", "wss:") +
          "/api/device-link/ws",
        getToken: async () => (this.tokens ? this.accessToken() : null),
        getHello: () => ({
          deviceName: "Usage Remote",
          platform: "ios",
          appVersion: "0.1.0",
          remoteControlEnabled: false,
          busy: false,
        }),
        createWebSocket: createRnWebSocket,
      });
      this.link.start();
    }
    await this.link.waitUntilOnline(15000);
    return this.link;
  }
  async usage(device: string): Promise<Account[]> {
    const generation = this.generation;
    const link = await this.connect();
    await link.openLink(
      device,
      {
        controllerName: "Usage Remote",
        protocolVersion: PROTOCOL_VERSION,
        appVersion: "0.1.0",
      },
      15000,
    );
    const read = async (channel: string, args: unknown[] = []) => {
      if (generation !== this.generation) throw Error("连接已结束");
      const result = await link.invoke(device, { channel, args }, 15000);
      if (!result.ok) throw Error("电脑未能返回用量，请确认版本和远程连接权限");
      return result.result as any;
    };
    const catalog = await read("maker:provider:list");
    const providers = catalog.providers.filter(
      (p: any) =>
        p.connected &&
        !p.removed &&
        p.auth?.method === "oauth" &&
        (!p.access || p.access.kind === "subscription") &&
        (["claude", "codex"].includes(p.auth.native) ||
          ["anthropic", "openai"].includes(p.id)),
    );
    const accounts: Account[] = [];
    for (const p of providers) {
      const isOpenAi = p.auth.native === "codex" || p.id === "openai";
      const account: Account = {
        id: p.id,
        name: p.name || (isOpenAi ? "ChatGPT" : "Claude"),
        service: isOpenAi ? "ChatGPT" : "Claude",
        plan: "",
        windows: [],
        updated: null,
        failed: false,
      };
      try {
        if (isOpenAi) {
          const raw = await read(
            "maker:usage:codex-rate-limits",
            p.id === "openai" ? [] : [p.id],
          );
          if (
            (raw?.providerId !== undefined && raw.providerId !== p.id) ||
            (p.id !== "openai" && raw?.providerId !== p.id)
          )
            throw Error("账号作用域不支持");
          const bucket = selectCodexUsageForModel({
            fallback: raw?.rateLimits,
            byLimitId: raw?.rateLimitsByLimitId,
          }) as any;
          account.plan = raw?.account?.planType || "";
          account.updated =
            typeof bucket?.updatedAt === "number"
              ? bucket.updatedAt
              : Date.now();
          for (const key of ["primary", "secondary"]) {
            const w = bucket?.[key];
            if (
              typeof w?.usedPercent !== "number" ||
              !Number.isFinite(w.usedPercent)
            )
              continue;
            account.windows.push({
              minutes:
                typeof w.windowMinutes === "number" &&
                Number.isFinite(w.windowMinutes) &&
                w.windowMinutes > 0
                  ? w.windowMinutes
                  : null,
              left: Math.max(0, Math.min(100, 100 - w.usedPercent)),
              reset:
                typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt)
                  ? w.resetsAt
                  : null,
            });
          }
          accounts.push(account);
          continue;
        }
        const raw = await read(
          "maker:usage:claude-subscription",
          p.id === "anthropic" ? [] : [p.id],
        );
        if (p.id !== "anthropic" && raw?.providerId !== p.id)
          throw Error("账号作用域不支持");
        account.plan = raw?.subscriptionType || "";
        account.updated = raw?.updatedAt ?? null;
        const add = (w: any, minutes: number, label?: string) => {
          if (
            typeof w?.utilization === "number" &&
            Number.isFinite(w.utilization)
          )
            account.windows.push({
              minutes,
              label,
              left: Math.max(0, Math.min(100, 100 - w.utilization)),
              reset: typeof w.resetsAt === "number" ? w.resetsAt : null,
            });
        };
        add(raw?.fiveHour, 300);
        add(raw?.sevenDay, 10080);
        for (const w of raw?.scoped ?? []) add(w, 10080, w.modelDisplayName);
      } catch {
        account.failed = true;
      }
      accounts.push(account);
    }
    return accounts.sort(
      (a, b) => Number(a.service !== "Claude") - Number(b.service !== "Claude"),
    );
  }
}
