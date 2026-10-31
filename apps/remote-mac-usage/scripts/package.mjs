import packager from '@electron/packager';
import { signAsync } from '@electron/osx-sign';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
const require = createRequire(import.meta.url), root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (process.platform !== 'darwin') throw Error('Packaging requires macOS');
if (process.argv[process.argv.indexOf('--region') + 1] !== 'cn') throw Error('Explicit --region cn is required');
const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
const matches = [...identities.matchAll(/"(Developer ID Application: [^"]+)"/g)];
const identity = matches.find(m => m[1] === 'Developer ID Application: Tools UG (KQY8A3BNVG)')?.[1] ?? (matches.length === 1 ? matches[0][1] : null);
if (!identity) throw Error('No unambiguous Developer ID Application certificate. No unsigned release is produced.');
const out = join(root, 'out'), iconset = join(out, 'cat.iconset');
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) await sharp(join(root, 'assets/icon.svg')).resize(size * scale, size * scale).png()
    .toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(out, 'cat.icns')]);
const paths = await packager({ dir: join(root, 'dist'), out, name: '猫猫', appBundleId: 'com.chengfei.quotacat.cn',
  appVersion: version, platform: 'darwin', arch: process.arch, overwrite: true, asar: true, prune: false,
  electronVersion: require('electron/package.json').version, electronZipDir: undefined,
  electronDist: join(dirname(require.resolve('electron')), 'dist'), icon: join(out, 'cat.icns'),
  extendInfo: { LSUIElement: true, NSHumanReadableCopyright: '远程订阅额度 · 中国大陆版' } });
const app = join(paths[0], '猫猫.app');
await flipFuses(app, { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false, [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true });
const entitlements = join(out, 'entitlements.plist');
await writeFile(entitlements, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
// Sign executable code and nested bundles. Locale packs/images/ASAR are covered by
// their containing bundle's resource seal; they are not individually executable code.
const nonCodeResource = file => {
  if (statSync(file).isDirectory()) return !/\.(app|framework)$/.test(file);
  const fd = openSync(file, 'r'), header = Buffer.alloc(4);
  try { if (readSync(fd, header, 0, 4, 0) !== 4) return true; }
  finally { closeSync(fd); }
  return ![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32BE());
};
// osx-sign 1.3.3 normalizes a single predicate; its array normalizer drops arrays.
await signAsync({ app, identity, platform: 'darwin', type: 'distribution', ignore: nonCodeResource,
  optionsForFile: () => ({ hardenedRuntime: true, entitlements }), preAutoEntitlements: false });
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
const zip = join(out, `quota-cat-cn-${process.arch}-developer-id.zip`);
execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip]);
execFileSync('unzip', ['-tq', zip], { stdio: 'inherit' });
const bytes = await readFile(zip);
await writeFile(zip + '.json', JSON.stringify({ version, region: 'cn', arch: process.arch, identity,
  notarized: false, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, null, 2) + '\n');
console.log(zip);
