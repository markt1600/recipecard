/** Calls Claude and returns the structured shopping card. */
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, CARD_SCHEMA, buildTask } from './prompt.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class ApiKeyError extends Error {}

function makeClient(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new ApiKeyError(
      'No Anthropic API key. Set ANTHROPIC_API_KEY in the environment, or paste a key into the key box.',
    );
  }
  return new Anthropic({ apiKey: key });
}

function userContent({ recipes, images, servings, includeStaples }) {
  const content = [];

  for (const image of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    });
  }

  const blocks = recipes.map((recipe, i) => {
    const label = recipes.length > 1 ? `--- RECIPE ${i + 1} ---\n` : '';
    return `${label}${recipe.text}`;
  });

  if (images.length) {
    blocks.push(
      images.length > 1
        ? `${images.length} photographs of recipes are attached above. Read every ingredient and every instruction from them.`
        : 'A photograph of a recipe is attached above. Read every ingredient and every instruction from it.',
    );
  }

  content.push({
    type: 'text',
    text: `${buildTask({
      servings,
      includeStaples,
      recipeCount: recipes.length + images.length,
    })}\n\n${blocks.join('\n\n')}`,
  });

  return content;
}

/** Pull the JSON object out of the response, whichever block it landed in. */
function parseResponse(message) {
  if (message.stop_reason === 'refusal') {
    throw new Error(
      `Claude declined this request (${message.stop_details?.category || 'unspecified'}). Try a different source.`,
    );
  }
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (!text) throw new Error('Claude returned an empty response.');
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/); // in case the model wrapped it in prose
    if (match) return JSON.parse(match[0]);
    throw new Error(`Could not read Claude's response as JSON: ${text.slice(0, 200)}`);
  }
}

function isUnsupportedFeature(error) {
  const message = String(error?.message || '');
  return (
    error?.status === 400 &&
    /beta|fallback|output_config|json_schema|format|unsupported/i.test(message)
  );
}

/**
 * Ask Claude for the card.
 *
 * The first attempt uses structured outputs plus server-side refusal fallbacks;
 * if this account has neither beta enabled, it retries with a plain request and
 * a "reply with JSON" instruction so the app still works.
 */
export async function buildCard({ recipes, images, servings, includeStaples, apiKey }) {
  const client = makeClient(apiKey);
  const messages = [{ role: 'user', content: userContent({ recipes, images, servings, includeStaples }) }];

  const base = {
    model: MODEL,
    max_tokens: 32000,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages,
  };

  try {
    const stream = client.beta.messages.stream({
      ...base,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: CARD_SCHEMA } },
    });
    return { card: parseResponse(await stream.finalMessage()), model: MODEL, degraded: false };
  } catch (error) {
    if (!isUnsupportedFeature(error)) throw error;

    const stream = client.messages.stream({
      ...base,
      system: [
        {
          type: 'text',
          text: `${SYSTEM_PROMPT}\n\nRespond with a single JSON object and nothing else, matching this JSON schema:\n${JSON.stringify(
            CARD_SCHEMA,
          )}`,
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    return { card: parseResponse(await stream.finalMessage()), model: MODEL, degraded: true };
  }
}
