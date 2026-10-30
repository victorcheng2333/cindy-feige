import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import sharp from 'sharp';
const root = fileURLToPath(new URL('..', import.meta.url)), out = join(root, 'dist');
if (process.argv[process.argv.indexOf('--region') + 1] !== 'cn') throw Error('Explicit --region cn is required');
await mkdir(out, { recursive: true });
await Promise.all([
  build({ entryPoints: [join(root, 'src/main.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile: join(out, 'main.cjs') }),
  build({ entryPoints: [join(root, 'src/preload.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile: join(out, 'preload.cjs') }),
  build({ entryPoints: [join(root, 'src/renderer.ts')], bundle: true, platform: 'browser', target: 'chrome140', outfile: join(out, 'renderer.js') }),
  ...['index.html', 'style.css'].map(file => cp(join(root, 'src', file), join(out, file))),
  cp(join(root, 'assets/icon.svg'), join(out, 'icon.svg')),
]);
await sharp(join(root, 'assets/tray.svg')).resize(18, 18).png().toFile(join(out, 'trayTemplate.png'));
await sharp(join(root, 'assets/tray.svg')).resize(36, 36).png().toFile(join(out, 'trayTemplate@2x.png'));
await sharp(join(root, 'assets/icon.svg')).resize(1024, 1024).png().toFile(join(out, 'icon.png'));
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(out, 'package.json'), JSON.stringify({ name: source.name, productName: '猫猫', version: source.version,
  description: source.description, main: 'main.cjs', author: 'Chengfei', license: 'Apache-2.0' }, null, 2) + '\n');
console.log('Built standalone Quota Cat (cn): ' + out);
