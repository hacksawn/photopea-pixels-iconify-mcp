#!/usr/bin/env node
// Photopea MCP server: drives Photopea through a local bridge page, plus Pexels photo search and Iconify icons.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PHOTOPEA_MCP_PORT || 8787);
const OUT_DIR = process.env.PHOTOPEA_MCP_OUTPUT || path.join(__dirname, 'output');
const PEXELS_KEY = process.env.PEXELS_API_KEY || '';
fs.mkdirSync(OUT_DIR, { recursive: true });

const log = (...a) => console.error('[photopea-mcp]', ...a); // stdout is reserved for MCP

// ---------------------------------------------------------------- bridge
let bridge = null; // active WebSocket from the bridge page
let peaReady = false;
const pending = new Map();
let nextId = 1;

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/' || url.pathname === '/bridge.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'bridge.html')));
  }
  res.writeHead(404); res.end();
});
httpServer.on('error', (e) => log('http error:', e.message));

// Only the local bridge page may connect (blocks other websites from hijacking the bridge).
const ALLOWED_ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
const wss = new WebSocketServer({ server: httpServer, path: '/ws', verifyClient: ({ origin }) => ALLOWED_ORIGINS.includes(origin) });
wss.on('connection', (ws) => {
  bridge = ws; peaReady = false;
  log('bridge page connected');
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'photopea-ready') { peaReady = true; restoring = maybeRestore(); return; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p.resolve(m); }
  });
  ws.on('close', () => {
    if (bridge === ws) { bridge = null; peaReady = false; }
    for (const [id, p] of pending) { pending.delete(id); p.reject(new Error('bridge page disconnected')); }
  });
});
httpServer.listen(PORT, '127.0.0.1', () => log(`bridge at http://localhost:${PORT}`));

const BRIDGE_URL = `http://localhost:${PORT}/`;

async function launchBrowser() {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', BRIDGE_URL] : [BRIDGE_URL];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e) => log('could not open browser:', e.message));
  child.unref();
}

let lastLaunch = 0;
async function waitReady(ms = 40000) {
  const t0 = Date.now();
  while (!(bridge && peaReady)) {
    // No bridge tab yet: open one automatically (at most once per 30s) unless disabled.
    if (!bridge && process.env.PHOTOPEA_MCP_AUTOOPEN !== '0' && Date.now() - lastLaunch > 30000) {
      lastLaunch = Date.now();
      log('opening bridge in browser');
      await launchBrowser();
    }
    if (Date.now() - t0 > ms) {
      throw new Error(`Photopea bridge is not connected. Open ${BRIDGE_URL} in a browser tab, wait for both indicators to turn green, then retry.`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function runScript(script, timeout = 60000, internal = false) {
  await waitReady();
  if (!internal) await restoring;
  const id = nextId++;
  const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  bridge.send(JSON.stringify({ type: 'script', id, script, timeout }));
  const m = await p;
  if (m.error) throw new Error(m.error + (m.outputs?.length ? ` (output: ${m.outputs.join(' | ')})` : ''));
  return m;
}

// Run a script body and return the single echoed result (as parsed JSON when possible).
async function evalJs(body, timeout, internal = false) {
  const wrapped = `try { var __r = (function(){ ${body} })(); app.echoToOE(JSON.stringify({ok:true, result:__r})); } catch(e) { app.echoToOE(JSON.stringify({ok:false, error:String(e)})); }`;
  const m = await runScript(wrapped, timeout, internal);
  const line = m.outputs.find((o) => o.startsWith('{')) ;
  if (!line) throw new Error('Photopea returned no result. Output: ' + JSON.stringify(m.outputs));
  const j = JSON.parse(line);
  if (!j.ok) throw new Error('Photopea script error: ' + j.error);
  return j.result;
}

const J = (v) => JSON.stringify(v);
const hex = (c) => String(c).replace('#', '');
const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] });
let busy = 0; // MCP tool calls in flight; autosave waits for them
const tool = (fn) => async (args) => { busy++; try { return await fn(args); } catch (e) { return fail(e); } finally { busy--; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NUM = `function __n(v){return (v && v.value!==undefined) ? v.value : v;}`;

// Download in Node (no CORS limits) and hand Photopea a data: URL. Small FIFO cache for repeated assets.
const imgCache = new Map();
async function toDataUrl(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  const r = await fetch(url, { headers: { 'user-agent': 'photopea-mcp' } });
  if (!r.ok) throw new Error(`Could not download image (${r.status}): ${url}`);
  let type = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) type = /\.svg(\?|$)/i.test(url) ? 'image/svg+xml' : 'image/jpeg';
  const data = `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  imgCache.set(url, data);
  if (imgCache.size > 12) imgCache.delete(imgCache.keys().next().value);
  return data;
}

// Ask Pexels' CDN for a right-sized, compressed image instead of the full original.
function rightSize(url, w, h) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'images.pexels.com') return url;
    const target = Math.max(w || 0, h || 0);
    if (!target) return url;
    u.search = `?auto=compress&cs=tinysrgb&w=${Math.min(2600, Math.ceil(target * 1.5))}`;
    return u.toString();
  } catch { return url; }
}

// Photopea's app.open() finishes loading after the script reports done, so poll for the new layer.
async function waitFor(check, what, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await check(); if (v) return v; await sleep(150); }
  throw new Error(`Timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- autosave / restore
// Saves the open document as a PSD every few seconds (only when it changed, including manual edits in the
// Photopea tab) and reopens the newest snapshot when a fresh Photopea page connects with nothing open.
const AUTOSAVE = process.env.PHOTOPEA_MCP_AUTOSAVE !== '0';
const AUTOSAVE_SECS = Math.max(1, Number(process.env.PHOTOPEA_MCP_AUTOSAVE_SECS || 15));
const SAVE_DIR = path.join(OUT_DIR, 'autosave');
const KEEP_SNAPSHOTS = 10, SNAPSHOT_EVERY_MS = 60000;
let lastFp = null, lastSnapshotAt = 0, saving = false, restoring = Promise.resolve();

const FINGERPRINT = `if(app.documents.length==0) return null; var d=app.activeDocument, f=[d.name,d.width,d.height,d.historyStates?d.historyStates.length:0];
  for(var i=0;i<d.layers.length;i++){var l=d.layers[i],b=l.bounds; f.push(l.name,l.visible?1:0,l.opacity,b[0].value,b[1].value,b[2].value,b[3].value);}
  return f.join('|');`;

const snapshots = () => (fs.existsSync(SAVE_DIR) ? fs.readdirSync(SAVE_DIR).filter((f) => /^autosave-.*\.psd$/.test(f)).sort() : []);

async function autosaveTick() {
  if (!AUTOSAVE || saving || busy || !(bridge && peaReady)) return;
  saving = true;
  try {
    const fp = await evalJs(FINGERPRINT, undefined, true);
    if (!fp || fp === lastFp) return; // nothing open (never overwrite a good snapshot) or unchanged
    const m = await runScript(`app.activeDocument.saveToOE("psd");`, 60000, true);
    if (!m.buffers.length) return;
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    const existing = snapshots();
    const now = Date.now();
    // new snapshot file at most once a minute; otherwise refresh the newest one
    const file = existing.length && now - lastSnapshotAt < SNAPSHOT_EVERY_MS
      ? existing[existing.length - 1]
      : `autosave-${new Date(now).toISOString().replace(/[:.]/g, '-')}.psd`;
    if (file !== existing[existing.length - 1]) lastSnapshotAt = now;
    fs.writeFileSync(path.join(SAVE_DIR, file), Buffer.from(m.buffers[0], 'base64'));
    lastFp = fp;
    for (const old of snapshots().slice(0, -KEEP_SNAPSHOTS)) fs.unlinkSync(path.join(SAVE_DIR, old));
  } catch (e) { log('autosave skipped:', e.message); } finally { saving = false; }
}
if (AUTOSAVE) setInterval(autosaveTick, AUTOSAVE_SECS * 1000).unref();

async function maybeRestore() {
  if (!AUTOSAVE) return;
  try {
    const latest = snapshots().pop();
    if (!latest) return;
    const docs = await evalJs(`return app.documents.length;`, undefined, true);
    if (docs !== 0) return; // page already has work open (e.g. server restarted); leave it alone
    const dataUrl = `data:application/octet-stream;base64,${fs.readFileSync(path.join(SAVE_DIR, latest)).toString('base64')}`;
    await runScript(`app.open(${J(dataUrl)});`, 90000, true);
    await waitFor(async () => (await evalJs(`return app.documents.length;`, undefined, true)) > 0, 'the autosaved document to open');
    lastFp = null; lastSnapshotAt = Date.now();
    log('restored', latest);
  } catch (e) { log('restore failed:', e.message); }
}

// ---------------------------------------------------------------- server
const server = new McpServer({ name: 'photopea-mcp', version: '1.1.0' });
const bounds4 = `[b[0].value,b[1].value,b[2].value,b[3].value]`;

server.registerTool('photopea_status', {
  description: 'Bridge/Photopea state and active document info. Photopea tools auto-open the bridge page in the browser; launch=true opens it now.',
  inputSchema: { launch: z.boolean().optional() },
}, tool(async ({ launch }) => {
  if (launch) { lastLaunch = Date.now(); await launchBrowser(); }
  if (!(bridge && peaReady)) return text({ connected: !!bridge, ready: peaReady, url: BRIDGE_URL });
  const doc = await evalJs(`${NUM} if(app.documents.length==0) return null; var d=app.activeDocument; return {name:d.name,w:__n(d.width),h:__n(d.height),dpi:d.resolution,layers:d.layers.length,docs:app.documents.length};`);
  return text({ ready: true, doc });
}));

server.registerTool('photopea_new_document', {
  description: 'Create the poster canvas (px). E.g. 1080x1620, or A3@300dpi = 3508x4961.',
  inputSchema: {
    width: z.number().int().positive(), height: z.number().int().positive(),
    name: z.string().optional(), background: z.string().optional().describe('hex like #fff; omit = transparent'),
    dpi: z.number().optional(),
  },
}, tool(async ({ width, height, name = 'Poster', background, dpi = 72 }) => {
  const m = await runScript(`app.echoToOE(String(app.documents.length)); app.documents.add(${width}, ${height}, ${dpi}, ${J(name)}, NewDocumentMode.RGB, DocumentFill.TRANSPARENT);`);
  const before = Number(m.outputs[0]);
  await waitFor(async () => (await evalJs(`return app.documents.length;`)) > before, 'the new document');
  const r = await evalJs(`${NUM}
    var d = app.activeDocument;
    ${background ? `var c=new SolidColor(); c.rgb.hexValue=${J(hex(background))}; d.selection.selectAll(); d.selection.fill(c); d.selection.deselect();` : ''}
    return {name:d.name,w:__n(d.width),h:__n(d.height),dpi:d.resolution};`);
  return text(r);
}));

// ---- element builders (used by photopea_compose) ----
async function opRect(o) {
  await evalJs(`
    var d=app.activeDocument; var l=d.artLayers.add(); l.name=${J(o.name || 'rect')};
    var c=new SolidColor(); c.rgb.hexValue=${J(hex(o.color))};
    d.selection.select([[${o.x},${o.y}],[${o.x + o.w},${o.y}],[${o.x + o.w},${o.y + o.h}],[${o.x},${o.y + o.h}]]);
    d.selection.fill(c); d.selection.deselect(); l.opacity=${o.opacity ?? 100};`);
  return 'rect';
}

async function opText(o, ctx) {
  const name = o.name || o.text.slice(0, 24);
  const just = { left: 'LEFT', center: 'CENTER', right: 'RIGHT' }[o.align || 'left'];
  await evalJs(`
    var d=app.activeDocument; var pt=${o.size ?? 48}*72/d.resolution;
    var l=d.artLayers.add(); l.kind=LayerKind.TEXT; var t=l.textItem;
    t.contents=${J(o.text)}; t.size=pt; t.font=${J(o.font || 'ArialMT')};
    var c=new SolidColor(); c.rgb.hexValue=${J(hex(o.color || '#000000'))}; t.color=c;
    t.justification=Justification.${just}; t.position=[${o.x},${o.y}];
    l.name=${J(name)};`);
  ctx.texts.push(name); // layout finishes asynchronously; verified once at the end of the batch
  return 'text';
}

async function opImage(o) {
  const dataUrl = await toDataUrl(rightSize(o.url, o.w, o.h));
  const m = await runScript(`app.echoToOE(String(app.activeDocument.layers.length)); app.open(${J(dataUrl)}, null, true);`, 90000);
  const before = Number(m.outputs[0]);
  await waitFor(async () => (await evalJs(`return app.activeDocument.layers.length;`)) > before, 'the image to load (check the URL)');
  return evalJs(`
    var d=app.activeDocument; var l=d.activeLayer; var b=l.bounds;
    var w=b[2].value-b[0].value, h=b[3].value-b[1].value;
    var tw=${o.w ?? 'null'}, th=${o.h ?? 'null'}, s;
    if(tw!==null && th!==null){ s = ${J(o.fit || 'contain')}==='cover' ? Math.max(tw/w,th/h) : Math.min(tw/w,th/h); }
    else if(tw!==null) s=tw/w; else if(th!==null) s=th/h; else s=1;
    if(s!==1) l.resize(s*100, s*100, AnchorPosition.TOPLEFT);
    b=l.bounds; var nw=b[2].value-b[0].value, nh=b[3].value-b[1].value;
    var ox=${o.x ?? 0}, oy=${o.y ?? 0};
    if(tw!==null && th!==null){ ox += (tw-nw)/2; oy += (th-nh)/2; }
    l.translate(ox-b[0].value, oy-b[1].value);
    ${o.name ? `l.name=${J(o.name)};` : ''}
    b=l.bounds; return ${bounds4};`);
}

const opIcon = (o) => {
  const size = o.size ?? 256;
  return opImage({ url: iconUrl(o.icon, o.color || '#000000', size), x: o.x, y: o.y, w: size, h: size, name: o.name || o.icon });
};

const ICON = z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+$/);
const OP = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rect'), x: z.number(), y: z.number(), w: z.number(), h: z.number(), color: z.string(), opacity: z.number().optional(), name: z.string().optional() }),
  z.object({ type: z.literal('text'), text: z.string(), x: z.number(), y: z.number(), size: z.number().optional().describe('px, default 48'), color: z.string().optional(), font: z.string().optional().describe('PostScript name, e.g. Arial-BoldMT, Impact, Georgia-Bold'), align: z.enum(['left', 'center', 'right']).optional().describe('x is the left/center/right anchor; y is the baseline'), name: z.string().optional() }),
  z.object({ type: z.literal('image'), url: z.string().url(), x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional(), fit: z.enum(['contain', 'cover']).optional().describe('with both w,h: contain=inside box (default), cover=fills box and overflows'), name: z.string().optional() }),
  z.object({ type: z.literal('icon'), icon: ICON.describe('Iconify "prefix:name"'), color: z.string().optional(), size: z.number().optional(), x: z.number().optional(), y: z.number().optional(), name: z.string().optional() }),
]);

server.registerTool('photopea_compose', {
  description: 'Add many elements to the active document in ONE call, applied in order (later ops stack on top). Coordinates are px from top-left. Returns image/icon/text bounds [x0,y0,x1,y1] for verification.',
  inputSchema: { ops: z.array(OP).min(1).max(40) },
}, tool(async ({ ops }) => {
  const ctx = { texts: [] }, res = [];
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    try {
      res.push(o.type === 'rect' ? await opRect(o) : o.type === 'text' ? await opText(o, ctx) : o.type === 'image' ? await opImage(o) : await opIcon(o));
    } catch (e) {
      return fail(new Error(`op ${i} (${o.type}) failed: ${e.message}. Ops 0-${i - 1} were applied.`));
    }
  }
  if (ctx.texts.length) {
    const names = J(ctx.texts);
    const info = await waitFor(async () => {
      const r = await evalJs(`var want=${names}, out={}, d=app.activeDocument;
        for(var i=0;i<d.layers.length;i++){var l=d.layers[i]; if(want.indexOf(l.name)>=0 && !(l.name in out)){var b=l.bounds; out[l.name]=${bounds4};}}
        return out;`);
      return ctx.texts.every((n) => r[n] && r[n][2] > r[n][0]) ? r : null;
    }, 'text to render (check font names)', 30000);
    let k = 0;
    for (let i = 0; i < ops.length; i++) if (ops[i].type === 'text') res[i] = info[ctx.texts[k++]];
  }
  return text(res);
}));

server.registerTool('photopea_list_layers', {
  description: 'Layers of the active document, top first. rows = [index, name, kind, visible, opacity, x0, y0, x1, y1].',
  inputSchema: {},
}, tool(async () => text(await evalJs(`
  var d=app.activeDocument, rows=[], K={"0":"raster","1":"smart","2":"text"};
  for(var i=0;i<d.layers.length;i++){var l=d.layers[i], b=l.bounds;
    rows.push([i,l.name,K[String(l.kind)]||String(l.kind),l.visible?1:0,l.opacity,b[0].value,b[1].value,b[2].value,b[3].value]);}
  return rows;`))));

server.registerTool('photopea_layer_edit', {
  description: 'Edit a layer by index (from photopea_list_layers): rename, show/hide, opacity, move by dx/dy, delete, or reorder to top/bottom.',
  inputSchema: {
    index: z.number().int(), name: z.string().optional(), visible: z.boolean().optional(), opacity: z.number().min(0).max(100).optional(),
    dx: z.number().optional(), dy: z.number().optional(), delete: z.boolean().optional(), order: z.enum(['top', 'bottom']).optional(),
  },
}, tool(async (a) => {
  await evalJs(`
  var d=app.activeDocument, l=d.layers[${a.index}]; if(!l) throw new Error('no layer at index ${a.index}');
  ${a.delete ? 'l.remove();' : `
  ${a.name !== undefined ? `l.name=${J(a.name)};` : ''}
  ${a.visible !== undefined ? `l.visible=${a.visible};` : ''}
  ${a.opacity !== undefined ? `l.opacity=${a.opacity};` : ''}
  ${a.dx !== undefined || a.dy !== undefined ? `l.translate(${a.dx || 0}, ${a.dy || 0});` : ''}
  ${a.order ? `l.move(d, ${a.order === 'top' ? 'ElementPlacement.PLACEATBEGINNING' : 'ElementPlacement.PLACEATEND'});` : ''}`}
  return 1;`);
  return text('ok');
}));

server.registerTool('photopea_run_script', {
  description: 'Run raw Photopea JavaScript (Photoshop-style API). Return data with app.echoToOE(string). Note: app.open(url) and text layout finish after the script ends.',
  inputSchema: { script: z.string(), timeoutMs: z.number().optional() },
}, tool(async ({ script, timeoutMs = 60000 }) => {
  const m = await runScript(script, timeoutMs);
  return text(m.outputs);
}));

server.registerTool('photopea_export', {
  description: 'Export the active document to disk; returns the file path. jpg/webp take quality 0-1.',
  inputSchema: {
    format: z.enum(['png', 'jpg', 'webp', 'pdf', 'psd', 'gif', 'bmp', 'tiff', 'ico', 'dds']).optional().describe('psd keeps layers'),
    quality: z.number().min(0).max(1).optional(),
    filename: z.string().optional().describe('without extension'),
    timeoutMs: z.number().optional().describe('default 90000'),
  },
}, tool(async ({ format = 'png', quality = 0.92, filename, timeoutMs = 90000 }) => {
  const spec = format === 'jpg' || format === 'webp' ? `${format}:${quality}` : format;
  const m = await runScript(`app.activeDocument.saveToOE(${J(spec)});`, timeoutMs);
  if (!m.buffers.length) throw new Error('Photopea returned no file. Output: ' + JSON.stringify(m.outputs));
  const base = (filename || `poster-${new Date().toISOString().replace(/[:.]/g, '-')}`).replace(/[^\w.-]/g, '_');
  const file = path.join(OUT_DIR, `${base}.${format}`);
  const buf = Buffer.from(m.buffers[0], 'base64');
  fs.writeFileSync(file, buf);
  return text(`${file} (${buf.length} bytes)`);
}));

// ---------------------------------------------------------------- Pexels
server.registerTool('pexels_search', {
  description: 'Search free Pexels photos (needs PEXELS_API_KEY). Returns [id, w, h, alt, photographer, url]; pass url to a compose image op (it is auto-resized to the target size).',
  inputSchema: {
    query: z.string(), count: z.number().int().min(1).max(30).optional().describe('default 6'),
    orientation: z.enum(['landscape', 'portrait', 'square']).optional(), color: z.string().optional(),
    page: z.number().int().min(1).optional(),
  },
}, tool(async ({ query, count = 6, orientation, color, page = 1 }) => {
  if (!PEXELS_KEY) throw new Error('PEXELS_API_KEY is not set. Get a free key at https://www.pexels.com/api/ and add it to the MCP server env.');
  const u = new URL(`${process.env.PEXELS_API_BASE || 'https://api.pexels.com'}/v1/search`);
  u.searchParams.set('query', query); u.searchParams.set('per_page', count); u.searchParams.set('page', page);
  if (orientation) u.searchParams.set('orientation', orientation);
  if (color) u.searchParams.set('color', color);
  const r = await fetch(u, { headers: { Authorization: PEXELS_KEY } });
  if (!r.ok) throw new Error(`Pexels API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return text({ total: j.total_results, photos: j.photos.map((p) => [p.id, p.width, p.height, (p.alt || '').slice(0, 70), p.photographer, p.src.large2x]) });
}));

// ---------------------------------------------------------------- Iconify
function iconUrl(icon, color = '#000000', size = 256) {
  const [prefix, name] = icon.split(':');
  return `https://api.iconify.design/${prefix}/${name}.svg?color=${encodeURIComponent(color)}&height=${size}`;
}

server.registerTool('icons_search', {
  description: 'Search free Iconify icons (no key). Returns "prefix:name" ids for compose icon ops. prefixes limits sets, e.g. "lucide,mdi,ph".',
  inputSchema: { query: z.string(), limit: z.number().int().min(1).max(60).optional().describe('default 12'), prefixes: z.string().optional() },
}, tool(async ({ query, limit = 12, prefixes }) => {
  const u = new URL('https://api.iconify.design/search');
  u.searchParams.set('query', query); u.searchParams.set('limit', limit);
  if (prefixes) u.searchParams.set('prefixes', prefixes);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Iconify ${r.status}`);
  return text((await r.json()).icons);
}));

server.registerTool('icons_set_info', {
  description: 'License/author of an Iconify set prefix (e.g. "mdi"), for commercial-use checks.',
  inputSchema: { prefix: z.string() },
}, tool(async ({ prefix }) => {
  const r = await fetch(`https://api.iconify.design/collection?prefix=${encodeURIComponent(prefix)}&info=true`);
  if (!r.ok) throw new Error(`Iconify ${r.status}`);
  const j = (await r.json()).info || {};
  return text({ name: j.name, license: j.license?.title, author: j.author?.name });
}));

await server.connect(new StdioServerTransport());
log('MCP server running on stdio');
