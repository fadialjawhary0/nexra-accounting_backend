/** US dollars per million tokens: what the provider charges for what goes in and for what comes out. */
export interface ModelPrice {
  input: number;
  output: number;
}

/**
 * The provider's list prices for the models this project uses, matched on the start of the model name (a dated version of a model costs the same).
 * The cost shown to the office is an estimate from these numbers: cached input is counted at the full price. A model that is not listed is priced
 * from Settings → AI (or, when that is empty, like the main model) — the screen says so.
 */
const PRICES: Array<{ prefix: string; price: ModelPrice }> = [
  { prefix: 'gpt-6-luna', price: { input: 0.1, output: 0.5 } },
  { prefix: 'gpt-6.1-sol', price: { input: 2, output: 10 } },
  { prefix: 'gpt-6-sol', price: { input: 2, output: 10 } },
  { prefix: 'gpt-6-astra', price: { input: 10, output: 50 } },
];

/** What a model not on the list is counted at when nothing is set in Settings → AI: the price of the default main model. */
const FALLBACK: ModelPrice = { input: 2, output: 10 };

export interface PriceOverrides {
  /** US cents per million tokens; 0 = not set. */
  inputCents: number;
  outputCents: number;
}

export function priceOf(model: string, overrides: PriceOverrides): { price: ModelPrice; listed: boolean } {
  const listed = PRICES.find(entry => model.startsWith(entry.prefix));
  if (listed) return { price: listed.price, listed: true };
  if (overrides.inputCents > 0 || overrides.outputCents > 0) {
    return { price: { input: overrides.inputCents > 0 ? overrides.inputCents / 100 : FALLBACK.input, output: overrides.outputCents > 0 ? overrides.outputCents / 100 : FALLBACK.output }, listed: false };
  }
  return { price: FALLBACK, listed: false };
}

/** The estimated cost in US dollars, rounded to a millionth of a dollar (the precision of the database column). */
export function costOf(model: string, inputTokens: number, outputTokens: number, overrides: PriceOverrides): number {
  const { price } = priceOf(model, overrides);
  const dollars = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}
