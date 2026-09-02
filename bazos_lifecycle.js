const DEFAULT_TABLE = "vehicle_app";
const BAZOS_URL_RE = /^https?:\/\/(auto|motorky)\.bazos\.cz\/inzerat\/(\d+)\/[^/?#]+(?:[?#].*)?$/i;

export function parseBazosListing(value) {
  const match = String(value || "").trim().match(BAZOS_URL_RE);
  if (!match) return null;
  const domain = `${match[1].toLowerCase()}.bazos.cz`;
  const id = Number(match[2]);
  return { domain, id, key: `${domain}:${id}` };
}

export function hasSafeBazosCoverage(actual, expected) {
  if (expected <= 0) return actual === 0;
  const allowedGap = Math.max(200, Math.ceil(expected * 0.01));
  return actual >= expected - allowedGap;
}

export function reconcileBazosLifecycle(
  db,
  liveKeys,
  {
    table = DEFAULT_TABLE,
    now = new Date(),
    missingChecksBeforeInactive = 3,
    dryRun = false,
  } = {},
) {
  const normalizedLiveKeys = new Set([...liveKeys].map((value) => String(value)));
  const nowIso = now.toISOString();
  const graceChecks = Math.max(1, Math.round(Number(missingChecksBeforeInactive) || 3));
  const rows = db.prepare(
    `SELECT rowid, source_url, is_active, last_seen_at, last_checked_at,
            missing_since, missing_checks, inactive_at
       FROM ${JSON.stringify(table)}
      WHERE source_url IS NOT NULL
        AND TRIM(source_url) <> ''
        AND (
          lower(source_url) LIKE 'https://auto.bazos.cz/inzerat/%'
          OR lower(source_url) LIKE 'https://motorky.bazos.cz/inzerat/%'
        )`,
  ).all();

  const markSeen = dryRun ? null : db.prepare(
    `UPDATE ${JSON.stringify(table)}
        SET is_active = 1,
            last_seen_at = ?,
            last_checked_at = ?,
            missing_since = NULL,
            missing_checks = 0,
            inactive_at = NULL
      WHERE rowid = ?`,
  );
  const markMissing = dryRun ? null : db.prepare(
    `UPDATE ${JSON.stringify(table)}
        SET missing_since = COALESCE(missing_since, ?),
            missing_checks = ?,
            last_checked_at = ?
      WHERE rowid = ?`,
  );
  const markInactive = dryRun ? null : db.prepare(
    `UPDATE ${JSON.stringify(table)}
        SET is_active = 0,
            missing_since = COALESCE(missing_since, ?),
            missing_checks = ?,
            last_checked_at = ?,
            inactive_at = COALESCE(inactive_at, ?)
      WHERE rowid = ?`,
  );

  const stats = {
    checked: 0,
    live: 0,
    reactivated: 0,
    newly_missing: 0,
    pending_missing: 0,
    deactivated: 0,
    already_inactive: 0,
    invalid_urls: 0,
    already_checked_today: 0,
  };

  const apply = () => {
    for (const row of rows) {
      const listing = parseBazosListing(row.source_url);
      if (!listing) {
        stats.invalid_urls += 1;
        continue;
      }

      stats.checked += 1;
      const wasActive = Number(row.is_active) !== 0;
      if (normalizedLiveKeys.has(listing.key)) {
        stats.live += 1;
        if (!wasActive) stats.reactivated += 1;
        if (markSeen) markSeen.run(nowIso, nowIso, row.rowid);
        continue;
      }

      if (String(row.last_checked_at || "").slice(0, 10) === nowIso.slice(0, 10)) {
        stats.already_checked_today += 1;
        continue;
      }

      const previousChecks = Math.max(0, Number(row.missing_checks) || 0);
      const missingChecks = previousChecks + 1;
      if (previousChecks === 0) stats.newly_missing += 1;

      if (missingChecks >= graceChecks) {
        if (wasActive) stats.deactivated += 1;
        else stats.already_inactive += 1;
        if (markInactive) markInactive.run(nowIso, missingChecks, nowIso, nowIso, row.rowid);
      } else {
        stats.pending_missing += 1;
        if (markMissing) markMissing.run(nowIso, missingChecks, nowIso, row.rowid);
      }
    }
  };

  if (dryRun) apply();
  else db.transaction(apply)();

  return {
    ...stats,
    missing_checks_before_inactive: graceChecks,
    checked_at: nowIso,
  };
}
