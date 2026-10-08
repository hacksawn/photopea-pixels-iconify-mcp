// SVG ops are rasterized by the browser (filters/gradients work), land exactly on x,y,w,h, and text rotate/tracking work.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import zlib from 'node:zlib';

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-svg-'));
let failed = 0;
const check = (label, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${ok ? '' : extra}`); };

// minimal PNG reader (8-bit RGB/RGBA, non-interlaced) -> pixel(x, y) = [r, g, b]
function readPng(file) {
  const b = fs.readFileSync(file); let p = 8, w, h, ct; const idat = [];
  while (p < b.length) { const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } if (type === 'IDAT') idat.push(d); p += 12 + len; }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) { const a = x >= bpp ? px[y * stride + x - bpp] : 0, up = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const pr = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : (() => { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); return pa <= pb && pa <= pc ? a : pb <= pc ? up : c; })();
      px[y * stride + x] = (row[x] + pr) & 255; } }
  return { w, h, pixel: (x, y) => [px[y * stride + x * bpp], px[y * stride + x * bpp + 1], px[y * stride + x * bpp + 2]] };
}

const c = new Client({ name: 't', version: '1' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, PHOTOPEA_MCP_PORT: '8850', PHOTOPEA_MCP_AUTOOPEN: '0', PHOTOPEA_MCP_AUTOSAVE: '0', PHOTOPEA_MCP_OUTPUT: OUT } }));
const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; return { err: !!r.isError, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };
const b = spawn('chromium', ['--headless=new', '--no-sandbox', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'pp-prof-'))}`, 'http://localhost:8850/'], { stdio: 'ignore' });
for (let i = 0; i < 90; i++) { if ((await call('photopea_status')).json?.ready) break; await new Promise((r) => setTimeout(r, 1000)); }

await call('photopea_new_document', { width: 300, height: 200, background: '#ffffff' });
const svgOp = { type: 'svg', x: 0, y: 0, w: 300, h: 200, name: 'art', svg: '<svg xmlns="http://www.w3.org/2000/svg"><defs><filter id="b"><feGaussianBlur stdDeviation="1"/></filter><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#0000ff"/><stop offset="1" stop-color="#00ff00"/></linearGradient></defs><rect x="40" y="30" width="80" height="60" fill="#ff0000" filter="url(#b)"/><rect x="160" y="30" width="100" height="60" fill="url(#g)"/></svg>' };
const r1 = await call('photopea_compose', { ops: [svgOp, { type: 'text', text: 'Wide', x: 20, y: 150, size: 30, font: 'Arial-BoldMT', name: 'tight' }, { type: 'text', text: 'Wide', x: 120, y: 150, size: 30, font: 'Arial-BoldMT', tracking: 200, name: 'loose' }, { type: 'text', text: 'Turn', x: 250, y: 120, size: 30, font: 'Arial-BoldMT', rotate: 90, name: 'turned' }] });
check('compose with svg + rotated/tracked text succeeds', !r1.err, r1.text);
const [svgB, tightB, looseB, turnB] = r1.json || [];
check('svg layer maps exactly onto x,y,w,h', svgB && svgB.join() === '0,0,300,200', JSON.stringify(svgB));
check('tracking widens text', tightB && looseB && (looseB[2] - looseB[0]) > (tightB[2] - tightB[0]) + 10, JSON.stringify([tightB, looseB]));
check('rotate 90 turns text on its side (taller than wide)', turnB && (turnB[3] - turnB[1]) > (turnB[2] - turnB[0]), JSON.stringify(turnB));

const ex = await call('photopea_export', { format: 'png', filename: 'svgtest' });
const png = readPng(path.join(OUT, 'svgtest.png'));
const near = (p, q, t = 40) => p.every((v, i) => Math.abs(v - q[i]) <= t);
check('browser-rendered shape is in the export (red box centre)', near(png.pixel(80, 60), [255, 0, 0]), JSON.stringify(png.pixel(80, 60)));
check('gradient is rendered (blue left, green right)', near(png.pixel(165, 60), [0, 0, 255], 60) && near(png.pixel(255, 60), [0, 255, 0], 60), JSON.stringify([png.pixel(165, 60), png.pixel(255, 60)]));
check('blur filter applied (red box edge is soft, not hard)', (() => { const e = png.pixel(40, 60); return e[1] > 60 && e[1] < 230; })(), JSON.stringify(png.pixel(40, 60)));
check('untouched area stays white', near(png.pixel(5, 195), [255, 255, 255], 6), JSON.stringify(png.pixel(5, 195)));

const bad = await call('photopea_compose', { ops: [{ type: 'svg', x: 0, y: 0, w: 50, h: 50, svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="red"' }] });
check('invalid SVG is rejected with a clear message', bad.err && /svg/i.test(bad.text), bad.text);

b.kill(); await c.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
