import { _electron } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url)), qa = join(root, 'qa');
await mkdir(qa, { recursive: true });
const electron = await _electron.launch({ args: [join(root, 'dist'), '--demo'], timeout: 20000 });
const errors = [], reports = [];
try {
  const page = await electron.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.getByRole('heading', { name: '订阅额度', exact: true }).waitFor();
  const check = async name => {
    const result = await page.evaluate(() => {
      const rgba = s => { const n = s.match(/[\d.]+/g)?.map(Number) ?? []; return [n[0] ?? 0,n[1] ?? 0,n[2] ?? 0,n[3] ?? 1]; };
      const blend = (a,b) => [0,1,2].map(i => a[i]*a[3]+b[i]*(1-a[3])).concat(1);
      const lum = c => c.slice(0,3).map(v => v/255).map(v => v<=0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
      const failures = []; let count = 0;
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        const node = walk.currentNode, el = node.parentElement;
        if (!node.textContent.trim() || !el || ['SCRIPT','STYLE','OPTION'].includes(el.tagName)) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        if (![...range.getClientRects()].some(r=>r.width>0&&r.height>0)) continue;
        const chain = []; for(let p=el;p;p=p.parentElement) chain.unshift(p);
        if (chain.some(p=>getComputedStyle(p).visibility==='hidden'||getComputedStyle(p).display==='none')) continue;
        let bg = [255,255,255,1], opacity = 1;
        for (const p of chain) { const s=getComputedStyle(p); bg=blend(rgba(s.backgroundColor),bg); opacity*=Number(s.opacity); }
        const style=getComputedStyle(el), fg=rgba(style.color); fg[3]*=opacity;
        const a=lum(blend(fg,bg)), b=lum(bg), ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        const size=parseFloat(style.fontSize), weight=parseInt(style.fontWeight)||400;
        const required=size>=24 || (size>=18.66&&weight>=700) ? 3 : 4.5;
        count++; if(ratio+.01<required) failures.push({text:node.textContent.trim().slice(0,70),ratio,required});
      }
      return {width:innerWidth, overflow:document.documentElement.scrollWidth>innerWidth, textNodes:count, failures};
    });
    reports.push({name,...result});
    await page.screenshot({path:join(qa,name+'.png'),fullPage:true});
    assert.equal(result.overflow,false,name+' horizontal overflow');
    assert.deepEqual(result.failures,[],name+' text contrast');
  };
  for (const theme of ['light','dark']) {
    await page.emulateMedia({colorScheme:theme});
    for(const width of [468,390]) {
      await electron.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,728),width);
      await check(`${theme}-${width}`);
    }
  }
  await page.locator('details').first().locator('summary').click();
  await page.getByText('Sonnet · 每周',{exact:true}).waitFor();
  await check('dark-details');
  await page.getByLabel('筛选电脑').selectOption('demo-studio');
  assert.equal(await page.locator('section.device').count(),1);
  await page.getByText('离线',{exact:true}).waitFor(); await check('dark-offline');
  await page.getByLabel('筛选电脑').selectOption('all');
  // Closing hides the same renderer; activating the application reuses it.
  const id=await electron.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];const id=w.id;w.close();return id;});
  assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  // Exercise the same anchored show(true) path as a menu-bar icon click, through
  // the real native menu action (the old fractional setPosition threw here).
  await electron.evaluate(({Menu})=>Menu.getApplicationMenu().items.find(i=>i.label==='窗口').submenu.items.find(i=>i.label==='显示猫猫').click());
  assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
  assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].id),id);
  await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('cat:state',{
    signedIn:true,busy:false,error:null,login:{kind:'idle'},updatedAt:Date.now(),demo:true,selectedDeviceId:null,
    devices:[{deviceId:'missing-reset-demo',name:'演示电脑',online:true,remoteControlEnabled:true,platform:'darwin',error:null,checkedAt:Date.now(),
      accounts:[{id:'claude-demo',name:'演示 Claude',service:'Claude',plan:'Pro',failed:false,updatedAt:Date.now(),windows:[
        {minutes:300,remaining:100,resetsAt:null},{minutes:10080,remaining:69,resetsAt:Date.now()/1000+43200}
      ]}]}]
  }));
  await page.getByText('当前未使用 · 来源未返回重置时间',{exact:true}).waitFor();
  for (const theme of ['light','dark']) { await page.emulateMedia({colorScheme:theme}); await check(`${theme}-missing-reset`); }
  // Render a secret-free login snapshot through the real preload subscription.
  await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('cat:state',{
    signedIn:false,busy:false,error:null,login:{kind:'idle'},devices:[],updatedAt:null,demo:false,
  }));
  await page.getByRole('heading',{name:'额度，抬眼就看到。'}).waitFor();
  for (const theme of ['light','dark']) { await page.emulateMedia({colorScheme:theme}); await check(`${theme}-login`); }
  await page.getByLabel('企业 SSO',{exact:true}).focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle),'solid');
  await page.getByRole('button',{name:'先看看界面'}).click();
  await page.getByRole('button',{name:'退出演示'}).click();
  await page.getByRole('heading',{name:'额度，抬眼就看到。'}).waitFor();
  assert.deepEqual(errors,[]);
  await writeFile(join(qa,'verification.json'),JSON.stringify({reports,errors,interactions:'details, device filter, hide/reopen, focus, demo enter/exit passed'},null,2));
  console.log(JSON.stringify({screenshots:qa,checks:reports.length,errors}));
} finally { await electron.close(); }
