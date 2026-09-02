const DEFAULT_TABLE = "vehicle_app";

const SAUTO_URL_RE = /^https?:\/\/(?:www\.)?sauto\.cz\/(?:osobni|uzitkova|motorky|ctyrkolky)\/detail\/[^/]+\/[^/]+\/(\d+)(?:[/?#]|$)/i;
const CATEGORY_SLUG_BY_ID = new Map([
  [838, "osobni"],
  [839, "uzitkova"],
  [841, "motorky"],
  [842, "ctyrkolky"],
]);
const DAILY_SOURCE_BY_CATEGORY = new Map([
  ["osobni", "sauto_1den_cloud"],
  ["uzitkova", "sauto_uzitkova_1den_cloud"],
  ["motorky", "sauto_motorky_1den_cloud"],
  ["ctyrkolky", "sauto_ctyrkolky_1den_cloud"],
]);

export function sautoCategorySlug(item = {}) {
  const slug = String(item.category?.seo_name || "").trim().toLowerCase();
  if (DAILY_SOURCE_BY_CATEGORY.has(slug)) return slug;
  return CATEGORY_SLUG_BY_ID.get(Number(item.category?.id)) || null;
}

export function buildSautoListingUrl(item = {}) {
  const category = sautoCategorySlug(item);
  const brand = item.manufacturer_cb?.seo_name;
  const model = item.model_cb?.seo_name;
  if (!category || !brand || !model || !item.id) return null;
  return `https://www.sauto.cz/${category}/detail/${brand}/${model}/${item.id}`;
}

export function sautoDailySourceDb(item = {}) {
  return DAILY_SOURCE_BY_CATEGORY.get(sautoCategorySlug(item)) || "sauto_1den_cloud";
}

export function parseSautoListingId(value) {
  const match = String(value || "").trim().match(SAUTO_URL_RE);
  return match ? Number(match[1]) : null;
}

export function hasSautoLifecycleSchema(db, table = DEFAULT_TABLE) {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => row.name),
  );
  return [
    "is_active",
    "last_seen_at",
    "missing_since",
    "missing_checks",
    "inactive_at",
  ].every((column) => columns.has(column));
}

export function ensureSautoLifecycleSchema(db, table = DEFAULT_TABLE) {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => row.name),
  );
  const additions = [
    ["is_active", "INTEGER NOT NULL DEFAULT 1"],
    ["last_seen_at", "TEXT"],
    ["missing_since", "TEXT"],
    ["missing_checks", "INTEGER NOT NULL DEFAULT 0"],
    ["inactive_at", "TEXT"],
  ];

  for (const [column, definition] of additions) {
    if (!columns.has(column)) {
      db.exec(
        `ALTER TABLE ${JSON.stringify(table)} ADD COLUMN ${JSON.stringify(column)} ${definition}`,
      );
    }
  }

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_${table}_is_active ON ${JSON.stringify(table)}(is_active)`,
  );
}

export function reconcileSautoLifecycle(
  db,
  liveIds,
  {
    table = DEFAULT_TABLE,
    now = new Date(),
    missingChecksBeforeInactive = 3,
    dryRun = false,
  } = {},
) {
  const normalizedLiveIds = new Set([...liveIds].map((value) => Number(value)));
  const nowIso = now.toISOString();
  const graceChecks = Math.max(1, Math.round(Number(missingChecksBeforeInactive) || 3));
  const rows = db.prepare(
    `SELECT rowid, source_url, is_active, last_seen_at, missing_since,
            missing_checks, inactive_at
       FROM ${JSON.stringify(table)}
      WHERE source_url IS NOT NULL
        AND TRIM(source_url) <> ''
        AND lower(source_url) LIKE '%sauto.cz%'`,
  ).all();

  const markSeen = dryRun ? null : db.prepare(
    `UPDATE ${JSON.stringify(table)}
        SET is_active = 1,
            last_seen_at = ?,
            missing_since = NULL,
            missing_checks = 0,
            inactive_at = NULL
      WHERE rowid = ?`,
  );
  const markMissing = dryRun ? null : db.prepare(
    `UPDATE ${JSON.stringify(table)}
        SET missing_since = COALESCE(missing_since, ?),
            missing_checks = ?
      WHERE rowid = ?`,
  );
  const markInactive = dryRun ? null : db.prepare(
    `UPDATE ${JSON.stringify(table)}
        SET is_active = 0,
            missing_since = COALESCE(missing_since, ?),
            missing_checks = ?,
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
  };

  const apply = () => {
    for (const row of rows) {
      const itemId = parseSautoListingId(row.source_url);
      if (!itemId) {
        stats.invalid_urls += 1;
        continue;
      }

      stats.checked += 1;
      const wasActive = Number(row.is_active) !== 0;
      if (normalizedLiveIds.has(itemId)) {
        stats.live += 1;
        if (!wasActive) stats.reactivated += 1;
        if (markSeen) markSeen.run(nowIso, row.rowid);
        continue;
      }

      const previousChecks = Math.max(0, Number(row.missing_checks) || 0);
      const missingChecks = previousChecks + 1;
      if (previousChecks === 0) stats.newly_missing += 1;

      if (missingChecks >= graceChecks) {
        if (wasActive) stats.deactivated += 1;
        else stats.already_inactive += 1;
        if (markInactive) markInactive.run(nowIso, missingChecks, nowIso, row.rowid);
      } else {
        stats.pending_missing += 1;
        if (markMissing) markMissing.run(nowIso, missingChecks, row.rowid);
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
