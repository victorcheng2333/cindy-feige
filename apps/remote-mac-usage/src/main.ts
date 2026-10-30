import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, safeStorage, screen, shell, Tray } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import endpoints from '../../../config/endpoint.json';
import { UsageService } from './service';
import { EncryptedSessionStore, loadDeviceId } from './storage';
import { validateCommand, type Snapshot } from './model';
import { demoSnapshot } from './demo';
import { trayWindowPosition } from './windowPosition';

app.setName('QuotaCatCN');
const demo = process.argv.includes('--demo');
const qaProfile = demo ? mkdtempSync(join(tmpdir(), 'quota-cat-demo-')) : null;
app.setPath('userData', qaProfile ?? join(app.getPath('appData'), 'QuotaCatCN'));
protocol.registerSchemesAsPrivileged([{ scheme: 'quota-cat', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window: BrowserWindow | null = null, tray: Tray | null = null, service: UsageService | null = null;
let ready = false, quitting = false, timer: ReturnType<typeof setInterval> | null = null;
let wasSignedIn = false;
const url = 'quota-cat://app/index.html';
const background = () => nativeTheme.shouldUseDarkColors ? '#1f1f1e' : '#f8f8f6';
function state(): Snapshot { return demo ? demoSnapshot() : service!.snapshot(); }
function publish(snapshot: Snapshot) {
  const justSignedIn = snapshot.signedIn && !wasSignedIn;
  wasSignedIn = snapshot.signedIn;
  if (window && !window.isDestroyed()) window.webContents.send('cat:state', snapshot);
  tray?.setToolTip(snapshot.signedIn ? `猫猫 · ${snapshot.devices.filter(d => d.online).length} 台电脑在线` : '猫猫 · 远程订阅额度');
  if (justSignedIn && ready && window) { window.show(); window.focus(); }
}
function show(anchored = false) {
  if (!window || !ready) return;
  if (anchored && tray) {
    const b = tray.getBounds(), area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
    const [width, height] = window.getSize();
    window.setPosition(...trayWindowPosition(b, area, [width, height]));
  }
  window.show(); window.focus();
  if (!demo) void service?.refresh();
}
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === url;
}
async function start() {
  const dataDir = app.getPath('userData');
  // Only this independent app's profile is used; Cindy's storage is never opened.
  if (!demo) {
    service = new UsageService({ deviceId: await loadDeviceId(dataDir), store: new EncryptedSessionStore(dataDir, safeStorage), publish,
      open: async value => {
        const target = new URL(value);
        if (target.protocol !== 'https:' || target.origin !== new URL(endpoints.authApiBaseUrl).origin || target.username || target.password)
          throw Error('无效的登录地址');
        await shell.openExternal(target.href);
      } });
    await service.restore();
  }
  const allowed = new Set(['/index.html', '/renderer.js', '/style.css', '/icon.svg']);
  protocol.handle('quota-cat', request => {
    const target = new URL(request.url);
    if (target.host !== 'app' || !allowed.has(target.pathname) || request.method !== 'GET') return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(join(__dirname, target.pathname.slice(1))).href);
  });
  window = new BrowserWindow({ width: 468, height: 728, minWidth: 360, minHeight: 420, show: false,
    title: '猫猫 · 远程额度', titleBarStyle: 'hiddenInset', backgroundColor: background(),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, plugins: false,
      navigateOnDragDrop: false, webviewTag: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.on('will-download', event => event.preventDefault());
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  window.on('hide', () => { if (timer) clearInterval(timer); timer = null; });
  window.on('show', () => {
    if (!timer && !demo) timer = setInterval(() => { void service?.refresh(); }, 30_000);
  });
  nativeTheme.on('updated', () => window?.setBackgroundColor(background()));
  ipcMain.on('cat:ready', event => { if (trusted(event)) { ready = true; publish(state()); show(); } });
  ipcMain.handle('cat:command', async (event, input: unknown) => {
    if (!trusted(event)) throw Error('[FORBIDDEN] 不允许此页面操作猫猫');
    let command;
    try { command = validateCommand(input); } catch { throw Error('[INVALID_PARAMS] 操作格式不正确'); }
    if (command.kind === 'hide') window?.hide();
    else if (command.kind === 'quit') app.quit();
    else if (!demo) return service!.command(command);
    return state();
  });
  const image = nativeImage.createFromPath(join(__dirname, 'trayTemplate.png'));
  image.setTemplateImage(true);
  tray = new Tray(image); tray.setToolTip('猫猫 · 远程订阅额度');
  tray.on('click', () => window?.isVisible() ? window.hide() : show(true));
  tray.on('right-click', () => tray?.popUpContextMenu(Menu.buildFromTemplate([
    { label: '打开猫猫', click: () => show(true) },
    { label: '刷新额度', click: () => { if (!demo) void service?.refresh(); } },
    { type: 'separator' }, { label: '退出猫猫', click: () => app.quit() },
  ])));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '猫猫', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ label: '显示猫猫', accelerator: 'CmdOrCtrl+0', click: () => show(true) }, { role: 'close' }] },
  ]));
  app.setAboutPanelOptions({ applicationName: '猫猫', applicationVersion: app.getVersion(), copyright: '远程订阅额度 · 中国大陆版' });
  app.dock?.hide();
  await window.loadURL(url);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => show()); app.on('activate', () => show());
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; service?.dispose(); if (timer) clearInterval(timer); });
  app.on('will-quit', () => { if (qaProfile) rmSync(qaProfile, { recursive: true, force: true }); });
  void app.whenReady().then(start).catch(() => {
    // No raw auth/network exceptions are written to the console or sent across IPC.
    dialog.showErrorBox('猫猫无法启动', '请确认本机应用数据目录可读写，然后重新打开猫猫。原有登录记录会保留。');
    app.quit(); process.exitCode = 1;
  });
}
