// Verifies a Photopea tool call auto-opens the bridge URL via the system opener (fake xdg-open records the call).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakebin-')); const rec = path.join(dir, 'called.txt');
fs.writeFileSync(path.join(dir, 'xdg-open'), `#!/bin/sh\necho "$@" >> ${rec}\n`, { mode: 0o755 });
const c = new Client({ name: 't', version: '1' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PHOTOPEA_MCP_PORT: '8794' } }));
const t0 = Date.now();
const r = await Promise.race([c.callTool({ name: 'photopea_new_document', arguments: { width: 100, height: 100 } }), new Promise((r) => setTimeout(() => r({ content: [{ text: 'still waiting (expected, no real browser)' }] }), 4000))]);
console.log('opener called with:', fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').trim() : 'NOT CALLED');
await c.close(); process.exit(0);
