# photopea-pixels-iconify-mcp

MCP server to build posters in Photopea, with Pexels photos and Iconify icons.

## Use
1. `npm install`, then register it (add your free Pexels key from https://www.pexels.com/api/):
   `claude mcp add photopea -e PEXELS_API_KEY=your_key -- node /absolute/path/to/photopea-mcp/index.js`
2. Open http://localhost:8787/ in a browser and keep the tab open (or let the first Photopea tool call open it automatically; disable with `PHOTOPEA_MCP_AUTOOPEN=0`).
   Both indicators at the top must be green. The page hosts Photopea; the server drives it through it.
3. Ask for a poster.

## Tools (10)
Photopea: `photopea_status` (also opens the bridge), `photopea_new_document`, `photopea_compose` (batch of rect/text/image/icon ops in one call),
`photopea_list_layers`, `photopea_layer_edit`, `photopea_run_script`, `photopea_export`
Assets: `pexels_search`, `icons_search`, `icons_set_info`

Export formats (all tested): png, jpg, webp, pdf, psd (layers kept), gif, bmp, tiff, ico, dds. SVG/AI/EPS/TGA did not work from a raster poster.
Exports are saved to `./output` (override with `PHOTOPEA_MCP_OUTPUT`). Port: `PHOTOPEA_MCP_PORT` (default 8787).

## Notes
- Images are downloaded by the server and passed to Photopea as data URLs, so CORS is not an issue.
- Photopea loads images and fonts asynchronously; the tools wait for them.
- Pexels images are requested at ~1.5x the placed size from Pexels' CDN; downloads are cached in memory.
- Tests: `npm test` (needs `chromium`; runs Photopea headless). Pexels is tested against a mock API.
