// Similarity weights, not a fixed depreciation rate. Prices remain derived
// from observed advertisements for the already matched vehicle variant.
export const MILEAGE_PRICE_METHOD = 'mileage_weighted_median_v1';
export const MILEAGE_EXTRAPOLATION_METHOD = 'mileage_extrapolated_weighted_median_v1';
export const MIN_EFFECTIVE_COMPARABLES = 2.5;

export function parseMileage(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  let text = value.trim().replace(/\s+/gu, '').replace(/km$/i, '');
  if (/^\d{1,3}(?:,\d{3})+$/.test(text) || /^\d{1,3}(?:\.\d{3})+$/.test(text)) {
    text = text.replace(/[.,]/g, '');
  }
  if (!/^\d+(?:\.0+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

export function mileageBandwidth(targetKm) {
  // A bounded local neighbourhood: 25% of the requested mileage, 25–60k km.
  // No extrapolation beyond three bandwidths in price estimates.
  return Math.max(25000, Math.min(60000, targetKm * 0.25));
}

export function mileageWeight(mileage, targetKm) {
  if (!(mileage > 0) || !(targetKm > 0)) return 0;
  const distance = Math.abs(mileage - targetKm) / mileageBandwidth(targetKm);
  return distance <= 3 ? Math.exp(-0.5 * distance * distance) : 0;
}

export function extrapolationBandwidth(targetKm) {
  return Math.max(120000, Math.min(160000, targetKm * 0.25));
}

export function extrapolationWeight(mileage, targetKm) {
  if (!(mileage > 0) || !(targetKm > 0)) return 0;
  const distance = Math.abs(mileage - targetKm) / extrapolationBandwidth(targetKm);
  return distance <= 3 ? Math.exp(-0.5 * distance * distance) : 0;
}

// A median of observed pairwise slopes is resistant to a single unusually
// cheap or expensive listing. It only normalizes existing asking prices; it
// never introduces a fixed depreciation rate.
export function robustMileageSlope(rows) {
  const slopes = [];
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const distance = rows[right].mileage - rows[left].mileage;
      if (Math.abs(distance) < 25000) continue;
      slopes.push((rows[right].price - rows[left].price) / distance);
    }
  }
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  // Asking prices should not rise with mileage. Capping a very steep decline
  // prevents a small, noisy sample from producing a negative price.
  return Math.max(-1.5, Math.min(0, slopes[Math.floor(slopes.length / 2)]));
}

export function effectiveComparables(weighted) {
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  const squares = weighted.reduce((sum, item) => sum + item.weight ** 2, 0);
  return squares > 0 ? total * total / squares : 0;
}

export function weightedPercentile(weighted, quantile) {
  const sorted = weighted.filter(item => item.weight > 0 && Number.isFinite(item.value))
    .sort((a, b) => a.value - b.value);
  if (!sorted.length) return null;
  const threshold = sorted.reduce((sum, item) => sum + item.weight, 0) * quantile;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= threshold) return item.value;
  }
  return sorted[sorted.length - 1].value;
}
