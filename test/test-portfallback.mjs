// Two servers started on the same port must both stay up; the second moves to the next free port (no EADDRINUSE crash).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const start = async () => {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, PHOTOPEA_MCP_PORT: '8830', PHOTOPEA_MCP_AUTOOPEN: '0', PHOTOPEA_MCP_AUTOSAVE: '0' } }));
  await new Promise((r) => setTimeout(r, 800));
  return c;
};
const url = async (c) => JSON.parse((await c.callTool({ name: 'photopea_status', arguments: {} })).content[0].text).url;
const a = await start(), b = await start();
const ua = await url(a), ub = await url(b);
console.log(ua, ub);
const ok = ua === 'http://localhost:8830/' && ub === 'http://localhost:8831/';
console.log(ok ? 'PASS second instance fell back to the next port and is alive' : 'FAIL');
await a.close(); await b.close();

// A server whose MCP client disappears (stdin closes) must exit instead of lingering and holding the port.
import { spawn } from 'node:child_process';
const child = spawn('node', ['index.js'], { env: { ...process.env, PHOTOPEA_MCP_PORT: '8835', PHOTOPEA_MCP_AUTOSAVE: '0' }, stdio: ['pipe', 'ignore', 'ignore'] });
await new Promise((r) => setTimeout(r, 1000));
const exited = new Promise((r) => child.on('exit', () => r(true)));
child.stdin.end();
const gone = await Promise.race([exited, new Promise((r) => setTimeout(() => r(false), 3000))]);
console.log(gone ? 'PASS server exits when its client disconnects' : 'FAIL orphan server kept running');
if (!gone) child.kill();
process.exit(ok && gone ? 0 : 1);
