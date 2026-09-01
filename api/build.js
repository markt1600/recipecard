/**
 * Vercel serverless entry point for POST /api/build.
 *
 * On Vercel the static site in public/ is served directly and server.js never
 * runs, so this function carries the API instead. It sticks to plain Node
 * response APIs so the same code path works under `vercel dev` and in tests.
 * Give it time in vercel.json (maxDuration) - a long recipe can take minutes.
 */
import { validateBuildRequest, respondWithBuild } from '../src/build.js';

const MAX_BODY = 30 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message });
  }

  let input;
  try {
    input = validateBuildRequest(body);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message });
  }

  await respondWithBuild(res, input);
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req) {
  // Vercel's Node helper has usually parsed JSON bodies into req.body already
  // (and consumed the stream), so prefer that when it is there.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    try {
      return JSON.parse(String(req.body));
    } catch {
      throw Object.assign(new Error('Malformed request body.'), { status: 400 });
    }
  }

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
