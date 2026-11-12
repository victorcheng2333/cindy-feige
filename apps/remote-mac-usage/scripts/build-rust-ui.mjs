import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const distUi = join(root, 'dist-tauri');
const iconsDir = join(root, 'src-tauri/icons');

if (process.argv[process.argv.indexOf('--region') + 1] !== 'cn') {
  throw Error('Explicit --region cn is required');
}

await mkdir(distUi, { recursive: true });
await mkdir(iconsDir, { recursive: true });

await Promise.all([
  build({
    entryPoints: [join(root, 'src/tauri-bridge.ts')],
    bundle: true,
    platform: 'browser',
    target: 'safari16',
    outfile: join(distUi, 'tauri-bridge.js'),
  }),
  build({
    entryPoints: [join(root, 'src/renderer.ts')],
    bundle: true,
    platform: 'browser',
    target: 'safari16',
    outfile: join(distUi, 'renderer.js'),
  }),
  cp(join(root, 'src/index-tauri.html'), join(distUi, 'index.html')),
  cp(join(root, 'src/style.css'), join(distUi, 'style.css')),
  cp(join(root, 'assets/icon.svg'), join(distUi, 'icon.svg')),
  sharp(join(root, 'assets/tray.svg')).resize(36, 36).png().toFile(join(iconsDir, 'trayTemplate@2x.png')),
  sharp(join(root, 'assets/icon.svg')).resize(512, 512).png().toFile(join(iconsDir, 'icon.png')),
]);

console.log('Built Quota Cat Rust UI & icons (cn): ' + distUi);
