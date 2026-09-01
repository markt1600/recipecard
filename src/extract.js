/**
 * Fetch a recipe page and reduce it to the text worth sending to the model.
 *
 * Most recipe sites publish schema.org/Recipe as JSON-LD, which gives us clean
 * ingredients and instructions. When that is missing we fall back to stripping
 * the HTML down to readable text.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 3_000_000;
const MAX_TEXT = 20_000;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

// Different sites block different clients: some 403 anything that is not a
// browser, others (behind TLS-fingerprinting CDNs) 403 a browser UA coming
// from a plain HTTP client. Try the honest UA first, the browser one second.
const USER_AGENTS = [
  'Mozilla/5.0 (compatible; RecipeCard/1.0)',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
];

/** Reject anything that resolves to a private or loopback address. */
async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported.');
  }
  const addresses = await dns.lookup(url.hostname, { all: true }).catch(() => {
    throw new Error(`Could not resolve ${url.hostname}`);
  });
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`Refusing to fetch a private address (${url.hostname}).`);
    }
  }
  return url;
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const ip = address.toLowerCase();
  return (
    ip === '::' || ip === '::1' ||
    ip.startsWith('fc') || ip.startsWith('fd') ||
    ip.startsWith('fe80') ||
    ip.startsWith('::ffff:')
  );
}

async function fetchWithGuard(rawUrl) {
  let lastError;
  for (const userAgent of USER_AGENTS) {
    try {
      return await fetchOnce(rawUrl, userAgent);
    } catch (error) {
      lastError = error;
      if (!/HTTP 40[36]/.test(error.message)) throw error; // only retry blocks
    }
  }
  throw lastError;
}

async function fetchOnce(rawUrl, userAgent) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current);
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect with no location from ${url.host}`);
      current = new URL(location, url).toString();
      continue; // re-check the new host before following it
    }
    if (!response.ok) {
      throw new Error(`${url.host} returned HTTP ${response.status}`);
    }
    return { response, finalUrl: url.toString() };
  }
  throw new Error('Too many redirects.');
}

async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Walk any JSON-LD shape (arrays, @graph, nested) looking for a Recipe. */
function findRecipeNode(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findRecipeNode(child, seen);
      if (found) return found;
    }
    return null;
  }
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'recipe')) return node;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement']) {
    const found = findRecipeNode(node[key], seen);
    if (found) return found;
  }
  return null;
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (typeof value === 'object') return textOf(value.text || value.name || value.itemListElement);
  return String(value);
}

function stripTags(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(?:nav|footer|header|aside|form|svg)\b[^>]*>[\s\S]*?<\/(?:nav|footer|header|aside|form|svg)>/gi, ' ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|h\d|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&frac12;/g, '1/2')
    .replace(/&frac14;/g, '1/4')
    .replace(/&frac34;/g, '3/4')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function fromJsonLd(html) {
  const blocks = [...html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];
  for (const [, body] of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(body.trim().replace(/^﻿/, ''));
    } catch {
      continue;
    }
    const recipe = findRecipeNode(parsed);
    if (!recipe) continue;

    const ingredients = []
      .concat(recipe.recipeIngredient || recipe.ingredients || [])
      .map(textOf)
      .filter(Boolean);
    if (!ingredients.length) continue;

    return {
      title: textOf(recipe.name).trim() || 'Recipe',
      servings: textOf(recipe.recipeYield).trim(),
      description: textOf(recipe.description).trim(),
      ingredients,
      instructions: textOf(recipe.recipeInstructions).trim(),
      notes: [textOf(recipe.recipeCuisine), textOf(recipe.recipeCategory)]
        .filter(Boolean)
        .join(' · '),
      structured: true,
    };
  }
  return null;
}

/** Turn the structured or scraped page into one prompt-ready block of text. */
export function recipeToText(recipe, sourceUrl) {
  const lines = [];
  if (sourceUrl) lines.push(`SOURCE: ${sourceUrl}`);
  lines.push(`TITLE: ${recipe.title || 'Untitled recipe'}`);
  if (recipe.servings) lines.push(`YIELD: ${recipe.servings}`);
  if (recipe.notes) lines.push(`TAGS: ${recipe.notes}`);
  if (recipe.description) lines.push(`\nDESCRIPTION:\n${recipe.description}`);
  if (recipe.ingredients?.length) {
    lines.push(`\nINGREDIENTS:\n${recipe.ingredients.map((i) => `- ${i}`).join('\n')}`);
  }
  if (recipe.instructions) lines.push(`\nMETHOD:\n${recipe.instructions}`);
  if (recipe.pageText) lines.push(`\nPAGE TEXT:\n${recipe.pageText}`);
  return lines.join('\n').slice(0, MAX_TEXT);
}

export async function extractFromUrl(rawUrl) {
  const { response, finalUrl } = await fetchWithGuard(rawUrl);
  const html = await readCapped(response);

  const structured = fromJsonLd(html);
  if (structured) {
    return { ...structured, sourceUrl: finalUrl, text: recipeToText(structured, finalUrl) };
  }

  const title =
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim() ||
    'Recipe';
  const pageText = stripTags(html).slice(0, MAX_TEXT);
  const recipe = { title: stripTags(title), pageText, structured: false };
  return { ...recipe, sourceUrl: finalUrl, text: recipeToText(recipe, finalUrl) };
}

export const __internal = { stripTags, fromJsonLd, isPrivateAddress, findRecipeNode };
