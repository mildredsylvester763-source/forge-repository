/**
 * Hook 8 - the country table, pure engine. One row per country: currency, region band
 * (ALG-43: A 1.00, B 0.70, C 0.45), the tax rule and the date it was checked, the payment
 * methods, whether the country is enabled, and the minimum payout. The rows come from
 * configuration (FORGE_COUNTRY_CATALOG) and stay empty until the owner supplies country
 * data. Pure and deterministic; the service owns the clock and the config.
 */

export const REGION_BANDS = ['A', 'B', 'C'] as const;
export type RegionBand = (typeof REGION_BANDS)[number];

export const REGION_BAND_MULTIPLIERS: Readonly<Record<RegionBand, number>> = { A: 1, B: 0.7, C: 0.45 };

export interface CountryRow {
  readonly code: string;
  readonly currency: string;
  readonly regionBand: RegionBand;
  readonly taxRule: string;
  readonly taxCheckedAt: number;
  readonly paymentMethods: readonly string[];
  readonly enabled: boolean;
  readonly minimumPayoutMinor: number;
}

export type CountryResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const isFiniteInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && Number.isFinite(n);

export function validateCountryRow(input: {
  code: string;
  currency: string;
  regionBand: string;
  taxRule: string;
  taxCheckedAt: number;
  paymentMethods: readonly string[];
  enabled: boolean;
  minimumPayoutMinor: number;
}): CountryResult<CountryRow> {
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(code)) return { ok: false, reason: 'country-no-code' };
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, reason: 'country-bad-currency' };
  const regionBand = REGION_BANDS.find((b) => b === input.regionBand);
  if (regionBand === undefined) return { ok: false, reason: 'country-bad-band' };
  const taxRule = typeof input.taxRule === 'string' ? input.taxRule.trim() : '';
  if (taxRule === '') return { ok: false, reason: 'country-no-tax-rule' };
  if (!isFiniteInt(input.taxCheckedAt) || input.taxCheckedAt < 0) return { ok: false, reason: 'country-bad-tax-date' };
  if (!Array.isArray(input.paymentMethods) || input.paymentMethods.length === 0 || input.paymentMethods.some((m) => typeof m !== 'string' || m.trim() === '')) {
    return { ok: false, reason: 'country-bad-payment-methods' };
  }
  if (!isFiniteInt(input.minimumPayoutMinor) || input.minimumPayoutMinor < 0) return { ok: false, reason: 'country-bad-min-payout' };
  return {
    ok: true,
    value: {
      code,
      currency,
      regionBand,
      taxRule,
      taxCheckedAt: input.taxCheckedAt,
      paymentMethods: input.paymentMethods.map((m) => m.trim()),
      enabled: input.enabled === true,
      minimumPayoutMinor: input.minimumPayoutMinor,
    },
  };
}

export function lookupCountry(rows: readonly CountryRow[], code: string): CountryResult<CountryRow> {
  const wanted = typeof code === 'string' ? code.trim().toUpperCase() : '';
  const row = rows.find((r) => r.code === wanted);
  if (row === undefined) return { ok: false, reason: 'country-unknown:' + wanted };
  if (!row.enabled) return { ok: false, reason: 'country-disabled:' + wanted };
  return { ok: true, value: row };
}

export function bandPriceMinor(baseMinor: number, band: string): CountryResult<number> {
  if (!isFiniteInt(baseMinor) || baseMinor < 1) return { ok: false, reason: 'country-bad-base-price' };
  const regionBand = REGION_BANDS.find((b) => b === band);
  if (regionBand === undefined) return { ok: false, reason: 'country-bad-band' };
  return { ok: true, value: Math.round(baseMinor * REGION_BAND_MULTIPLIERS[regionBand]) };
}
