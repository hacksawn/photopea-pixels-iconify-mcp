import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const transport = new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, PHOTOPEA_MCP_PORT: '8791' } });
const client = new Client({ name: 'test', version: '1' });
await client.connect(transport);
const results = [];
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text;
  const ok = !r.isError;
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${t.slice(0, 300).replace(/\s+/g, ' ')}`);
  return ok ? (() => { try { return JSON.parse(t); } catch { return t; } })() : null;
}
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));

const browser = spawn('chromium', ['--headless=new', '--no-sandbox', '--user-data-dir=/tmp/pp-test-profile', '--window-size=1400,1000', '--enable-unsafe-swiftshader', 'http://localhost:8791/'], { stdio: 'ignore' });
for (let i = 0; i < 90; i++) {
  const s = JSON.parse((await client.callTool({ name: 'photopea_status', arguments: {} })).content[0].text);
  if (s.photopeaReady) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await call('photopea_status');
await call('photopea_new_document', { width: 1080, height: 1620, name: 'TestPoster', background: '#101820' });
await call('icons_search', { query: 'heart', limit: 5, prefixes: 'lucide,mdi' });
await call('icons_set_info', { prefix: 'lucide' });
const t0 = Date.now();
await call('photopea_compose', { ops: [
  { type: 'rect', x: 0, y: 1200, w: 1080, h: 420, color: '#f2aa4c', name: 'Band' },
  { type: 'icon', icon: 'mdi:heart', color: '#ff3355', size: 300, x: 390, y: 300 },
  { type: 'image', url: 'https://picsum.photos/id/1015/800/600', x: 140, y: 650, w: 800, h: 500, fit: 'cover', name: 'Photo' },
  { type: 'icon', icon: 'mdi:heart', color: '#ff3355', size: 80, x: 100, y: 1400 },
  { type: 'text', text: 'SUMMER FEST', x: 540, y: 1330, size: 110, color: '#101820', font: 'Arial-BoldMT', align: 'center' },
  { type: 'text', text: 'Aug 12 - Central Park', x: 540, y: 1450, size: 48, color: '#101820', align: 'center' },
] });
console.log('compose took', Date.now() - t0, 'ms');
const bad = await call('photopea_compose', { ops: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, color: '#fff' }, { type: 'image', url: 'http://localhost:1/nope.png' }] });
await call('photopea_list_layers');
await call('photopea_layer_edit', { index: 0, opacity: 90, name: 'Title' });
await call('photopea_run_script', { script: 'app.echoToOE("layers=" + app.activeDocument.layers.length);' });
await call('photopea_export', { format: 'png', filename: 'test-poster' });
await call('photopea_export', { format: 'jpg', quality: 0.8, filename: 'test-poster' });
await call('pexels_search', { query: 'concert' }); // expected to fail without a key
const inv = await client.callTool({ name: 'photopea_compose', arguments: { ops: [{ type: 'icon', icon: 'bad icon' }] } }).catch(() => ({ isError: true }));
console.log('invalid input rejected:', !!inv.isError);

browser.kill(); await client.close();
console.log(results.filter(r => !r[1]).map(r => r[0]));
process.exit(0);
