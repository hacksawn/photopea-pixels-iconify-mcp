// Shared bridge: a second server on the same port shares the first one's Photopea tab (same URL, one tab); when the host
// exits the other takes over the port and the tab reconnects; a port held by an unrelated program is skipped.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
let failed = 0;
const check = (label, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${ok ? '' : extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(400); } return null; };

const start = async (port) => {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, PHOTOPEA_MCP_PORT: port, PHOTOPEA_MCP_AUTOOPEN: '0', PHOTOPEA_MCP_AUTOSAVE: '0' } }));
  await sleep(900);
  const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; return { err: !!r.isError, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };
  return { c, call, status: async () => (await call('photopea_status')).json };
};

// ---- 1. two servers, one port -> one shared bridge
const A = await start('8830'), B = await start('8830');
const sa = await A.status(), sb = await B.status();
check('both servers report the same bridge URL', sa.url === 'http://localhost:8830/' && sb.url === 'http://localhost:8830/', JSON.stringify([sa, sb]));

const page = spawn('chromium', ['--headless=new', '--no-sandbox', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'pp-prof-'))}`, 'http://localhost:8830/'], { stdio: 'ignore' });
check('host sees the Photopea page', await until(async () => (await A.status()).ready), '');
const sb2 = await until(async () => { const s = await B.status(); return s.ready ? s : null; });
check('second server sees the same page (shared)', sb2 && sb2.shared === true, JSON.stringify(sb2));
const mk = await B.call('photopea_new_document', { width: 200, height: 100, background: '#ffffff' });
check('second server can drive the shared page', !mk.err, mk.text);
const seen = await A.status();
check('host sees the document the second server created (one tab)', seen.doc && seen.doc.docs === 1 && seen.doc.w === 200, JSON.stringify(seen));
const comp = await B.call('photopea_compose', { ops: [{ type: 'rect', x: 0, y: 0, w: 50, h: 50, color: '#f00', name: 'Shared' }] });
check('compose through the shared bridge works', !comp.err, comp.text);

// ---- 2. host exits -> the other takes over, same URL, same tab, document intact
await A.c.close();
const promoted = await until(async () => { const s = await B.status(); return s.ready && !s.shared ? s : null; }, 30000);
check('after the host exits, the other takes over the same URL', promoted && promoted.url === 'http://localhost:8830/', JSON.stringify(promoted));
check('the open document survives the takeover', promoted && promoted.doc && promoted.doc.docs === 1, JSON.stringify(promoted));
await B.c.close(); page.kill();

// ---- 3. port held by an unrelated program -> next port
const squatter = http.createServer((q, r) => r.end('not photopea')).listen(8836, '127.0.0.1');
await sleep(200);
const C = await start('8836');
const sc = await C.status();
check('a port held by another program is skipped', sc.url === 'http://localhost:8837/', JSON.stringify(sc));
await C.c.close(); squatter.close();

// ---- 4. orphan exit: stdin closing ends the process
const child = spawn('node', ['index.js'], { env: { ...process.env, PHOTOPEA_MCP_PORT: '8835', PHOTOPEA_MCP_AUTOSAVE: '0' }, stdio: ['pipe', 'ignore', 'ignore'] });
await sleep(1000);
const exited = new Promise((r) => child.on('exit', () => r(true)));
child.stdin.end();
const gone = await Promise.race([exited, sleep(3000).then(() => false)]);
check('server exits when its MCP client disconnects', gone, 'orphan server kept running');
if (!gone) child.kill();

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
