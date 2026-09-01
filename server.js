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

import { ApiKeyError } from './src/claude.js';
import { validateBuildRequest, respondWithBuild } from './src/build.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 30 * 1024 * 1024; // room for a few recipe photos

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

async function handleBuild(req, res) {
  const body = await readBody(req);
  const input = validateBuildRequest(body); // bad input still gets a proper 4xx
  await respondWithBuild(res, input);       // 200 + heartbeats from here on
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
    if (res.headersSent) {
      if (!res.writableEnded) res.end(JSON.stringify({ error: error.message || 'Something went wrong.' }));
      return;
    }
    return json(res, status, { error: error.message || 'Something went wrong.' });
  }
});

// Long model calls: never let Node cut the response off itself.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.listen(PORT, () => {
  console.log(`recipecard listening on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set - /api/build will fail until it is.');
  }
});
