/**
 * Reconcile the model's card with the deterministic converter.
 *
 * Where a source line converts exactly (a mass, a liquid volume, or a dry good
 * with a known density), the computed number wins and the item is marked as
 * checked. Where it does not - "2 cups diced tomatoes", "3 russet potatoes" -
 * the model's judgement stands.
 */
import { parseIngredientLine, convert, formatAmount } from './units.js';
import { CATEGORIES } from './prompt.js';

const CATEGORY_SET = new Set(CATEGORIES);

function computeFromSourceLines(lines, itemName, scale) {
  if (!Array.isArray(lines) || lines.length === 0) return null;

  let grams = 0;
  let milliliters = 0;
  let form = null;
  let approximate = false;

  for (const line of lines) {
    const parsed = parseIngredientLine(line);
    const result = convert(parsed.quantity, parsed.unit, parsed.rest || itemName);
    if (!result) return null; // one unconvertible line and the whole sum is guesswork

    if (form && result.form !== form) return null; // don't add grams of one thing to ml of another
    form = result.form;
    if (!result.exact) approximate = true;

    if (result.form === 'liquid') {
      if (result.milliliters == null) return null;
      milliliters += result.milliliters;
      grams += result.grams ?? 0;
    } else {
      if (result.grams == null) return null;
      grams += result.grams;
    }
  }

  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    form,
    approximate,
    grams: grams ? roundShopping(grams * factor) : null,
    milliliters: milliliters ? roundShopping(milliliters * factor) : null,
  };
}

/** Shops sell round amounts, so round the way a shopper would. */
function roundShopping(n) {
  if (n == null) return null;
  if (n >= 1000) return Math.round(n / 50) * 50;
  if (n >= 200) return Math.round(n / 25) * 25;
  if (n >= 50) return Math.round(n / 5) * 5;
  if (n >= 10) return Math.round(n);
  return Math.round(n * 2) / 2;
}

function clean(value, max) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || s.toLowerCase() === 'null') return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function reconcileCard(rawCard, { scale = 1, includeStaples = true } = {}) {
  const items = Array.isArray(rawCard?.items) ? rawCard.items : [];

  const reconciled = items.map((item) => {
    const name = clean(item.name, 28) || 'Ingredient';
    const sourceLines = (Array.isArray(item.sourceLines) ? item.sourceLines : [])
      .map((l) => clean(l, 160))
      .filter(Boolean);

    const modelCount = num(item.count);
    const computed = computeFromSourceLines(sourceLines, name, scale);

    // The model scales to the target servings itself, so its numbers are used
    // as given; only the arithmetic we redo here gets the scale factor.
    const grams = computed ? computed.grams : num(item.grams);
    const milliliters = computed ? computed.milliliters : num(item.milliliters);
    const form = computed?.form ?? (milliliters && !grams ? 'liquid' : 'dry');

    // You buy liquids by volume and everything else by weight - never show both.
    const displayGrams = form === 'liquid' && milliliters ? null : grams;
    const displayMl = displayGrams && milliliters ? null : milliliters;

    const amount = formatAmount({
      count: modelCount,
      countUnit: clean(item.countUnit, 20),
      grams: displayGrams,
      milliliters: displayMl,
    });

    return {
      name,
      buy: amount || clean(item.buy, 26) || '—',
      modelBuy: clean(item.buy, 26),
      category: CATEGORY_SET.has(item.category) ? item.category : 'other',
      staple: Boolean(item.staple),
      sourceLines,
      count: modelCount,
      countUnit: clean(item.countUnit, 20),
      grams: displayGrams,
      milliliters: displayMl,
      checked: Boolean(computed),          // arithmetic verified locally
      approximate: Boolean(computed?.approximate),
      variety: clean(item.variety, 28),
      varietySource: ['recipe', 'inferred', 'none'].includes(item.varietySource)
        ? item.varietySource
        : 'none',
      varietyNote: clean(item.varietyNote, 60),
      alternatives: (Array.isArray(item.alternatives) ? item.alternatives : [])
        .slice(0, 3)
        .map((alt) => ({ name: clean(alt?.name, 26), note: clean(alt?.note, 40) }))
        .filter((alt) => alt.name),
      assumed: Boolean(item.assumed),
      note: clean(item.note, 60),
    };
  });

  const kept = includeStaples ? reconciled : reconciled.filter((item) => !item.staple);

  return {
    title: clean(rawCard?.title, 60) || 'Shopping list',
    servings: clean(rawCard?.servings, 30) || '',
    notes: (Array.isArray(rawCard?.notes) ? rawCard.notes : []).map((n) => clean(n, 140)).filter(Boolean),
    items: kept.filter((item) => !item.staple),
    staples: kept.filter((item) => item.staple),
  };
}

export const __internal = { computeFromSourceLines, roundShopping };
