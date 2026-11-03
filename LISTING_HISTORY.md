# First observations for listing-duration estimates

`first_seen_at` is the earliest evidenced live observation, not a publication or
sale date. `last_checked_at` of a missing ad must never fill it.

- `first_seen_is_observed = 0`: the beginning is left censored. This includes
  the initial complete index, legacy last-seen fallbacks, and reconstructed
  historical observations. Do not use these rows as complete listing lifetimes.
- `first_seen_is_observed = 1`: the ID first entered a complete live index after
  an earlier successful complete index. Its observation interval begins after
  `first_seen_after_at` and at or before `first_seen_at`. This is still not an
  exact publication date.
- `first_seen_evidence` identifies the complete live index, a conservative
  legacy fallback, or the immutable GitHub archive commit used in recovery.
- Null means no live observation is evidenced. A later absence check cannot
  manufacture one.

`listing_first_seen` stores canonical source/ID identities for the **entire**
successful live index, including IDs not yet imported into `vehicle_app`.
Consequently delayed imports and duplicate URLs retain their actual earliest
recorded observation. Bazos Auto and Motorky identities remain separate.
Reactivation preserves the first observation; do not treat a reactivated ad as
a fresh, independent sale. Source coverage guards continue to run before
reconciliation; failed/incomplete scans do not advance first-seen history.

The one-time **Repair listing first observations** workflow serializes with the
existing daily importer. It downloads every available archive commit since
2026-09-01 and takes the earliest confirmed `last_seen_at` per source/ID. It
publishes only after all input archives and the output SQLite database pass
verification. Rows and lifecycle states are preserved. Provenance and recovery
counts are saved in `data/first-seen-backfill-report.json`.

Historical archives contain imported ads, not the full historical live index.
Their absence cannot prove a new arrival, so the repair deliberately retains
`first_seen_is_observed = 0`. Use these durations as observed lower bounds or
with a method that explicitly handles left censoring; do not average them as
complete lifetimes. Three successful missing checks still confirm inactivity,
and disappearance remains a proxy, not proof of a completed sale.
