# Verification of 30-day ad inactivity forecasts

This is an experimental model for cars **already advertised**. Its target is
confirmed inactivity at the first successful source check 30–32 days after
issuance. It does not predict confirmed sales, the lifetime of a newly posted ad,
or a causal effect of lowering the asking price. The existing paid Flutter report
is not switched to this model.

## Historical test

The algorithm and constants are fixed in `saleability_model.js`: hierarchical
empirical rates, source-specific baselines, minimum 50 resolved observations per
cell, and shrinkage strength 20. Cells condition on model, five-year band,
powertrain, transmission, engine displacement, 100,000 km band, drive and asking
price position where supported. A broader match is explicitly labelled; unknown
models are withheld. Price reference medians need 20 contemporaneous peers and
are computed only from the feature snapshot, never the outcome snapshot.

Training uses the verified Bazos index on 2026-09-02 and its outcome on 2026-10-02.
The holdout feature archive is from 2026-10-04, after the training outcomes were
available; its outcome is from 2026-11-03. Snapshot commit timestamps determine
simulated issuance, so later price refreshes within that archive are not treated
as known before the archive existed. The oldest Sauto archive has no complete
index check, so it is excluded from this historical temporal test. We do not
manufacture a historical Sauto forecast.

The Bazos holdout has 16,078 supported predictions. Brier score is 0.25456 versus
0.24877 for the fixed source baseline (lower is better). Mean predicted inactivity
is 62.99%, actual inactivity 55.90%. Calibration error is 7.78 percentage points.
The model has **not beaten the baseline**, and is not approved for production.
Performance on previously unseen listing IDs is also reported. No constants were
tuned to improve this holdout result. Full counts, censoring, calibration bins and
immutable archive commits are in `data/saleability-backtest.json`.

After this test, the same fixed algorithm is refitted on the latest completed
October–November cohort from both sources. This produces a different, explicitly
identified model for the prospective pilot; the historical score is not falsely
attributed to its refitted coefficients.

## Prospective pilot

`Start saleability verification pilot` serializes with the existing daily importer.
It freezes up to 5,000 forecasts, at most 2,500 per source, using a deterministic
hash sample independent of outcomes. The cohort fills only during its first
24 hours. The model, features, source observation timestamp, issuance timestamp,
due date, predicted probability and simple baseline probability are persisted in
the tracked SQLite archive. Retry calls cannot rewrite predictions. Model version
changes are rejected while this pilot exists.

The existing collector calls `updateSaleabilityPilot` after successful source
reconciliation and price refresh. Evaluation needs a complete, fresh source
check after the individual due date. Three missing checks yield outcome 1; a
confirmed live listing yields 0. Pending absence, absent evidence or a source
check more than two days late is censored, never silently counted as a live ad.
Each outcome is frozen after evaluation. Both candidates are scored on exactly
the same resolved forecasts, and censoring is reported separately.

At maturity, report Brier score, source-specific calibration, comparison with the
simple baseline, coverage and censoring. Historical rejection cannot be erased
by refitting; prospective results must stand on their own. Promotion to a paid
result requires a separate review and is never automatic.

## Read-only API

- `GET /market/saleability/status`: cohort size, first due date, pending/censored
  counts, Brier scores and calibration bins. No raw listing IDs are returned.
- `POST /market/saleability`: experimental market references per source for
  `brand`, `model`, and optional `year`, `mileage_km`, `fuel`, `motor`,
  `transmission`, `drive`, `engine_ccm`, `engine_l`, `asking_price_czk`, `source`.
  Broader conditioning is identified by `match_level`. Fresh current peer prices
  are used where available; insufficient support and stale sources are withheld.

Both endpoints explicitly retain `production_ready: false`. A group Wilson
interval describes uncertainty in the historical group rate, not an individual
vehicle's sale probability or protection against seasonal drift.

Cars may be advertised on both portals. Source identities are deduplicated within
each portal, with conflicting baseline features excluded. Physical-vehicle
duplicates across portals remain and source results are never averaged together.
