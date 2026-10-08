import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
let seen;
const mock = http.createServer((req, res) => {
  seen = { auth: req.headers.authorization, url: req.url };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ total_results: 1, page: 1, photos: [{ id: 7, width: 4000, height: 3000, photographer: 'Jane', url: 'https://www.pexels.com/photo/7/', alt: 'concert', avg_color: '#112233', src: { large2x: 'https://images.pexels.com/x-large2x.jpg', original: 'https://images.pexels.com/x.jpg', portrait: 'p', landscape: 'l' } }] }));
}).listen(8799);
const c = new Client({ name: 't', version: '1' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env, PHOTOPEA_MCP_PORT: '8793', PEXELS_API_KEY: 'secret-key', PEXELS_API_BASE: 'http://localhost:8799' } }));
const r = await c.callTool({ name: 'pexels_search', arguments: { query: 'concert crowd', count: 3, orientation: 'portrait' } });
console.log(r.isError ? 'FAIL' : 'PASS', r.content[0].text.slice(0, 250).replace(/\s+/g, ' '));
console.log('auth header sent:', seen.auth === 'secret-key', '| query:', seen.url);
await c.close(); mock.close(); process.exit(0);
