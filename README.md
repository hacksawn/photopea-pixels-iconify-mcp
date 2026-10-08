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

## Autosave and restore
The server saves the open document as a PSD (layers kept) every few seconds, only when it changed, including edits you make by hand in the Photopea tab.
Snapshots go to `./output/autosave/` (newest 10 kept, at most one new file per minute). If you reload or lose the tab, the next time the bridge page
connects with nothing open, the newest snapshot is reopened automatically. A tab that still has your document open is never touched.
Settings: `PHOTOPEA_MCP_AUTOSAVE=0` to turn it off, `PHOTOPEA_MCP_AUTOSAVE_SECS` (default 15). Autosave pauses while a tool call is running.

## Notes
- Images are downloaded by the server and passed to Photopea as data URLs, so CORS is not an issue.
- Photopea loads images and fonts asynchronously; the tools wait for them.
- Pexels images are requested at ~1.5x the placed size from Pexels' CDN; downloads are cached in memory.
- Tests: `npm test` (needs `chromium`; runs Photopea headless). Pexels is tested against a mock API; autosave/restore has its own end-to-end test.
