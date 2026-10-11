import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { ItemEngine, message } from './electron/items';
import { MediaFiles } from './electron/media-files';
import { cropSource, parseCropRequest, parseCropView, parseSavedCropSizes } from './electron/crop';
import { compareSources, parseCompareView } from './electron/compare';
import { imageDefaults, rendererSettings } from './electron/settings';
import { seedBuiltinPipelines } from './core/pipeline/builtins';
import { tilesFor } from './core/pipeline/zones';
import { EditorService } from './electron/editor';
import { demoSettings } from './scripts/preview-demo';
import { defaultSettings, parseSettings } from './core/settings/schema';
import { createPrefs } from './electron/prefs';
import type { ImageOptions } from './src/types';

function localImagePreview(): Plugin {
  let settings = defaultSettings();
  settings = parseSettings(seedBuiltinPipelines(settings.savedPipelines, 0), settings);
  // CLOP_PREVIEW_DEMO=1 fills the editor with example attachments and preset zones, for screenshots.
  if (process.env.CLOP_PREVIEW_DEMO) settings = parseSettings(demoSettings(settings), settings);
  // The preview keeps its settings in memory; updates still run one at a time, like the app's `SettingsStore.update`.
  let turn: Promise<unknown> = Promise.resolve();
  const editor = new EditorService({
    settings: () => settings, context: () => ({ home: os.homedir() }),
    update: change => {
      const job = turn.then(() => { const { patch, result } = change(settings); if (patch !== undefined) settings = parseSettings(patch, settings); return { settings, result }; });
      turn = job.catch(() => {});
      return job;
    },
  });
  const session = path.resolve('.preview-data', `session-${Date.now()}`);
  const engine = new ItemEngine(session, () => settings), media = new MediaFiles([session], '/api/media/');
  // The settings actions that need a picker answer that pickers work in the desktop app; the rest run for real on the preview's settings.
  const desktopOnly = async (): Promise<never> => { throw new Error('Pickers work in the desktop app.'); };
  const prefs = createPrefs({
    settings: () => settings, defaults: () => defaultSettings(), set: async partial => { settings = parseSettings(partial, settings); }, home: os.homedir(),
    chooseFolder: desktopOnly, chooseProgram: desktopOnly, apps: async () => [], openEditor: () => {}, openExternal: desktopOnly, version: () => ({ name: 'preview', platform: 'preview' }),
  });
  return {
    name: 'clop-local-image-preview',
    transformIndexHtml(html, context) {
      // Vite's React refresh preamble is inline in development only.
      return context.server ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline'; worker-src 'self' blob:;") : html;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        res.setHeader('Cache-Control', 'no-store');
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) { res.statusCode = 403; res.end('Forbidden'); return; }
        try {
          if (req.method === 'GET' && req.url.startsWith('/api/output/')) {
            const id = req.url.split('/').pop()!;
            const file = engine.output(id), result = engine.get(id).result;
            res.setHeader('Content-Type', result.kind === 'image' ? `image/${result.format}` : 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.parse(result.name).name)}-clop.${result.format === 'jpeg' ? 'jpg' : result.format}"`);
            res.end(await readFile(file)); return;
          }
          if (req.method === 'GET' && req.url.startsWith('/api/png/')) {
            res.setHeader('Content-Type', 'image/png'); res.end(await sharp(engine.output(req.url.split('/').pop()!)).png().toBuffer()); return;
          }
          if (req.method === 'GET' && req.url === '/api/editor-state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(editor.state())); return; }
          if (req.method === 'GET' && req.url.startsWith('/api/media/')) {
            const headers = new Headers(); if (req.headers.range) headers.set('range', req.headers.range);
            const response = await media.handle(new Request(`http://preview${req.url}`, { headers }));
            res.statusCode = response.status; response.headers.forEach((value, key) => res.setHeader(key, value));
            if (response.body) Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res); else res.end();
            return;
          }
          let reply: unknown;
          if (req.url === '/api/crop-sizes') reply = settings.savedCropSizes;
          else if (req.url !== '/api/state') {
            if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) throw new Error('Send an image operation as JSON.');
            let size = 0; const chunks: Buffer[] = [];
            for await (const chunk of req) { size += chunk.length; if (size > 48 * 1024 * 1024) throw new Error('Use an image smaller than 32 MB in the browser preview.'); chunks.push(Buffer.from(chunk)); }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            switch (req.url) {
              case '/api/editor-command': res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await editor.command(body))); return;
              case '/api/import':
                if (engine.list().length >= 40) throw new Error('Dismiss some images before adding more.');
                await engine.importBuffer(Buffer.from(body.data, 'base64'), String(body.name), 'drop', { ...imageDefaults(settings), ...(body.aggressive === true ? { mode: 'aggressive' } : {}) }); break;
              case '/api/apply': await engine.apply(body.id, body.options as ImageOptions); break;
              case '/api/restore': await engine.restore(body.id); break;
              case '/api/dismiss': await engine.dismiss(body.id); break;
              case '/api/settings': settings = parseSettings(rendererSettings(body), settings); break;
              case '/api/crop-source': reply = await cropSource(engine.get(body.id), parseCropView(body.view), media); break;
              case '/api/crop': await engine.crop(body.id, parseCropRequest(body.request, engine.get(body.id).result.kind)); break;
              case '/api/save-crop-sizes': settings = parseSettings({ savedCropSizes: parseSavedCropSizes(body.sizes) }, settings); reply = settings.savedCropSizes; break;
              case '/api/compare-sources': reply = await compareSources(engine.get(body.id), parseCompareView(body.view), media); break;
              case '/api/prefs': reply = await prefs(body); break;
              default: throw new Error('Unknown image operation.');
            }
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(reply ?? { items: engine.list(), settings, native: false, platform: 'preview', presets: { revealed: false, ...tilesFor(settings.presetZones, settings.savedPipelines, 'image') } }));
        } catch (error) { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: message(error) })); }
      });
    },
  };
}
export default defineConfig({ base: './', plugins: [react(), localImagePreview()], server: { host: '127.0.0.1', port: 5274, strictPort: true, allowedHosts: ['outposttwo.tail19dab3.ts.net'] } });
