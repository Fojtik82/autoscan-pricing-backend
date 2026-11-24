// Network collection is staged in memory. A failed or partial source must not
// reach insert, reconciliation, deactivation or price-refresh operations.
export async function collectIsolatedMarketSource({ source, enabled, scrape,
  validateScrape = () => true, indexEnabled, index, validateIndex }) {
  if (!enabled) return { source, enabled: false, scraped: null, liveIndex: null, failure: null };
  let scraped;
  try {
    scraped = await scrape();
    if (!validateScrape(scraped)) throw new Error('Invalid daily collection result');
    if (Array.isArray(scraped?.indexErrors) && scraped.indexErrors.length) {
      throw new Error('Incomplete daily index: ' + scraped.indexErrors.join('; '));
    }
  } catch (error) {
    // A damaged or unavailable local database is not an external source
    // outage; do not continue writing or publish a possibly corrupt file.
    if (/^SQLITE_/.test(String(error?.code || ''))) throw error;
    return { source, enabled: true, scraped: null, liveIndex: null,
      failure: { source, phase: 'daily_collection', message: String(error?.message || error).slice(0, 1000) } };
  }
  if (!indexEnabled) return { source, enabled: true, scraped, liveIndex: null, failure: null };
  try {
    const liveIndex = await index();
    if (!validateIndex(liveIndex)) throw new Error('Invalid or incomplete live index');
    return { source, enabled: true, scraped, liveIndex, failure: null };
  } catch (error) {
    if (/^SQLITE_/.test(String(error?.code || ''))) throw error;
    return { source, enabled: true, scraped: null, liveIndex: null,
      failure: { source, phase: 'live_index', message: String(error?.message || error).slice(0, 1000) } };
  }
}
