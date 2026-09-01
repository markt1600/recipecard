/**
 * recipecard - a recipe URL or photo in, a printable index-card shopping list out.
 *
 * Everything that needs a key or the open internet happens here; the browser
 * only ever talks to this server.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFromUrl } from './src/extract.js';
import { buildCard, ApiKeyError } from './src/claude.js';
import { reconcileCard } from './src/reconcile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 30 * 1024 * 1024; // room for a few recipe photos
const MAX_IMAGES = 4;
const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw Object.assign(new Error('Upload too large - keep photos under 8 MB each.'), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Malformed request body.'), { status: 400 });
  }
}

function validate(body) {
  const urls = (Array.isArray(body.urls) ? body.urls : [])
    .map((u) => String(u || '').trim())
    .filter(Boolean)
    .slice(0, 5);

  const pastedText = String(body.text || '').trim().slice(0, 40000);

  const images = (Array.isArray(body.images) ? body.images : [])
    .slice(0, MAX_IMAGES)
    .map((image) => {
      const mediaType = String(image?.mediaType || '').toLowerCase();
      if (!ALLOWED_MEDIA.has(mediaType)) {
        throw Object.assign(new Error(`Unsupported image type: ${mediaType || 'unknown'}`), { status: 400 });
      }
      const data = String(image?.data || '').replace(/^data:[^,]+,/, '');
      if (!data) throw Object.assign(new Error('An image was empty.'), { status: 400 });
      return { mediaType, data };
    });

  if (!urls.length && !pastedText && !images.length) {
    throw Object.assign(new Error('Give me a recipe URL, a photo, or some pasted text.'), { status: 400 });
  }

  const servings = body.servings ? String(body.servings).slice(0, 12) : '';

  return {
    urls,
    pastedText,
    images,
    servings,
    includeStaples: body.includeStaples !== false,
    apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : null,
  };
}

async function handleBuild(req, res) {
  const body = await readBody(req);
  const input = validate(body);

  const recipes = [];
  const warnings = [];

  for (const url of input.urls) {
    try {
      const recipe = await extractFromUrl(url);
      if (!recipe.structured) {
        warnings.push(`${new URL(recipe.sourceUrl).hostname} has no structured recipe data - read from the page text, so check the list.`);
      }
      recipes.push(recipe);
    } catch (error) {
      warnings.push(`Could not read ${url}: ${error.message}`);
    }
  }

  if (input.pastedText) {
    recipes.push({ title: 'Pasted recipe', text: input.pastedText, structured: false, sourceUrl: null });
  }

  if (!recipes.length && !input.images.length) {
    return json(res, 502, { error: warnings.join(' ') || 'Nothing readable at that address.' });
  }

  const { card: raw, degraded } = await buildCard({
    recipes,
    images: input.images,
    servings: input.servings,
    includeStaples: input.includeStaples,
    apiKey: input.apiKey,
  });

  const scale = Number(raw.scaleFactor);
  const card = reconcileCard(raw, {
    scale: Number.isFinite(scale) && scale > 0 && scale <= 50 ? scale : 1,
    includeStaples: input.includeStaples,
  });
  card.sources = recipes.map((r) => r.sourceUrl).filter(Boolean);
  card.warnings = warnings;
  if (degraded) {
    card.warnings.push('Structured output was unavailable on this key, so the list was parsed from free-form JSON.');
  }

  return json(res, 200, { card });
}

async function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, relative);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return json(res, 403, { error: 'Forbidden' });
  }
  try {
    const file = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/config') {
      return json(res, 200, { hasServerKey: Boolean(process.env.ANTHROPIC_API_KEY) });
    }
    if (req.method === 'POST' && req.url === '/api/build') {
      return await handleBuild(req, res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return await serveStatic(req, res);
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    const status = error instanceof ApiKeyError ? 401 : error.status || 500;
    if (status >= 500) console.error(error);
    return json(res, status, { error: error.message || 'Something went wrong.' });
  }
});

server.listen(PORT, () => {
  console.log(`recipecard listening on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY set - the page will ask for a key instead.');
  }
});
