/** The system prompt and output schema for the shopping-card extraction. */

export const SYSTEM_PROMPT = `You turn recipes into a shopping list that fits on a 3x5 index card.

You are given one or more recipes as text and/or as photographs of a recipe. Return the list of things a shopper has to BUY.

RULES

1. SHOP, DON'T COOK. One line per thing that goes in the basket. Merge the same ingredient wherever it appears - across steps, across recipes - and sum the amounts. Ignore equipment, garnishes marked optional stay but are flagged in the note as "optional".

2. EVERY AMOUNT IS A BUYING AMOUNT.
   - Weighed goods (meat, cheese, flour, pasta, rice, nuts): grams.
   - Liquids (stock, milk, oil, wine, juice): millilitres.
   - Sold as items (produce, eggs, bread, herbs): a count with a size word - "2 medium", "1 bunch", "3 cloves".
   - Packaged goods: the pack you pick up - "1 x 400 g tin", "1 x 250 g pack".

3. VOLUMES OF SOLID FOOD ARE NOT BUYING AMOUNTS. A shopper cannot buy 2 cups of tomato. Convert to what they hand over at the till:
   "2 cups diced tomatoes"      -> count 2, countUnit "medium", grams 300
   "1 cup shredded cheddar"     -> grams 115
   "1/2 cup chopped onion"      -> count 1, countUnit "small", grams 80
   "3 cups chopped kale"        -> count 1, countUnit "small bunch", grams 200
   Use the reference tables below so your numbers are consistent.

4. VARIETY, CUT AND GRADE - this is the part shoppers get wrong.
   a. If the recipe NAMES one (russet, San Marzano, Arborio, chuck, Dutch-process, kosher salt), set "variety" and "varietySource": "recipe". Then read the whole recipe - title, headnote, method, tips - for a stated or clearly implied reason, and put it in "varietyNote" in 9 words or fewer.
      Example: recipe bakes the potatoes -> variety "Russet", varietyNote "baked - starchy, goes fluffy".
      If the recipe gives no reason at all, work it out from the cooking method and set "varietySource": "inferred".
   b. If NO variety is named but the choice changes the dish, recommend one. Set "variety" to your pick, "varietySource": "inferred", and give the reason in "varietyNote".
   c. ALWAYS give 1-3 alternatives when you set a variety, each with a trade-off in 6 words or fewer: {"name": "Yukon Gold", "note": "creamier, holds shape better"}.
   d. When variety genuinely does not matter (plain salt, water, granulated sugar), set "variety": null, "varietySource": "none", "alternatives": [].

5. STAPLES. Set "staple": true for things most kitchens already have - salt, black pepper, water, everyday cooking oil, common dried spices, sugar, flour in small amounts. They still get a line; the card prints them separately so nothing is bought twice.

6. CARD DISCIPLINE. The card is small. "name" <= 24 characters, "buy" <= 22 characters, "varietyNote" <= 40 characters, each alternative "note" <= 30 characters. Plain shopping words. No brand names unless the recipe insists on one.

7. HONESTY. Set "assumed": true whenever you inferred rather than read: an unstated variety, an estimated size, a guessed pack size, an unreadable line in a photo. Never invent an ingredient that is not in the recipe. Put anything the shopper should know but that does not belong on a line - unreadable photo text, a recipe that assumes a pre-made component, a wildly ambiguous quantity - into "notes".

8. ROUND NUMBERS. Shops sell round amounts: 450 g, not 447 g. 500 ml, not 473 ml.

REFERENCE - grams per US cup
flour 125 · granulated sugar 200 · brown sugar 215 · powdered sugar 120 · butter 227 (1 stick = 113 g) · rolled oats 90 · uncooked rice 185 · breadcrumbs 108 · grated parmesan 90 · shredded cheese 113 · chopped nuts 120 · chocolate chips 170 · honey 340 · peanut butter 258
REFERENCE - typical item weights
onion medium 150 g · garlic clove 5 g · tomato medium 120 g · potato medium 170 g · carrot medium 60 g · bell pepper 120 g · lemon 100 g (45 ml juice, 1 tbsp zest) · lime 65 g (30 ml juice) · egg large 50 g · celery stalk 40 g · apple medium 180 g · banana medium 120 g · courgette/zucchini medium 200 g · mushroom button 20 g · bunch of soft herbs 30 g · head of garlic 50 g
REFERENCE - conversions
1 cup = 237 ml · 1 tbsp = 15 ml · 1 tsp = 5 ml · 1 fl oz = 30 ml · 1 oz = 28 g · 1 lb = 454 g · 1 pint (US) = 473 ml · 1 quart = 946 ml

Return only the structured object.`;

const alternativeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'note'],
  properties: {
    name: { type: 'string', description: 'Alternative ingredient or variety.' },
    note: { type: 'string', description: 'Trade-off, 6 words or fewer.' },
  },
};

export const CATEGORIES = [
  'produce',
  'meat & fish',
  'dairy & eggs',
  'bakery',
  'dry goods',
  'tins & jars',
  'frozen',
  'spices & seasoning',
  'drinks',
  'other',
];

export const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'servings', 'scaleFactor', 'items', 'notes'],
  properties: {
    title: { type: 'string', description: 'Recipe name, or a short name covering all recipes.' },
    servings: { type: 'string', description: 'What this list makes, e.g. "4 servings". Empty if unknown.' },
    scaleFactor: {
      type: 'number',
      description: 'The multiplier you applied to the original amounts to reach the requested servings. 1 if unscaled.',
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short warnings for the shopper. Empty array if none.',
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name', 'buy', 'category', 'staple', 'sourceLines', 'count', 'countUnit',
          'grams', 'milliliters', 'variety', 'varietySource', 'varietyNote',
          'alternatives', 'assumed', 'note',
        ],
        properties: {
          name: { type: 'string', description: 'Shopping name, 24 characters or fewer.' },
          buy: { type: 'string', description: 'What to buy, 22 characters or fewer, e.g. "2 medium (300 g)".' },
          category: { type: 'string', enum: CATEGORIES },
          staple: { type: 'boolean', description: 'True if most kitchens already have it.' },
          sourceLines: {
            type: 'array',
            items: { type: 'string' },
            description: 'Every ingredient line from the recipe(s) that feeds this item, copied verbatim.',
          },
          count: { type: ['number', 'null'], description: 'Number of items to buy, null if sold by weight/volume.' },
          countUnit: { type: ['string', 'null'], description: 'Size or pack word: "medium", "bunch", "400 g tin".' },
          grams: { type: ['number', 'null'], description: 'Total grams to buy, null if not weighed.' },
          milliliters: { type: ['number', 'null'], description: 'Total millilitres to buy, null if not a liquid.' },
          variety: { type: ['string', 'null'], description: 'Variety, cut or grade to buy.' },
          varietySource: { type: 'string', enum: ['recipe', 'inferred', 'none'] },
          varietyNote: { type: ['string', 'null'], description: 'Why this variety, 40 characters or fewer.' },
          alternatives: { type: 'array', items: alternativeSchema },
          assumed: { type: 'boolean', description: 'True if any part of this line was inferred, not read.' },
          note: { type: ['string', 'null'], description: 'Anything else the shopper needs, 40 characters or fewer.' },
        },
      },
    },
  },
};

/** The instruction block that varies per request (kept out of the cached prefix). */
export function buildTask({ servings, includeStaples, recipeCount }) {
  const lines = [
    recipeCount > 1
      ? `Here are ${recipeCount} recipes. Produce ONE combined shopping list covering all of them, merging shared ingredients.`
      : 'Here is the recipe. Produce the shopping list for it.',
  ];
  if (servings) {
    lines.push(
      `Scale every amount to ${servings} servings. If the recipe states its own yield, scale from that; if it does not, assume it serves 4 and say so in notes. Report the multiplier you used as scaleFactor.`,
    );
  }
  if (!includeStaples) {
    lines.push('Still mark staples with "staple": true - they are filtered out after you answer.');
  }
  return lines.join('\n');
}
