# Mileage-sensitive price estimates

When a positive mileage is provided, `/price/estimate` and both legacy estimate
routes use a mileage-weighted median. Previously mileage only changed ordering;
with at most 120 candidates, every price had equal influence on the result.

## Selection and weighting

- Existing powertrain, engine, trim, power, transmission, drive, source and
  freshness constraints still run first. The existing opt-in missing-specs
  policy remains supported.
- Unknown, zero (the current clients' missing-value sentinel), negative and
  malformed listing mileages cannot support a mileage-specific price.
- Bandwidth is `clamp(targetKm * 0.25, 25000, 60000)` kilometres. The maximum
  supported distance is three bandwidths; more distant ads are excluded from
  price estimation, not from browsing comparable advertisements.
- Mileage eligibility is applied in SQL before the 5000-candidate limit and
  before deciding whether to widen the existing year window from +/-1 to +/-2.
  SQL ranks known, nearby mileages before this limit. Final ranking keeps the
  existing year/specification penalties; one mileage bandwidth adds 12 points.
- At most 120 eligible comparables contribute. Each receives weight
  `exp(-0.5 * ((listingKm - targetKm) / bandwidth)^2)`.
- The estimate and lower/upper prices are weighted p50, p15 and p85, rounded to
  thousands as before. The interval describes asking-price dispersion, not a
  statistical confidence interval or a guarantee of the sale price.
- At least three eligible ads and effective sample size
  `(sum(weights)^2 / sum(weights^2)) >= 2.5` are required. This also rejects a
  sample consisting of one close ad and negligible distant evidence.
- Absent or zero requested mileage retains the existing unweighted calculation.
  Invalid nonempty mileage returns `found: false`, `missing_input` and
  `invalid_fields: ["mileage"]`. Thousands separators and a `km` suffix are
  accepted; negative values, ranges and miles are not silently reinterpreted.

The bandwidth and minimum effective sample are conservative engineering
parameters, not a measured depreciation percentage. No price per kilometre or
invented depreciation curve is applied. A quantile can stay unchanged across
small mileage changes or equal asking prices. Changes in model generation,
equipment and source data quality can still affect an estimate; this change is
not a full appraisal model or an accuracy guarantee.

## API compatibility and operations

Existing response fields and matching schema 1 remain. Additional matching
fields identify `price_method: mileage_weighted_median_v1`, requested mileage,
bandwidth, maximum distance and effective support. `count`, `source_counts` and
partial-spec counts describe the same selected advertisements.

Both new runtime files (`price_db.js` and `mileage_pricing.js`) must deploy
together. There are no new packages, database migrations, import changes or
mobile build requirements. This branch targets the Czech main backend only.
Rollback is a revert of the change; database content is untouched.

## Verification

`node --test mileage_pricing.test.js price_db.test.js vehicle_variant.test.js comparison_policy.test.js comps_coverage.test.js`

Regression fixtures cover the original six-comparable failure, formatting,
unknown and invalid mileages, minimum support, no extrapolation, limits over
5000/120, year fallback, protected variant filters, price ordering and all three
actual HTTP estimate routes. The database examples recorded outside the source
tree are read-only checks on real asking-price data, not a validation against
completed vehicle sales.
