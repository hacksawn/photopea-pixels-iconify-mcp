// Regression: compose must stack on TOP even when another layer is active; layer_edit order top/bottom must really move layers.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
let failed = 0;
const check = (label, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${ok ? '' : extra}`); };
const c = new Client({ name: 't', version: '1' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, PHOTOPEA_MCP_PORT: '8870', PHOTOPEA_MCP_AUTOOPEN: '0', PHOTOPEA_MCP_AUTOSAVE: '0' } }));
const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; return { err: !!r.isError, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };
const b = spawn('chromium', ['--headless=new', '--no-sandbox', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'pp-prof-'))}`, 'http://localhost:8870/'], { stdio: 'ignore' });
for (let i = 0; i < 90; i++) { if ((await call('photopea_status')).json?.ready) break; await new Promise((r) => setTimeout(r, 1000)); }
const names = async () => ((await call('photopea_list_layers')).json || []).map((r) => r[1]);

await call('photopea_new_document', { width: 200, height: 120, background: '#ffffff' });
await call('photopea_compose', { ops: [{ type: 'rect', x: 0, y: 0, w: 50, h: 50, color: '#f00', name: 'A' }, { type: 'rect', x: 60, y: 0, w: 50, h: 50, color: '#0f0', name: 'B' }, { type: 'rect', x: 120, y: 0, w: 50, h: 50, color: '#00f', name: 'C' }] });
check('initial stack is C,B,A,Background', (await names()).join() === 'C,B,A,Background', (await names()).join());

// make a lower layer active, then compose: the new layer must still land on top
await call('photopea_run_script', { script: 'app.activeDocument.activeLayer = app.activeDocument.layers[3];' });
await call('photopea_compose', { ops: [{ type: 'rect', x: 0, y: 60, w: 50, h: 50, color: '#ff0', name: 'D' }] });
check('compose stacks on top even when a lower layer is active', (await names())[0] === 'D', (await names()).join());

await call('photopea_layer_edit', { index: 0, order: 'bottom' });
check('order bottom moves the layer below everything', (await names()).slice(-1)[0] === 'D', (await names()).join());
await call('photopea_layer_edit', { index: 4, order: 'top' });
check('order top moves the layer above everything', (await names())[0] === 'D', (await names()).join());
check('no layers were lost or duplicated', (await names()).length === 5, (await names()).join());

b.kill(); await c.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
