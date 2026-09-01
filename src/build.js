/**
 * The build pipeline, shared by the standalone server (server.js) and the
 * Vercel serverless function (api/build.js): validate the request, read the
 * recipes, ask Claude, reconcile the arithmetic.
 */
import { extractFromUrl } from './extract.js';
import { buildCard } from './claude.js';
import { reconcileCard } from './reconcile.js';

const MAX_IMAGES = 4;
const ALLOWED_MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Throws {status, message} on bad input. */
export function validateBuildRequest(body) {
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
  };
}

/** Runs the whole pipeline. Returns {card} on success, {error} on failure. */
export async function runBuild(input) {
  const recipes = [];
  const warnings = [];

  for (const url of input.urls) {
    try {
      const recipe = await extractFromUrl(url);
      if (recipe.viaArchive) {
        warnings.push(`${new URL(url).hostname} blocks direct reading, so an archived copy from web.archive.org was used - it may be out of date.`);
      }
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
    return { error: warnings.join(' ') || 'Nothing readable at that address.' };
  }

  const { card: raw, degraded } = await buildCard({
    recipes,
    images: input.images,
    servings: input.servings,
    includeStaples: input.includeStaples,
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

  return { card };
}

/**
 * Serve one build request on a Node response: send 200 straight away, drip
 * whitespace heartbeats (legal JSON padding) so proxies and serverless
 * platforms don't cut the long model call off, then end with the JSON body.
 * Call only after validation - errors from here on ride inside the body.
 */
export async function respondWithBuild(res, input) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(' ');
  }, 10000);

  try {
    res.end(JSON.stringify(await runBuild(input)));
  } catch (error) {
    console.error(error);
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: error.message || 'Something went wrong.' }));
    }
  } finally {
    clearInterval(heartbeat);
  }
}
