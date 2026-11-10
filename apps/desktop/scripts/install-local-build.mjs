#!/usr/bin/env node
/**
 * Replace the installed macOS Cindy with a locally packaged Developer ID build.
 *
 * Usage (from the repo root):
 *   pnpm package:install -- --region cn             # newest signed ZIP for this arch
 *   pnpm package:install -- --zip <path-to-zip>     # explicit ZIP
 *   pnpm package:install -- --region cn --dry-run   # only run the preflight checks
 *
 * The script is designed to be run from inside a Cindy task on the same Mac,
 * so it must outlive the Cindy process it replaces:
 *
 * 1. Preflight (foreground, nothing changes on failure): extract the ZIP into a
 *    staging folder, check bundle ID, Developer ID signature, Team ID and CPU
 *    architecture, and refuse to replace an app with a different bundle ID.
 * 2. Hand-off: wrap the shell worker in a throwaway app bundle and open it via
 *    LaunchServices, so it is a child of launchd rather than of Cindy. The
 *    worker only uses system binaries, so it keeps working after Cindy and its
 *    bundled tools are gone.
 * 3. Worker: wait a short grace period (so the calling Agent can finish its
 *    reply), send SIGTERM to Cindy (its normal graceful quit path, no dialogs),
 *    move the old app to a backup, move the new app into place and open it.
 *    If the new app does not start and stay up, it restores the backup and
 *    reopens the old app.
 *
 * Progress is written to ~/Library/Caches/cindy-local-install/{install.log,status.json}.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(os.homedir(), 'Library', 'Caches', 'cindy-local-install');
const LOCK_PATH = path.join(STATE_DIR, 'worker.pid');
const LOG_PATH = path.join(STATE_DIR, 'install.log');
const STATUS_PATH = path.join(STATE_DIR, 'status.json');
const EXPECTED_TEAM_ID = 'KQY8A3BNVG';

function fail(message) {
  console.error(`[install-local-build] 失败：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { region: null, zip: null, app: '/Applications/Cindy.app', delay: 15, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} 缺少参数值`);
      return value;
    };
    if (arg === '--') continue;
    else if (arg === '--region') args.region = next();
    else if (arg.startsWith('--region=')) args.region = arg.slice('--region='.length);
    else if (arg === '--zip') args.zip = next();
    else if (arg === '--app') args.app = next();
    else if (arg === '--delay') args.delay = Number(next());
    else if (arg === '--dry-run') args.dryRun = true;
    else fail(`不认识的参数 ${arg}`);
  }
  if (!args.zip && !args.region) fail('需要 --region <cn|global> 或 --zip <路径>');
  if (args.region && !['cn', 'global'].includes(args.region)) fail(`未知区域 ${args.region}`);
  if (!Number.isFinite(args.delay) || args.delay < 0 || args.delay > 600) fail('--delay 需在 0–600 秒之间');
  return args;
}

function run(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function plistValue(appPath, key) {
  return run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(appPath, 'Contents', 'Info.plist')]);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function resolveZip(args) {
  if (args.zip) return path.resolve(args.zip);
  const arch = os.arch();
  return path.join(
    DESKTOP_ROOT, 'release', 'artifacts', args.region, 'unversioned', `darwin-${arch}`,
    `cindy-${args.region}-unversioned-${arch}-developer-id.zip`,
  );
}

function verifyStagedApp(stagedApp, targetApp) {
  const bundleId = plistValue(stagedApp, 'CFBundleIdentifier');
  const executable = plistValue(stagedApp, 'CFBundleExecutable');

  try {
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
  } catch (err) {
    fail(`新包签名校验未通过：${err.stderr?.trim() || err.message}`);
  }
  // codesign -dv writes its report to stderr.
  const details = spawnSync('/usr/bin/codesign', ['-dvv', stagedApp], { encoding: 'utf8' }).stderr ?? '';
  if (!/^Authority=Developer ID Application:/m.test(details)) fail('新包不是 Developer ID 签名（可能是基础打包的 ad-hoc 包）');
  if (!new RegExp(`^TeamIdentifier=${EXPECTED_TEAM_ID}$`, 'm').test(details)) fail(`新包 Team ID 不是 ${EXPECTED_TEAM_ID}`);

  const archs = run('/usr/bin/lipo', ['-archs', path.join(stagedApp, 'Contents', 'MacOS', executable)]).split(/\s+/);
  const wantArch = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
  if (!archs.includes(wantArch)) fail(`新包架构是 ${archs.join(',')}，本机需要 ${wantArch}`);

  if (fs.existsSync(targetApp)) {
    const installedId = plistValue(targetApp, 'CFBundleIdentifier');
    if (installedId !== bundleId) {
      fail(`已安装的 ${targetApp} 是 ${installedId}，新包是 ${bundleId}；区域不一致，拒绝替换`);
    }
  }
  return { bundleId, executable };
}

const WORKER_TEMPLATE = path.join(__dirname, 'install-local-build-worker.sh');

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Start the worker through LaunchServices instead of spawning it. A process
 * spawned here stays a descendant of Cindy and was observed to die while
 * Cindy quit, even after setsid(); an app opened by LaunchServices is a child
 * of launchd and outlives Cindy. The bundle is throwaway and is deleted with
 * the staging folder; nothing is registered to run again.
 */
function launchWorker(staging, workerArgs) {
  const bundle = path.join(staging, 'CindyLocalInstall.app');
  const macosDir = path.join(bundle, 'Contents', 'MacOS');
  fs.mkdirSync(macosDir, { recursive: true });
  fs.copyFileSync(WORKER_TEMPLATE, path.join(macosDir, 'worker.sh'));
  // LaunchServices requires a native executable on newer macOS releases.
  // Keep the existing worker and its backup/rollback protocol behind that entry.
  const launcherSource = path.join(staging, 'launcher.c');
  fs.writeFileSync(launcherSource, `#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <limits.h>
#include <mach-o/dyld.h>
int main(int argc, char **argv) {
  char worker[PATH_MAX]; uint32_t size = sizeof(worker);
  if (_NSGetExecutablePath(worker, &size) != 0) return 1;
  char *slash = strrchr(worker, '/'); if (!slash) return 1;
  strcpy(slash + 1, "worker.sh");
  char **args = calloc(argc + 2, sizeof(char *)); if (!args) return 1;
  args[0] = "/bin/bash"; args[1] = worker;
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
  execv(args[0], args); perror("execv"); return 1;
}
`);
  run('/usr/bin/xcrun', ['clang', launcherSource, '-o', path.join(macosDir, 'cindy-local-install')]);
  fs.writeFileSync(
    path.join(bundle, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>cindy-local-install</string>
  <key>CFBundleIdentifier</key><string>dev.local.cindy-local-install</string>
  <key>CFBundleName</key><string>CindyLocalInstall</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSBackgroundOnly</key><true/>
</dict></plist>
`,
  );

  try {
    run('/usr/bin/open', ['-n', '-g', bundle, '--args', ...workerArgs]);
  } catch (err) {
    fail(`启动替换进程失败：${err.stderr?.trim() || err.message}（未做任何替换）`);
  }
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(LOCK_PATH)) {
      const pid = Number(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (pid && pidAlive(pid)) {
        const ppid = run('/bin/ps', ['-o', 'ppid=', '-p', String(pid)]);
        console.log(`    替换进程 pid ${pid}（父进程 ${ppid}）`);
        return;
      }
    }
    sleepMs(250);
  }
  fail(`替换进程没有启动，查看 ${LOG_PATH}（未做任何替换）`);
}

function main() {
  if (process.platform !== 'darwin') fail('只支持 macOS');
  const args = parseArgs(process.argv.slice(2));
  const zip = resolveZip(args);
  if (!fs.existsSync(zip)) fail(`找不到签名包 ${zip}（先完成打包和 Developer ID 签名）`);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (fs.existsSync(LOCK_PATH)) {
    const pid = Number(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (pid && pidAlive(pid)) fail(`上一次替换（pid ${pid}）还在进行，查看 ${LOG_PATH}`);
    fs.rmSync(LOCK_PATH, { force: true });
  }

  // Remove staging folders left by earlier dry runs or failed hand-offs.
  for (const entry of fs.readdirSync(STATE_DIR)) {
    if (entry.startsWith('staging-')) fs.rmSync(path.join(STATE_DIR, entry), { recursive: true, force: true });
  }
  const staging = fs.mkdtempSync(path.join(STATE_DIR, 'staging-'));
  console.log(`==> 解压 ${zip}`);
  run('/usr/bin/ditto', ['-x', '-k', zip, staging]);
  const apps = fs.readdirSync(staging).filter((name) => name.endsWith('.app'));
  if (apps.length !== 1) fail(`ZIP 里应只有一个 .app，实际：${apps.join(', ') || '无'}`);
  const stagedApp = path.join(staging, apps[0]);

  const targetApp = path.resolve(args.app);
  const targetDir = path.dirname(targetApp);
  if (fs.statSync(targetDir).dev !== fs.statSync(staging).dev) {
    fail(`${STATE_DIR} 和 ${targetDir} 不在同一个磁盘卷，无法原子替换`);
  }
  try {
    fs.accessSync(targetDir, fs.constants.W_OK);
  } catch {
    fail(`${targetDir} 不可写`);
  }

  console.log('==> 校验新包');
  const { bundleId, executable } = verifyStagedApp(stagedApp, targetApp);
  console.log(`    ${bundleId}，Developer ID（${EXPECTED_TEAM_ID}），${os.arch()}`);

  if (args.dryRun) {
    fs.rmSync(staging, { recursive: true, force: true });
    console.log('==> 预检通过（--dry-run，未做替换）');
    return;
  }

  fs.writeFileSync(
    STATUS_PATH,
    `${JSON.stringify({ state: 'scheduled', message: '已安排替换', at: new Date().toISOString(), app: targetApp })}\n`,
  );
  launchWorker(staging, [stagedApp, targetApp, executable, String(args.delay), STATE_DIR, staging]);

  console.log(`==> 已安排替换：${args.delay} 秒后退出 Cindy，换上新版并重新打开`);
  console.log(`    新版没能正常启动时会自动恢复旧版`);
  console.log(`    日志：${LOG_PATH}`);
  console.log(`    结果：${STATUS_PATH}`);
}

main();
