import { CindyAuthClient, AuthApiError, type AuthTokenPair, type LoginOutcome } from '../../../packages/auth-client/src/index';
import { DeviceLinkClient, PROTOCOL_VERSION, DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1 } from '../../../packages/device-link/src/index';
import WebSocket from 'ws';
import endpoints from '../../../config/endpoint.json';
import manifest from '../package.json';
import { emptyAccount, parseAccount, parseDevices, subscriptionProviders, type Command, type Snapshot } from './model';
import { loginSso } from './sso';
import type { SessionStore } from './storage';

type Link = Pick<DeviceLinkClient, 'start' | 'stop' | 'waitUntilOnline' | 'openLink' | 'invoke' | 'closeLink'>;
interface Dependencies {
  deviceId: string; store: SessionStore; open: (url: string) => Promise<void>;
  publish: (snapshot: Snapshot) => void; auth?: CindyAuthClient;
  fetch?: typeof fetch; createLink?: (getToken: () => Promise<string | null>) => Link;
}
const initial = (): Snapshot => ({ signedIn: false, busy: false, error: null, login: { kind: 'idle' }, devices: [], updatedAt: null, demo: false, selectedDeviceId: null });
export class UsageService {
  private state = initial();
  private tokens: AuthTokenPair | null = null;
  private epoch = 0;
  private freshAt = 0;
  private refreshTokenJob: Promise<string> | null = null;
  private refreshJob: Promise<void> | null = null;
  private actionJob: Promise<void> | null = null;
  private logoutJob: Promise<void> | null = null;
  private link: Link | null = null;
  private abort: AbortController | null = null;
  private pending: LoginOutcome | null = null;
  private codeSentTo: string | null = null;
  private codeAfter = 0;
  private viewRevision = 0;
  private auth: CindyAuthClient;
  private fetcher: typeof fetch;
  constructor(private readonly deps: Dependencies) {
    this.fetcher = deps.fetch ?? fetch;
    this.auth = deps.auth ?? new CindyAuthClient({ baseUrl: endpoints.authApiBaseUrl, region: 'cn',
      deviceId: deps.deviceId, clientType: 'desktop', locale: 'zh-CN', fetch: this.fetcher, timeoutMs: 15000 });
  }
  snapshot(): Snapshot { return structuredClone(this.state); }
  private emit() { this.deps.publish(this.snapshot()); }
  private check(epoch: number) { if (epoch !== this.epoch) throw Error('操作已取消'); }
  async restore() {
    try {
      this.tokens = await this.deps.store.load(); this.state.signedIn = !!this.tokens;
      if (this.tokens) {
        const view = await this.deps.store.loadView();
        if (view?.ownerId === this.tokens.membership.id) this.state.selectedDeviceId = view.deviceId;
      }
    }
    catch { this.state.error = '无法恢复登录。请解锁钥匙串后重新打开，或退出登录清除本机记录。'; }
    this.emit();
  }
  dispose() { this.epoch++; this.abort?.abort(); this.link?.stop(); this.link = null; }
  private async accessToken(): Promise<string | null> {
    if (!this.tokens || this.logoutJob) return null;
    if (Date.now() - this.freshAt < 5 * 60_000) return this.tokens.accessToken;
    if (this.refreshTokenJob) return this.refreshTokenJob;
    const epoch = this.epoch, token = this.tokens.refreshToken;
    const job = (async () => {
      try {
        const next = await this.auth.refresh(token); this.check(epoch);
        await this.deps.store.save(next); this.check(epoch);
        this.tokens = next; this.freshAt = Date.now(); return next.accessToken;
      } catch (error) {
        if (epoch === this.epoch && error instanceof AuthApiError &&
          (error.statusCode === 401 || ['INVALID_REFRESH_TOKEN', 'SESSION_REVOKED'].includes(error.code))) {
          await this.logout();
          this.state.error = '登录已过期，请重新登录'; this.emit();
        }
        throw error;
      }
    })();
    this.refreshTokenJob = job;
    try { return await job; } finally { if (this.refreshTokenJob === job) this.refreshTokenJob = null; }
  }
  private async connect(epoch: number) {
    this.check(epoch);
    if (!this.link) {
      const getToken = () => this.accessToken();
      this.link = this.deps.createLink?.(getToken) ?? new DeviceLinkClient({
        getWsUrl: () => endpoints.deviceLinkApiBaseUrl.replace('https:', 'wss:') + '/api/device-link/ws',
        getToken, createWebSocket: (url, headers) => new WebSocket(url, { headers }),
        getHello: () => ({ deviceName: '猫猫 Mac', platform: 'darwin', appVersion: manifest.version, remoteControlEnabled: false, busy: false }),
      });
      this.link.start();
    }
    const link = this.link;
    await link.waitUntilOnline(15000); this.check(epoch); return link;
  }
  async refresh(): Promise<void> {
    if (!this.tokens || this.logoutJob) return;
    if (this.refreshJob) return this.refreshJob;
    const epoch = this.epoch;
    const job = this.refreshNow(epoch);
    this.refreshJob = job;
    try { await job; } finally { if (this.refreshJob === job) this.refreshJob = null; }
  }
  private async refreshNow(epoch: number) {
    this.state.busy = true; this.state.error = null; this.emit();
    try {
      const token = await this.accessToken(); this.check(epoch);
      const response = await this.fetcher(endpoints.deviceLinkApiBaseUrl + '/api/device-link/devices', {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error(response.status === 401 ? '登录验证失败，请重新登录' : '电脑列表读取失败，请检查网络');
      const devices = parseDevices(await response.json(), this.deps.deviceId); this.check(epoch);
      const old = new Map(this.state.devices.map(d => [d.deviceId, d]));
      this.state.devices = devices.map(d => ({ ...d, accounts: old.get(d.deviceId)?.accounts ?? [], checkedAt: old.get(d.deviceId)?.checkedAt ?? null }));
      if (this.state.selectedDeviceId && !devices.some(d => d.deviceId === this.state.selectedDeviceId)) this.state.selectedDeviceId = null;
      this.emit();
      const targets = this.state.devices.filter(d => d.online && d.remoteControlEnabled);
      if (targets.length) {
        const link = await this.connect(epoch);
        for (let offset = 0; offset < targets.length; offset += 3) {
          this.check(epoch);
          await Promise.all(targets.slice(offset, offset + 3).map(async device => {
            try {
              const accepted = await link.openLink(device.deviceId, { controllerName: '猫猫 Mac', protocolVersion: PROTOCOL_VERSION,
                appVersion: manifest.version, capabilities: [DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1] }, 15000);
              this.check(epoch);
              if (!accepted.capabilities?.includes(DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1)) {
                link.closeLink(device.deviceId, 'user');
                throw Error('请更新这台电脑上的 Cindy，以支持后台读取');
              }
              const read = async (channel: string, args: unknown[] = []) => {
                this.check(epoch);
                const result = await link.invoke(device.deviceId, { channel, args }, 15000); this.check(epoch);
                if (!result.ok) throw Error('电脑未返回额度，请检查远程权限和版本');
                return result.result;
              };
              const providers = subscriptionProviders(await read('maker:provider:list'));
              const accounts = await Promise.all(providers.map(async p => {
                const a = emptyAccount(p), builtin = a.service === 'Claude' ? 'anthropic' : 'openai';
                try { return parseAccount(p, await read(a.service === 'Claude' ? 'maker:usage:claude-subscription' : 'maker:usage:codex-rate-limits',
                  a.id === builtin ? [] : [a.id])); }
                catch { return { ...a, failed: true }; }
              }));
              this.check(epoch);
              device.accounts = accounts.sort((a, b) => Number(a.service !== 'Claude') - Number(b.service !== 'Claude'));
              device.checkedAt = Date.now(); device.error = null;
            } catch (e) {
              if (epoch !== this.epoch) return;
              device.error = e instanceof Error && e.message === '请更新这台电脑上的 Cindy，以支持后台读取' ? e.message : '暂时读不到这台电脑的额度';
            }
            if (epoch === this.epoch) this.emit();
          }));
        }
      }
      this.check(epoch); this.state.updatedAt = Date.now();
    } catch (e) { if (epoch === this.epoch) this.state.error = this.friendly(e, '刷新失败，请检查网络或远端连接'); }
    finally { if (epoch === this.epoch) { this.state.busy = false; this.emit(); } }
  }
  private friendly(e: unknown, fallback: string): string {
    if (e instanceof AuthApiError) {
      const messages: Record<string, string> = { ORG_SSO_NOT_FOUND: '未找到企业 SSO，请检查企业标识',
        INVALID_CODE: '验证码不正确或已过期', RATE_LIMITED: '请求过于频繁，请稍后再试',
        CAPTCHA_REQUIRED: '当前登录需要人机验证，请使用企业 SSO', REGION_MISMATCH: '此企业不在中国大陆版服务中' };
      return messages[e.code] ?? fallback;
    }
    const safe = ['操作已取消', '登录已取消', '登录已超时，请重新登录', '企业授权未完成，请重新登录', 'SSO 连接中断，请重新登录',
      '请先获取验证码', '请稍后再获取验证码', '登录验证失败，请重新登录', '电脑列表读取失败，请检查网络',
      '此账号需要绑定手机号或邮箱，请先在 Cindy 完成绑定', '钥匙串不可用，无法安全保存登录'];
    return e instanceof Error && safe.includes(e.message) ? e.message : fallback;
  }
  private async accept(outcome: LoginOutcome, epoch: number) {
    this.check(epoch);
    if (outcome.status === 'ok') {
      await this.deps.store.save(outcome); this.check(epoch);
      this.tokens = outcome; this.freshAt = Date.now(); this.pending = null;
      this.state.signedIn = true; this.state.login = { kind: 'idle' }; this.codeSentTo = null;
    } else if (outcome.status === 'select_account') {
      this.pending = outcome;
      this.state.login = { kind: 'accounts', choices: outcome.accounts.map(a => ({ id: a.id, name: a.displayName || a.id })) };
    } else if (outcome.status === 'sso_verification_required') {
      this.pending = outcome; this.state.login = { kind: 'verification', target: outcome.targetMasked };
    } else throw Error('此账号需要绑定手机号或邮箱，请先在 Cindy 完成绑定');
  }
  private async sso(connectionId: string, epoch: number) {
    this.abort = new AbortController(); this.state.login = { kind: 'browser' }; this.emit();
    const outcome = await loginSso(this.auth, connectionId, this.abort.signal, this.deps.open);
    this.check(epoch); await this.accept(outcome, epoch);
  }
  async logout() {
    if (this.logoutJob) return this.logoutJob;
    const job = this.clearSession();
    this.logoutJob = job;
    try { await job; } finally { if (this.logoutJob === job) this.logoutJob = null; }
  }
  private async clearSession() {
    this.dispose(); this.refreshJob = null; this.refreshTokenJob = null; this.actionJob = null;
    this.pending = null; this.codeSentTo = null; this.state.devices = []; this.state.updatedAt = null;
    await this.deps.store.save(null);
    this.tokens = null; this.freshAt = 0; this.state = initial(); this.emit();
  }
  async command(c: Command): Promise<Snapshot> {
    if (c.kind === 'state') return this.snapshot();
    if (this.logoutJob && c.kind !== 'logout') return this.snapshot();
    if (c.kind === 'cancel' || c.kind === 'logout') {
      try {
        if (c.kind === 'logout' || !this.state.signedIn) await this.logout();
      } catch { this.state.error = '无法清除本机登录记录，请重试退出登录'; this.state.busy = false; this.emit(); }
      return this.snapshot();
    }
    if (c.kind === 'refresh') { await this.refresh(); return this.snapshot(); }
    if (c.kind === 'select-device') {
      const ownerId = this.tokens?.membership.id, epoch = this.epoch, revision = ++this.viewRevision;
      if (!ownerId) return this.snapshot();
      if (c.deviceId !== null && !this.state.devices.some(d => d.deviceId === c.deviceId)) return this.snapshot();
      try {
        await this.deps.store.saveView({ ownerId, deviceId: c.deviceId });
        if (epoch === this.epoch && revision === this.viewRevision) {
          this.state.selectedDeviceId = c.deviceId; this.state.error = null; this.emit();
        }
      } catch { if (epoch === this.epoch && revision === this.viewRevision) { this.state.error = '无法保存所选电脑，请重试'; this.emit(); } }
      return this.snapshot();
    }
    if (this.actionJob || this.state.signedIn) return this.snapshot();
    const epoch = this.epoch;
    this.state.busy = true; this.state.error = null; this.emit();
    const job = (async () => {
      try {
        if (c.kind === 'sso') {
          const org = await this.auth.discoverSsoOrg(c.org.trim()); this.check(epoch);
          if (org.connections.length === 1) await this.sso(org.connections[0].connectionId, epoch);
          else this.state.login = { kind: 'connections', choices: org.connections.map(c => ({ id: c.connectionId, name: c.connectionName })) };
        } else if (c.kind === 'connection' && this.state.login.kind === 'connections') {
          if (!this.state.login.choices.some(x => x.id === c.id)) throw Error('无效的企业入口');
          await this.sso(c.id, epoch);
        } else if (c.kind === 'account' && this.pending?.status === 'select_account') {
          if (!this.pending.accounts.some(a => a.id === c.id)) throw Error('无效账号');
          await this.accept(await this.auth.selectAccount(this.pending.loginTicket, c.id), epoch);
        } else if (c.kind === 'sso-send-code' && this.pending?.status === 'sso_verification_required') {
          if (Date.now() < this.codeAfter) throw Error('请稍后再获取验证码');
          await this.auth.requestSsoVerificationCode(this.pending.verificationTicket); this.check(epoch); this.codeAfter = Date.now() + 60_000;
        } else if (c.kind === 'sso-verify' && this.pending?.status === 'sso_verification_required') {
          await this.accept(await this.auth.verifySsoVerification(this.pending.verificationTicket, c.code.trim()), epoch);
        } else if (c.kind === 'send-code') {
          if (Date.now() < this.codeAfter) throw Error('请稍后再获取验证码');
          const id = c.identifier.trim();
          await this.auth.requestCode(id.includes('@') ? 'email' : 'phone', id); this.check(epoch);
          this.codeSentTo = id; this.codeAfter = Date.now() + 60_000;
        } else if (c.kind === 'verify-code') {
          const id = c.identifier.trim();
          if (this.codeSentTo !== id) throw Error('请先获取验证码');
          await this.accept(await this.auth.verifyCode(id.includes('@') ? 'email' : 'phone', id, c.code.trim()), epoch);
        }
      } catch (e) {
        if (epoch === this.epoch) {
          this.state.error = this.friendly(e, '登录未完成，请检查网络或登录信息');
          if (this.state.login.kind === 'browser') this.state.login = { kind: 'idle' };
        }
      } finally { if (epoch === this.epoch) { this.state.busy = false; this.emit(); } }
    })();
    this.actionJob = job;
    await job;
    if (this.actionJob === job) this.actionJob = null;
    if (epoch === this.epoch && this.state.signedIn) void this.refresh();
    return this.snapshot();
  }
}
