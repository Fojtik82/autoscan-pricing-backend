# Listing history in the saleability report

The product rule is **withdrawn listing = sold** for this statistic. The report
uses completed Sauto and Bazoš passenger-car listing durations directly, rather
than the experimental 30-day prediction model or registry-volume score.

`POST /market/sale-duration` accepts `brand`, `model`, and optional `year`,
`fuel`, `motor`, `engine_l`/`engine_ccm`, `transmission`, `drive`, `kw`,
`mileage_km`, and `source` (`sauto` or `bazos`).

The response includes arithmetic `average_days`, `median_days`, `p25_days`,
`p75_days`, `sample_size`, `sold_count`, `active_count`, `excluded_missing_dates`,
`by_source`, the actual `filters` and `match_level`, `date_basis`, and the
measured `period`. At least five dated withdrawn listings are required for the
combined result. Portal breakdowns expose their own sample counts. Arithmetic
means are weighted by the number of listings, not by giving each portal equal
weight.

## Dates and grouping

- Start: valid publication date, otherwise the earliest evidenced first live
  observation from the row or canonical `listing_first_seen` history. Dates
  recovered from historical archives are included. A publication date later
  than an existing live observation is rejected.
- End: `missing_since`, the first disappearance, for an inactive listing;
  `inactive_at` is a labelled fallback when the first disappearance is missing.
  The three daily checks confirming disappearance do not extend durations when
  `missing_since` exists.
- Missing, reversed, malformed or future dates do not create zero-day sales.
  Currently active/returned listings are excluded from completed durations.
- Deduplicate by portal and listing ID, including URL query variations. When
  duplicates disagree, the latest checked state wins; active wins a tie.
  Each portal listing is one sample; the same vehicle on two portals can count
  twice because cross-portal vehicle identity is unavailable.
- Match brand and model exactly after bounded aliases. BMW series queries
  include ordinary numbered variants. Renault Scenic stays separate from Grand
  Scenic. Exclude Slovak URLs, Sauto motorcycle/utility URLs, and recognizable
  Bazoš parts/wanted ads.
- Prefer the requested variant: year ±2, fuel, engine ±0.15 litres, power ±15 kW,
  mileage ±75,000 km, transmission and drive when supplied. If fewer than five
  measured listings match, broaden to year/fuel, year ±4, then the whole model.
  The response labels the actual group; the UI shows it with the sample count.

Historical start dates generally mean first observation, not an exact
publication timestamp. The UI states that it measures publication or first
observation through withdrawal and that withdrawn listings count as sold.
Bazoš imports now retain their valid displayed posting date in `published_at`;
Sauto continues to use first observation unless a publication date is available.

## Operation

The normal collector keeps lifecycle history. It creates model/year lookup
indexes during schema setup. Server startup also prepares these indexes for
existing archives. An optional index-preparation failure does not disable price
estimates. The endpoint opens the historical database read-only and does not
change listing states or require the experimental pilot to be enabled.
It uses a read-only SQLite memory map and a bounded 64 MiB page cache. Model-year
queries load the nearest years first and read broader cohorts only when needed.

The Flutter changes are in the sibling `../app` source overlay. The report loads
duration and registry data independently; a missing registry entry does not
hide usable listing history. The leading metric is average sale duration, with
median, middle-half range, sample count and portal breakdown. No-data/network
failures keep the registry breakdown usable and offer report refresh. Saved
reports retain the duration payload while older saved report formats still load.

Deploy the backend with its full historical database before releasing the app
overlay. The active-only mobile snapshot is unsuitable for this endpoint.
No production deployment or store release is performed by this local change.

## Local verification data

`../verification/history.db` is a disposable working copy of the local archive
with source checks from 2026-11-16, not a current live production snapshot.
`history-audit.json` records its coverage and `duration-results.json` contains
sample queries after deduplication and cohort filtering. These files are not
application assets and must not be packaged into the mobile app.
