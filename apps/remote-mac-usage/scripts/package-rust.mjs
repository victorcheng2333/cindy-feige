import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (process.platform !== 'darwin') throw Error('Packaging requires macOS');
if (process.argv[process.argv.indexOf('--region') + 1] !== 'cn') {
  throw Error('Explicit --region cn is required');
}

const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
const matches = [...identities.matchAll(/"(Developer ID Application: [^"]+)"/g)];
const identity =
  matches.find(m => m[1] === 'Developer ID Application: Tools UG (KQY8A3BNVG)')?.[1] ??
  (matches.length === 1 ? matches[0][1] : null);
if (!identity) {
  throw Error('No unambiguous Developer ID Application certificate. No unsigned release is produced.');
}

const cargoBin = join(homedir(), '.cargo', 'bin', 'cargo');
const env = { ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}` };

execFileSync(process.execPath, [join(root, 'scripts/build-rust-ui.mjs'), '--region', 'cn'], {
  stdio: 'inherit',
  env,
});

execFileSync(cargoBin, ['build', '--release', '--manifest-path', join(root, 'src-tauri/Cargo.toml')], {
  stdio: 'inherit',
  env,
});

const out = join(root, 'out');
const bundleParent = join(out, `猫猫-darwin-${process.arch}`);
const app = join(bundleParent, '猫猫.app');
const contents = join(app, 'Contents');
const macosDir = join(contents, 'MacOS');
const resourcesDir = join(contents, 'Resources');
const iconset = join(out, 'cat.iconset');

await rm(bundleParent, { recursive: true, force: true });
await mkdir(macosDir, { recursive: true });
await mkdir(resourcesDir, { recursive: true });
await mkdir(iconset, { recursive: true });

for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    await sharp(join(root, 'assets/icon.svg'))
      .resize(size * scale, size * scale)
      .png()
      .toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
  }
}
const icnsPath = join(resourcesDir, 'cat.icns');
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsPath]);
await rm(iconset, { recursive: true, force: true });

const binarySrc = join(root, 'src-tauri/target/release/quota-cat-rust');
const binaryDst = join(macosDir, '猫猫');
await copyFile(binarySrc, binaryDst);
await chmod(binaryDst, 0o755);

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>猫猫</string>
  <key>CFBundleExecutable</key>
  <string>猫猫</string>
  <key>CFBundleIconFile</key>
  <string>cat.icns</string>
  <key>CFBundleIdentifier</key>
  <string>com.chengfei.quotacat.cn</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>猫猫</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>远程订阅额度 · 中国大陆版</string>
</dict>
</plist>
`;
await writeFile(join(contents, 'Info.plist'), infoPlist);
await writeFile(join(contents, 'PkgInfo'), 'APPL????');

execFileSync(
  '/usr/bin/codesign',
  ['--force', '--timestamp', '--options', 'runtime', '--sign', identity, app],
  { stdio: 'inherit' },
);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });

const zip = join(out, `quota-cat-cn-${process.arch}-developer-id.zip`);
await rm(zip, { force: true });
execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip]);
execFileSync('unzip', ['-tq', zip], { stdio: 'inherit' });

const zipBytes = await readFile(zip);
const binStat = await stat(binaryDst);
await writeFile(
  zip + '.json',
  JSON.stringify(
    {
      version,
      runtime: 'rust-tauri2',
      region: 'cn',
      arch: process.arch,
      bundleId: 'com.chengfei.quotacat.cn',
      identity,
      notarized: false,
      appExecutableBytes: binStat.size,
      bytes: zipBytes.length,
      sha256: createHash('sha256').update(zipBytes).digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
console.log(app);
console.log(zip);
