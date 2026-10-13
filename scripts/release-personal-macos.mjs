#!/usr/bin/env node
// Personal fork distribution only: versionless CN ZIPs, no CDN/update manifest or notarization.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'victorcheng2333/cindy-feige';
const IDENTITY = 'Developer ID Application: Tools UG (KQY8A3BNVG)';
const TEAM = 'KQY8A3BNVG';
const ARCHS = ['arm64', 'x64'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const ARTIFACTS = path.join(DESKTOP, 'release', 'artifacts', 'cn', 'unversioned');

export function parseArgs(argv) {
  const options = { tag: null, reuse: false, prepareOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tag') options.tag = argv[++i];
    else if (arg === '--reuse-artifacts') options.reuse = true;
    else if (arg === '--prepare-only') options.prepareOnly = true;
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && !/^personal-cn-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options.tag ?? '')) {
    throw new Error('Provide --tag personal-cn-YYYY-MM-DD (add a suffix for another build).');
  }
  return options;
}

function run(command, args, capture = false) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 16 * 1024 * 1024,
  })?.trim();
}

function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sha256(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function artifactDir(arch) { return path.join(ARTIFACTS, `darwin-${arch}`); }
function zipName(arch) { return `cindy-cn-unversioned-${arch}-developer-id.zip`; }
function metadataPath(arch) { return path.join(artifactDir(arch), zipName(arch).replace(/\.zip$/, '.json')); }

export function validateMetadata(info, arch) {
  if (info.region !== 'cn' || info.arch !== arch || info.version !== '0.0.0'
    || info.bundleIdentifier !== 'com.xd.cindycn' || info.notarized !== false
    || info.signingIdentity !== IDENTITY || info.file !== zipName(arch)
    || !/^[a-f0-9]{40}$/.test(info.sourceCommit ?? '')) {
    throw new Error(`Invalid CN Developer ID metadata for ${arch}`);
  }
}

export function commonSource(infos) {
  if (infos.length !== 2 || infos[0].arch !== 'arm64' || infos[1].arch !== 'x64'
    || infos[0].sourceCommit !== infos[1].sourceCommit) {
    throw new Error('Both architectures must come from the same source commit.');
  }
  return infos[0].sourceCommit;
}

export function validateOrigin(url) {
  if (![`git@github.com:${REPOSITORY}.git`, `https://github.com/${REPOSITORY}.git`, `https://github.com/${REPOSITORY}`].includes(url)) {
    throw new Error(`origin must point to ${REPOSITORY}`);
  }
}

function inspectApp(app, arch, source) {
  run('codesign', ['--verify', '--deep', '--strict', app]);
  // Extract certificates instead of parsing localized diagnostic output.
  const certificateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-release-cert-'));
  try {
    const prefix = path.join(certificateDir, 'cert');
    run('codesign', ['-d', `--extract-certificates=${prefix}`, app]);
    const subject = run('openssl', ['x509', '-inform', 'DER', '-in', `${prefix}0`, '-noout', '-subject'], true);
    if (!subject.includes(IDENTITY) || !subject.includes(TEAM)) throw new Error('Wrong signing certificate');
  } finally { fs.rmSync(certificateDir, { recursive: true, force: true }); }
  const plist = path.join(app, 'Contents', 'Info.plist');
  const bundle = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], true);
  const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], true);
  const binaryArch = run('lipo', ['-archs', path.join(app, 'Contents', 'MacOS', 'Cindy')], true);
  const packagedSource = json(path.join(app, 'Contents', 'Resources', 'cindy-source.json'));
  if (bundle !== 'com.xd.cindycn' || version !== '0.0.0'
    || binaryArch !== (arch === 'x64' ? 'x86_64' : 'arm64')
    || packagedSource.sourceCommit !== source) throw new Error(`Wrong bundle identity for ${arch}`);
}

function verifyArchive(arch, scratch) {
  const info = json(metadataPath(arch));
  validateMetadata(info, arch);
  const zip = path.join(artifactDir(arch), info.file);
  if (fs.statSync(zip).size !== info.size || sha256(zip) !== info.sha256) throw new Error(`ZIP hash mismatch: ${arch}`);
  run('unzip', ['-tq', zip]);
  const extracted = path.join(scratch, arch);
  run('ditto', ['-x', '-k', zip, extracted]);
  inspectApp(path.join(extracted, 'Cindy.app'), arch, info.sourceCommit);
  fs.rmSync(extracted, { recursive: true, force: true });
  return info;
}

async function buildSignedArchives() {
  // Shared signing helper invokes shell commands; reject shell interpolation in its paths.
  if (/["`$\\\n\r]/.test(ROOT)) throw new Error('Checkout path is unsupported by the shared signing helper.');
  const { signMacAppWithIdentity } = await import('../apps/desktop/scripts/ci/lib.mjs');
  const source = run('git', ['rev-parse', 'HEAD'], true);
  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning'], true);
  if (!identities.includes(IDENTITY)) throw new Error(`Missing signing identity: ${IDENTITY}`);
  for (const arch of ARCHS) {
    run('pnpm', ['package', '--', '--region', 'cn', '--arch', arch]);
    const app = path.join(DESKTOP, 'out', `Cindy-darwin-${arch}`, 'Cindy.app');
    const build = json(path.join(artifactDir(arch), 'build-info.json'));
    if (build.commitSha !== source || build.region !== 'cn' || build.arch !== arch || !build.versionless) {
      throw new Error(`Unexpected build metadata: ${arch}`);
    }
    signMacAppWithIdentity(app,
      path.join(DESKTOP, 'release', 'build-helper.entitlements'),
      path.join(DESKTOP, 'release', 'build-main.entitlements'),
      { signIdentity: IDENTITY, teamId: TEAM }, { arch });
    inspectApp(app, arch, source);
    const zip = path.join(artifactDir(arch), zipName(arch));
    const partial = `${zip}.partial`;
    try {
      run('ditto', ['-c', '-k', '--keepParent', app, partial]);
      fs.renameSync(partial, zip);
    } finally { fs.rmSync(partial, { force: true }); }
    fs.writeFileSync(metadataPath(arch), JSON.stringify({
      file: zipName(arch), size: fs.statSync(zip).size, sha256: sha256(zip),
      sourceCommit: source, region: 'cn', bundleIdentifier: 'com.xd.cindycn', arch,
      version: '0.0.0', signingIdentity: IDENTITY, notarized: false, buildTime: build.buildTime,
    }, null, 2) + '\n');
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('node scripts/release-personal-macos.mjs --tag personal-cn-YYYY-MM-DD [--prepare-only] [--reuse-artifacts]\n'
      + 'Build/sign/verify CN arm64+x64 and publish a prerelease to victorcheng2333/cindy-feige.\n'
      + '--prepare-only: local build and verification only; --reuse-artifacts: verify existing signed ZIPs.\n'
      + 'No Apple notarization, automatic updates, branch pushes or source commits.');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('Run on macOS with Xcode and a Developer ID certificate.');
  if (!options.prepareOnly) {
    validateOrigin(run('git', ['remote', 'get-url', 'origin'], true));
    validateOrigin(run('git', ['remote', 'get-url', '--push', '--all', 'origin'], true));
    const repo = JSON.parse(run('gh', ['repo', 'view', REPOSITORY, '--json', 'nameWithOwner'], true));
    if (repo.nameWithOwner !== REPOSITORY) throw new Error('Unexpected GitHub repository');
    // A new tag is required. Never overwrite a release, even after an interrupted upload.
    if (run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${options.tag}`], true)) {
      throw new Error(`Tag already exists: ${options.tag}. Use a new tag or inspect the existing release.`);
    }
  }
  if (!options.reuse) await buildSignedArchives();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-personal-release-'));
  try {
    const infos = ARCHS.map((arch) => verifyArchive(arch, scratch));
    const source = commonSource(infos);
    const output = path.join(ARTIFACTS, options.tag);
    fs.mkdirSync(output, { recursive: true });
    const sums = path.join(output, 'SHA256SUMS.txt');
    fs.writeFileSync(sums, infos.map((info) => `${info.sha256}  ${info.file}\n`).join(''));
    const notes = path.join(output, 'release-notes.md');
    fs.writeFileSync(notes, `Cindy 中国大陆版个人构建（${REPOSITORY}）。\n\n`
      + '- macOS Apple Silicon 请下载 arm64，Intel 请下载 x64；解压后得到 Cindy.app。\n'
      + `- Developer ID 签名：${IDENTITY}；未做 Apple 公证。\n`
      + '- 版本为 0.0.0，不参与自动更新；后续请手动下载安装。\n'
      + `- 两个架构的源码提交：\`${source}\`。允许本地未提交改动，标签不能完整表示未提交内容。\n\n`
      + '已校验两份 ZIP 完整性、SHA256、解压后严格深层签名、证书、架构、国内版 bundle ID 与源码标识。'
      + '不包含完整单元测试、类型检查或安装启动冒烟，不代表完整功能验收。\n');
    if (options.prepareOnly) { console.log(`Verified artifacts: ${ARTIFACTS}`); return; }
    // Push only the source tag; do not advance main or upload binaries to Git history.
    run('git', ['cat-file', '-e', `${source}^{commit}`]);
    run('git', ['push', 'origin', `${source}:refs/tags/${options.tag}`]);
    const assets = ARCHS.flatMap((arch) => [path.join(artifactDir(arch), zipName(arch)), metadataPath(arch)]);
    run('gh', ['release', 'create', options.tag, ...assets, sums,
      '--repo', REPOSITORY, '--verify-tag', '--prerelease', '--latest=false',
      '--title', `Cindy 中国大陆版 · macOS arm64 / x64 · ${options.tag}`,
      '--notes-file', notes]);
    const remote = JSON.parse(run('gh', ['api', `repos/${REPOSITORY}/releases/tags/${options.tag}`], true));
    if (remote.draft || !remote.prerelease) throw new Error('Release was not published as a prerelease');
    for (const assetPath of [...assets, sums]) {
      const asset = remote.assets.find((item) => item.name === path.basename(assetPath));
      if (!asset || asset.state !== 'uploaded' || asset.size !== fs.statSync(assetPath).size
        || asset.digest !== `sha256:${sha256(assetPath)}`) throw new Error(`Remote asset verification failed: ${assetPath}`);
    }
    console.log(`Published and verified: ${remote.html_url}`);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
