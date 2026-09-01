/**
 * Deterministic unit handling.
 *
 * The model is good at judgement calls ("2 cups diced tomatoes" -> "2 medium
 * tomatoes") but arithmetic should not be left to it. Anything that can be
 * converted exactly is converted here, and the result overrides whatever the
 * model returned so the numbers on the card are always reproducible.
 */

const VULGAR = {
  '¼': 0.25, '½': 0.5, '¾': 0.75,
  '⅓': 1 / 3, '⅔': 2 / 3,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6,
};

// Canonical unit -> aliases as they appear in recipes.
const UNIT_ALIASES = {
  cup: ['cup', 'cups', 'c'],
  tablespoon: ['tablespoon', 'tablespoons', 'tbsp', 'tbsps', 'tbs', 'tb', 'T'],
  teaspoon: ['teaspoon', 'teaspoons', 'tsp', 'tsps', 't'],
  fluid_ounce: ['fluid ounce', 'fluid ounces', 'fl oz', 'fl. oz.', 'floz'],
  pint: ['pint', 'pints', 'pt'],
  quart: ['quart', 'quarts', 'qt'],
  gallon: ['gallon', 'gallons', 'gal'],
  milliliter: ['milliliter', 'milliliters', 'millilitre', 'millilitres', 'ml'],
  liter: ['liter', 'liters', 'litre', 'litres', 'l'],
  ounce: ['ounce', 'ounces', 'oz'],
  pound: ['pound', 'pounds', 'lb', 'lbs', '#'],
  gram: ['gram', 'grams', 'g', 'gr'],
  kilogram: ['kilogram', 'kilograms', 'kg'],
  stick: ['stick', 'sticks'],
  pinch: ['pinch', 'pinches'],
  dash: ['dash', 'dashes'],
  clove: ['clove', 'cloves'],
  can: ['can', 'cans', 'tin', 'tins'],
  package: ['package', 'packages', 'pkg', 'packet', 'packets'],
  bunch: ['bunch', 'bunches'],
  head: ['head', 'heads'],
  sprig: ['sprig', 'sprigs'],
  slice: ['slice', 'slices'],
  piece: ['piece', 'pieces'],
  large: ['large'],
  medium: ['medium'],
  small: ['small'],
};

const ALIAS_TO_UNIT = new Map();
for (const [unit, aliases] of Object.entries(UNIT_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_UNIT.set(alias.toLowerCase(), unit);
}

// Volume units -> millilitres (US customary).
const ML = {
  cup: 236.588,
  tablespoon: 14.7868,
  teaspoon: 4.92892,
  fluid_ounce: 29.5735,
  pint: 473.176,
  quart: 946.353,
  gallon: 3785.41,
  milliliter: 1,
  liter: 1000,
};

// Mass units -> grams.
const G = {
  ounce: 28.3495,
  pound: 453.592,
  gram: 1,
  kilogram: 1000,
  stick: 113.4, // a US stick of butter
};

/**
 * Grams per US cup for ingredients where a volume measure is really a weight.
 * Keys are matched as substrings of the lower-cased ingredient name, longest
 * key first, so "brown sugar" beats "sugar".
 */
const DENSITY_G_PER_CUP = {
  // name: [grams per US cup, 'dry' | 'liquid']
  'all-purpose flour': [125, 'dry'], 'all purpose flour': [125, 'dry'], 'plain flour': [125, 'dry'],
  'bread flour': [127, 'dry'], 'cake flour': [114, 'dry'], 'whole wheat flour': [120, 'dry'],
  'almond flour': [96, 'dry'], 'cornstarch': [128, 'dry'], 'cornflour': [128, 'dry'],
  'cocoa powder': [85, 'dry'], 'flour': [125, 'dry'],
  'granulated sugar': [200, 'dry'], 'caster sugar': [200, 'dry'], 'brown sugar': [213, 'dry'],
  'powdered sugar': [120, 'dry'], 'icing sugar': [120, 'dry'], 'confectioners sugar': [120, 'dry'],
  'sugar': [200, 'dry'],
  'honey': [340, 'liquid'], 'maple syrup': [322, 'liquid'], 'molasses': [337, 'liquid'],
  'corn syrup': [328, 'liquid'],
  'butter': [227, 'dry'], 'margarine': [227, 'dry'], 'shortening': [205, 'dry'],
  'olive oil': [216, 'liquid'], 'vegetable oil': [218, 'liquid'], 'canola oil': [218, 'liquid'],
  'sesame oil': [218, 'liquid'], 'oil': [218, 'liquid'],
  'milk': [244, 'liquid'], 'buttermilk': [245, 'liquid'], 'heavy cream': [238, 'liquid'],
  'double cream': [238, 'liquid'], 'coconut milk': [240, 'liquid'],
  'sour cream': [230, 'dry'], 'yogurt': [245, 'dry'], 'yoghurt': [245, 'dry'],
  'water': [237, 'liquid'],
  'cream cheese': [232, 'dry'], 'ricotta': [246, 'dry'], 'mayonnaise': [220, 'dry'],
  'grated parmesan': [90, 'dry'], 'parmesan': [90, 'dry'], 'shredded cheese': [113, 'dry'],
  'grated cheese': [113, 'dry'], 'cheddar': [113, 'dry'],
  'rolled oats': [90, 'dry'], 'oats': [90, 'dry'], 'breadcrumbs': [108, 'dry'], 'panko': [60, 'dry'],
  'rice': [185, 'dry'], 'white rice': [185, 'dry'], 'basmati rice': [185, 'dry'],
  'arborio rice': [200, 'dry'], 'brown rice': [190, 'dry'], 'quinoa': [170, 'dry'],
  'couscous': [173, 'dry'], 'lentils': [192, 'dry'], 'dried beans': [190, 'dry'],
  'chocolate chips': [170, 'dry'], 'raisins': [145, 'dry'], 'walnuts': [117, 'dry'],
  'pecans': [109, 'dry'], 'almonds': [143, 'dry'], 'peanuts': [146, 'dry'], 'cashews': [137, 'dry'],
  'peanut butter': [258, 'dry'], 'tahini': [240, 'dry'],
  'soy sauce': [255, 'liquid'], 'fish sauce': [255, 'liquid'], 'vinegar': [239, 'liquid'],
  'tomato sauce': [245, 'liquid'], 'tomato puree': [250, 'liquid'], 'passata': [250, 'liquid'],
  'stock': [240, 'liquid'], 'broth': [240, 'liquid'], 'wine': [237, 'liquid'],
  'salt': [273, 'dry'], 'kosher salt': [145, 'dry'], 'sea salt': [260, 'dry'],
};

const DENSITY_KEYS = Object.keys(DENSITY_G_PER_CUP).sort((a, b) => b.length - a.length);

/** Parse "1 1/2", "1½", "½", "2.5", "2-3" (takes the upper bound) into a number. */
export function parseQuantity(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // Ranges: "2-3 cups" -> use the larger side, you can always not use it all.
  const range = s.match(/^([\d.¼-⅞/\s]+?)\s*(?:-|–|to)\s*([\d.¼-⅞/\s]+)$/);
  if (range) s = range[2].trim();

  let total = 0;
  let matched = false;
  for (const token of s.split(/\s+/)) {
    if (!token) continue;
    if (VULGAR[token] != null) { total += VULGAR[token]; matched = true; continue; }
    // "1½"
    const mixed = token.match(/^(\d+)([¼-⅞])$/);
    if (mixed) { total += Number(mixed[1]) + VULGAR[mixed[2]]; matched = true; continue; }
    const frac = token.match(/^(\d+)\/(\d+)$/);
    if (frac) { total += Number(frac[1]) / Number(frac[2]); matched = true; continue; }
    const num = token.match(/^\d+(?:\.\d+)?$/);
    if (num) { total += Number(token); matched = true; continue; }
    return matched ? total : null; // stop at the first non-numeric token
  }
  return matched ? total : null;
}

/** Map a written unit onto its canonical name, or null if unrecognised. */
export function canonicalUnit(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase().replace(/\.$/, '');
  return ALIAS_TO_UNIT.get(s) ?? ALIAS_TO_UNIT.get(s.replace(/s$/, '')) ?? null;
}

const UNIT_PATTERN = [...ALIAS_TO_UNIT.keys()]
  .sort((a, b) => b.length - a.length)
  .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/** Split "1 1/2 cups (200 g) diced tomatoes" into quantity, unit and the rest. */
export function parseIngredientLine(line) {
  const text = String(line || '').trim();
  const m = text.match(
    new RegExp(`^([0-9¼-⅞][0-9¼-⅞.,/\\s-]*)\\s*(${UNIT_PATTERN})?\\b\\.?\\s*(.*)$`, 'i'),
  );
  if (!m) return { quantity: null, unit: null, rest: text, raw: text };
  return {
    quantity: parseQuantity(m[1]),
    unit: canonicalUnit(m[2]),
    rest: (m[3] || '').trim(),
    raw: text,
  };
}

function densityFor(name) {
  const n = String(name || '').toLowerCase();
  for (const key of DENSITY_KEYS) {
    if (n.includes(key)) {
      const [grams, form] = DENSITY_G_PER_CUP[key];
      return { gramsPerCup: grams, form, key };
    }
  }
  return null;
}

/**
 * Convert an amount into what a shopper actually weighs out or measures.
 *
 * Returns null when the conversion needs judgement - "2 cups diced tomatoes"
 * has no honest arithmetic answer, so it is handed to the model instead.
 */
export function convert(quantity, unit, ingredientName) {
  if (quantity == null || !unit) return null;
  const u = canonicalUnit(unit) || unit;

  if (G[u] != null) {
    return { grams: round(quantity * G[u]), form: 'dry', basis: 'mass', exact: true };
  }

  if (ML[u] != null) {
    const ml = round(quantity * ML[u]);
    const density = densityFor(ingredientName);

    // A bare volume of a liquid is already a shopping quantity.
    if (!density) {
      if (isPlainLiquid(ingredientName)) {
        return { milliliters: ml, form: 'liquid', basis: 'volume', exact: true };
      }
      return null; // e.g. "2 cups diced tomatoes" - ask the model.
    }

    const grams = round((quantity * ML[u] / ML.cup) * density.gramsPerCup);
    return density.form === 'liquid'
      ? { milliliters: ml, grams, form: 'liquid', basis: 'volume', densityKey: density.key, exact: true }
      : { grams, milliliters: ml, form: 'dry', basis: 'density', densityKey: density.key, exact: false };
  }

  return null;
}

const PLAIN_LIQUID = /\b(juice|water|milk|cream|stock|broth|wine|beer|vinegar|oil|syrup|sauce|extract|essence|liqueur|rum|brandy|vodka|whisk(?:e)?y)\b/i;
function isPlainLiquid(name) {
  return PLAIN_LIQUID.test(String(name || ''));
}

function round(n) {
  if (n == null) return null;
  if (n >= 100) return Math.round(n / 5) * 5;   // 437.2 g -> 435 g
  if (n >= 10) return Math.round(n);
  return Math.round(n * 10) / 10;
}

/** Human-readable amount for the card: "450 g (1 lb)" / "300 ml". */
export function formatAmount({ grams, milliliters, count, countUnit }) {
  const parts = [];
  if (count != null) {
    parts.push(`${trimNum(count)}${countUnit ? ` ${countUnit}` : ''}`);
  }
  if (grams != null) {
    parts.push(grams >= 1000 ? `${trimNum(grams / 1000)} kg` : `${trimNum(grams)} g`);
  } else if (milliliters != null) {
    parts.push(milliliters >= 1000 ? `${trimNum(milliliters / 1000)} L` : `${trimNum(milliliters)} ml`);
  }
  return parts.join(' · ');
}

function trimNum(n) {
  const r = Math.round(n * 100) / 100;
  return String(r);
}

/** Scale an amount by a serving multiplier, keeping counts whole-ish. */
export function scaleAmount(value, factor) {
  if (value == null || !Number.isFinite(factor)) return value;
  return round(value * factor);
}

export const __test = { DENSITY_G_PER_CUP, ML, G };
