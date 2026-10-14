export function requestedMarket(input = {}) {
  const value = input.market ?? 'CZ';
  if (typeof value !== 'string' || !['CZ', 'SK'].includes(value.toUpperCase()))
    throw new Error('Unsupported market; use CZ or SK');
  return value.toUpperCase();
}

export function selectMarketDatabase(input, databases) {
  const market = requestedMarket(input);
  return { market, currency: market === 'SK' ? 'EUR' : 'CZK', database: databases[market] ?? null };
}
