import { currentQuota, missingResetText, quotaLabel, type Account, type Command, type Device, type Quota, type Snapshot } from './model';
import { demoSnapshot } from './demo';

const root = document.getElementById('app')!;
let snapshot: Snapshot, latest: Snapshot, preview = false, deviceFilter = 'all';
let fields: Record<string, string> = { org: 'xd', identifier: '', code: '' };
let codeSent = false, uiError = '';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const button = (text: string, action: string, extra = '') => `<button type="button" data-action="${action}" ${extra}>${escape(text)}</button>`;
const date = (ms: number) => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
function until(q: Quota | undefined, available: boolean) {
  if (!available) return '暂时不可用';
  if (!q) return '暂无额度数据';
  if (!currentQuota(q)) return '已到重置时间，等待刷新';
  if (!q.resetsAt) return missingResetText(q);
  const minutes = Math.max(1, Math.ceil((q.resetsAt * 1000 - Date.now()) / 60000));
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时后重置` :
    minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分后重置` : `${minutes} 分钟后重置`;
}
function quota(q: Quota | undefined, label: string, available: boolean) {
  const valid = available && currentQuota(q), remaining = valid ? q.remaining : 0;
  return `<div class="quota ${valid && remaining <= 25 ? 'low' : ''}"><div class="label">${escape(label)} · 剩余</div>
    <div class="number">${valid ? Math.round(remaining) : '—'}${valid ? '<small>%</small>' : ''}</div>
    <progress max="100" value="${remaining}" aria-label="${escape(label)}剩余${valid ? Math.round(remaining) + '%' : '未知'}"></progress>
    <div class="reset">${escape(until(q, available))}</div></div>`;
}
function account(a: Account, d: Device) {
  const available = d.online && d.remoteControlEnabled && !d.error && !a.failed;
  const windows = [300, 10080].map(minutes => a.windows.find(q => q.minutes === minutes && !q.label));
  const title = a.failed ? '暂未获取额度' : a.updatedAt ? `数据更新于 ${date(a.updatedAt)}` : d.checkedAt ? `读取于 ${date(d.checkedAt)} · 数据更新时间未知` : '等待首次读取';
  return `<article class="account"><div class="account-heading"><h3>${escape(a.name)}</h3><span class="brand">${escape(a.service)}${a.plan ? `<br>${escape(a.plan)}` : ''}</span></div>
    <div class="quotas">${quota(windows[0], '5 小时', !!available)}${quota(windows[1], '每周', !!available)}</div>
    <details data-key="${escape(d.deviceId + ':' + a.id)}"><summary>${escape(title)} · 详情</summary>
      ${a.windows.length ? a.windows.map(q => `<div class="detail-row"><span>${escape(quotaLabel(q))}</span><span>${available && currentQuota(q) ? `剩余 ${Math.round(q.remaining)}%` : '等待有效额度'}<br>${q.resetsAt ? escape(date(q.resetsAt * 1000) + ' 重置') : escape(missingResetText(q))}</span></div>`).join('') : '<p>远端暂未返回有效额度，请确认账号登录状态和 Cindy 版本。</p>'}
    </details></article>`;
}
function device(d: Device) {
  const status = !d.online ? '离线' : !d.remoteControlEnabled ? '未开放远程连接' : d.error ? '读取失败' : '在线';
  return `<section class="device ${!d.online || !d.remoteControlEnabled ? 'offline' : ''}"><div class="device-title"><h2>${escape(d.name)}</h2><span class="status">${status}</span></div>
    ${d.error ? `<p class="empty">${escape(d.error)}</p>` : ''}
    ${d.accounts.map(a => account(a, d)).join('')}
    ${d.accounts.length ? '' : `<p class="empty">${!d.online ? '电脑上线后会自动读取额度。' : !d.remoteControlEnabled ? '请在这台电脑上开启 Cindy 远程连接。' : snapshot.busy ? '正在读取订阅账号…' : d.error ? '可点击刷新重新读取。' : '未找到可读取的 Claude / ChatGPT 订阅账号。'}</p>`}</section>`;
}
function input(name: string, label: string, placeholder = '', type = 'text') {
  return `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" required maxlength="254" placeholder="${placeholder}" value="${escape(fields[name])}" autocomplete="${name === 'code' ? 'one-time-code' : 'off'}" ${snapshot.busy ? 'disabled' : ''}>`;
}
function login() {
  const disabled = snapshot.busy ? 'disabled' : '';
  let body = '';
  if (snapshot.login.kind === 'browser') body = `<div class="browser-wait"><p>已打开浏览器，请在那里完成企业登录。</p><p class="muted">完成后会自动回到额度总览。</p>${button('取消登录', 'cancel')}</div>`;
  else if (snapshot.login.kind === 'connections' || snapshot.login.kind === 'accounts') {
    const kind = snapshot.login.kind === 'connections' ? 'connection' : 'account';
    body = `<div class="choices"><p>${kind === 'connection' ? '选择企业登录入口' : '选择账号'}</p>${snapshot.login.choices.map(c => button(c.name, kind, `data-id="${escape(c.id)}" ${disabled}`)).join('')}${button('返回', 'cancel')}</div>`;
  } else if (snapshot.login.kind === 'verification') body = `<form data-form="sso-verify"><p>验证码将发送到 ${escape(snapshot.login.target)}</p>${input('code', '验证码', '输入验证码')}
    <div class="row">${button('获取验证码', 'sso-send-code', disabled)}<button class="primary" ${disabled}>完成验证</button></div>${button('返回', 'cancel')}</form>`;
  else body = `<form data-form="sso">${input('org', '企业 SSO', '企业标识或域名')}<button class="primary" ${disabled}>${snapshot.busy ? '正在连接…' : '使用企业 SSO 登录'}</button></form>
    <details data-key="code-login"><summary>使用手机号或邮箱登录</summary><form data-form="code">${input('identifier', '手机号或邮箱', '输入手机号或邮箱')}${input('code', '验证码', '输入验证码')}
    <div class="row">${button(codeSent ? '重新获取' : '获取验证码', 'send-code', disabled)}<button class="primary" ${disabled}>登录</button></div>${codeSent ? '<p class="sent">验证码已发送，请查收。</p>' : ''}</form></details>
    <p class="note">登录与远端电脑相同的 Cindy 账号。登录状态加密保存在本机，订阅凭证留在远端电脑。</p>
    <div class="row note">${button('先看看界面', 'demo', disabled)}${snapshot.error ? button('清除本机登录', 'logout') : ''}</div>`;
  return `<section class="login"><img class="cat" src="icon.svg" alt="猫猫"><h1>额度，抬眼就看到。</h1><p class="subhead">把远端电脑的订阅额度，放进菜单栏。</p>${alert()}${body}<p class="note">猫猫 Mac · 中国大陆版</p></section>`;
}
function alert() { const error = uiError || snapshot.error; return error ? `<div class="alert" role="alert">${escape(error)}</div>` : ''; }
function dashboard() {
  const filtered = snapshot.devices.filter(d => deviceFilter === 'all' || d.deviceId === deviceFilter);
  return `<div class="top"><div><h1>订阅额度</h1><p class="subhead">远端还有多少，一眼看清。</p></div><img class="cat" src="icon.svg" alt="猫猫"></div>
    ${snapshot.demo ? `<div class="demo">演示模式 · 以下数据均为虚构${preview ? ' ' + button('退出演示', 'leave-demo') : ''}</div>` : ''}${alert()}
    <div class="filters"><select id="devices" aria-label="筛选电脑"><option value="all">全部电脑</option>${snapshot.devices.map(d => `<option value="${escape(d.deviceId)}" ${deviceFilter === d.deviceId ? 'selected' : ''}>${escape(d.name)}</option>`).join('')}</select>${button(snapshot.busy ? '刷新中…' : '刷新', 'refresh', snapshot.busy ? 'disabled' : '')}</div>
    ${filtered.map(device).join('') || `<p class="empty">${snapshot.busy ? '正在查找你的电脑…' : '还没有可显示的电脑。在远端 Cindy 登录同一账号并开启远程连接后，它会出现在这里。'}</p>`}
    <footer class="footer"><div class="row"><span>${snapshot.updatedAt ? `最近检查 ${date(snapshot.updatedAt)}` : '等待刷新'}</span>${!snapshot.demo ? button('退出登录', 'logout') : ''}</div>
      <p>窗口打开时每 30 秒刷新。相同订阅在多台电脑共享额度，不能相加。</p><p>关闭窗口后，点击菜单栏猫猫即可再次打开。</p></footer>`;
}
function render(next: Snapshot) {
  const focus = document.activeElement as HTMLInputElement | null;
  const focusedId = focus?.id, start = focus?.selectionStart, end = focus?.selectionEnd;
  root.querySelectorAll<HTMLInputElement>('input').forEach(el => fields[el.name] = el.value);
  const opened = new Set(Array.from(root.querySelectorAll<HTMLDetailsElement>('details[open]')).map(el => el.dataset.key));
  snapshot = next;
  deviceFilter = snapshot.selectedDeviceId ?? 'all';
  if (deviceFilter !== 'all' && !snapshot.devices.some(d => d.deviceId === deviceFilter)) deviceFilter = 'all';
  root.innerHTML = snapshot.signedIn ? dashboard() : login();
  root.setAttribute('aria-busy', String(snapshot.busy));
  root.querySelectorAll<HTMLDetailsElement>('details').forEach(el => { el.open = opened.has(el.dataset.key); });
  const input = focusedId ? document.getElementById(focusedId) as HTMLInputElement | null : null;
  if (input && input.tagName === 'INPUT' && !input.disabled) { input.focus(); if (start !== null && start !== undefined) input.setSelectionRange(start, end ?? start); }
}
async function command(c: Command) {
  uiError = '';
  if (snapshot?.demo && !['hide', 'quit', 'state'].includes(c.kind)) return;
  try {
    const next = await window.cat.command(c);
    if (c.kind === 'send-code' && !next.error) codeSent = true;
    if (next.signedIn || c.kind === 'cancel' || c.kind === 'logout') { fields.code = ''; fields.identifier = ''; codeSent = false; }
    latest = next; if (!preview) render(next);
  } catch { uiError = '操作未完成，请重新打开猫猫后重试'; if (snapshot) render(snapshot); }
}
root.addEventListener('click', event => {
  const b = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!b || b.disabled) return;
  const action = b.dataset.action;
  if (action === 'demo') { preview = true; deviceFilter = 'all'; render(demoSnapshot()); return; }
  if (action === 'leave-demo') { preview = false; deviceFilter = 'all'; render(latest); return; }
  if (action === 'connection' || action === 'account') void command({ kind: action, id: b.dataset.id! });
  else if (action === 'send-code') void command({ kind: 'send-code', identifier: (document.getElementById('identifier') as HTMLInputElement).value });
  else void command({ kind: action } as Command);
});
root.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target as HTMLFormElement, data = new FormData(form);
  const value = (name: string) => String(data.get(name) ?? '').trim();
  if (form.dataset.form === 'sso') void command({ kind: 'sso', org: value('org') });
  if (form.dataset.form === 'code') void command({ kind: 'verify-code', identifier: value('identifier'), code: value('code') });
  if (form.dataset.form === 'sso-verify') void command({ kind: 'sso-verify', code: value('code') });
});
root.addEventListener('change', event => {
  const target = event.target as HTMLSelectElement;
  if (target.id === 'devices') {
    const deviceId = target.value === 'all' ? null : target.value;
    if (snapshot.demo) render({ ...snapshot, selectedDeviceId: deviceId });
    else void command({ kind: 'select-device', deviceId });
  }
});
root.addEventListener('input', event => { if ((event.target as HTMLInputElement).name === 'identifier') codeSent = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') void command({ kind: 'hide' }); });
window.cat.subscribe(next => { latest = next; if (!preview) render(next); });
void command({ kind: 'state' });
