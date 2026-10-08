// Autosave/restore: snapshots are written on change (incl. manual edits), survive server restarts and a lost tab,
// don't duplicate when the page still has the document open, and can be disabled.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';

const PORT = '8795', OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-autosave-'));
const SNAP = path.join(OUT, 'autosave');
let failed = 0;
const check = (label, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${ok ? '' : extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(500); } return null; };
const snaps = (dir = SNAP) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.psd')).sort() : []);
const hashOf = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

async function startServer(env = {}, out = OUT) {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, PHOTOPEA_MCP_PORT: PORT, PHOTOPEA_MCP_AUTOOPEN: '0', PHOTOPEA_MCP_OUTPUT: out, PHOTOPEA_MCP_AUTOSAVE_SECS: '2', ...env } }));
  const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; return { err: !!r.isError, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };
  return { c, call };
}
const startBrowser = () => spawn('chromium', ['--headless=new', '--no-sandbox', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'pp-prof-'))}`, `http://localhost:${PORT}/`], { stdio: 'ignore' });
const bridgeUp = (s) => until(async () => (await s.call('photopea_status')).json?.ready, 90000);

// ---- A: snapshots are written on change, refreshed after a manual edit, and idle = no rewrites
let s = await startServer(); let b = startBrowser();
check('A0 bridge ready', await bridgeUp(s));
await s.call('photopea_new_document', { width: 400, height: 300, background: '#336699' });
await s.call('photopea_compose', { ops: [{ type: 'rect', x: 20, y: 20, w: 100, h: 60, color: '#ffcc00', name: 'Box' }, { type: 'text', text: 'KEEPME', x: 200, y: 160, size: 60, color: '#ffffff', font: 'Arial-BoldMT', align: 'center', name: 'KEEPME' }] });
const first = await until(() => snaps()[0]);
check('A1 snapshot written', !!first);
const f1 = path.join(SNAP, snaps().pop());
check('A2 snapshot is a valid PSD', fs.readFileSync(f1).subarray(0, 4).toString() === '8BPS');
await sleep(1500); // let the final compose state settle into a snapshot
const h1 = await until(async () => { const h = hashOf(path.join(SNAP, snaps().pop())); await sleep(2500); return h === hashOf(path.join(SNAP, snaps().pop())) ? h : null; });
const mt = fs.statSync(path.join(SNAP, snaps().pop())).mtimeMs; await sleep(5000);
check('A3 idle document is not rewritten', fs.statSync(path.join(SNAP, snaps().pop())).mtimeMs === mt);
// simulate a manual edit made directly in the Photopea tab (not via compose)
await s.call('photopea_run_script', { script: 'var l=app.activeDocument.artLayers.add(); l.name="manual-edit";' });
const changed = await until(() => hashOf(path.join(SNAP, snaps().pop())) !== h1);
check('A4 manual edit triggers a new save', !!changed);
await s.c.close();

// ---- B: server restarts while the tab stays open -> reconnects, no duplicate document
s = await startServer();
check('B1 page reconnects to new server', await bridgeUp(s));
const st = await s.call('photopea_status');
check('B2 still exactly one document (no duplicate restore)', st.json?.doc?.docs === 1, st.text);
await s.c.close(); b.kill(); await sleep(1000);

// ---- C: tab lost (fresh browser profile) -> newest snapshot restored automatically
s = await startServer(); b = startBrowser();
check('C0 fresh page connects', await bridgeUp(s));
const layers = await s.call('photopea_list_layers');
const names = (layers.json || []).map((r) => r[1]);
check('C1 document restored on fresh page', names.includes('KEEPME') && names.includes('Box'), layers.text);
check('C2 manual edit survived the restore', names.includes('manual-edit'), layers.text);
const st2 = await s.call('photopea_status');
check('C3 exactly one document after restore', st2.json?.doc?.docs === 1, st2.text);
const ex = await s.call('photopea_export', { format: 'png', filename: 'restored' });
check('C4 restored document exports', !ex.err && fs.existsSync(path.join(OUT, 'restored.png')), ex.text);
await s.c.close(); b.kill(); await sleep(1000);

// ---- D: PHOTOPEA_MCP_AUTOSAVE=0 writes nothing and restores nothing
const OUT2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-autosave-off-'));
s = await startServer({ PHOTOPEA_MCP_AUTOSAVE: '0' }, OUT2); b = startBrowser();
check('D0 bridge ready', await bridgeUp(s));
await s.call('photopea_new_document', { width: 200, height: 200, background: '#ffffff' });
await sleep(7000);
check('D1 autosave disabled: no snapshots', snaps(path.join(OUT2, 'autosave')).length === 0);
await s.c.close(); b.kill();

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
