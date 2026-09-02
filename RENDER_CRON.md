# Render cron update for CarPrice

This repository can update `data/vehicles_ai.db.gz` directly from Render, so the
local Windows computer does not need to be online.

## Render Cron Job

Create a Render Cron Job connected to this GitHub repository.

- Name: `autoscan-pricing-backend-daily-update`
- Runtime: Node
- Branch: `main`
- Build command: `npm install`
- Command: `npm run cloud:update`
- Schedule: daily after the Sauto day is available, for example `30 8 * * *`
  if Render schedule is entered in UTC and you want roughly 10:30 in Prague
  during summer time.

## Environment variables

Set these on the Cron Job:

```text
GITHUB_REPO=Fojtik82/autoscan-pricing-backend
GITHUB_BRANCH=main
GITHUB_TOKEN=github_pat_...
GIT_AUTHOR_NAME=CarPrice DB Bot
GIT_AUTHOR_EMAIL=carprice-db-bot@users.noreply.github.com
SAUTO_LIMIT=200
SAUTO_MAX_PAGES=80
SAUTO_DETAIL_CONCURRENCY=8
SAUTO_RECONCILE_ENABLED=1
SAUTO_RECONCILE_CONCURRENCY=4
SAUTO_RECONCILE_PAGE_LIMIT=1000
SAUTO_RECONCILE_BUCKET_LIMIT=8000
SAUTO_MISSING_CHECKS_BEFORE_INACTIVE=3
```

`GITHUB_TOKEN` must be a GitHub token with write access to repository contents.
Do not put it into the repository.

## What it does

1. Clones the current backend repository to a temporary folder.
2. Restores `data/vehicles_ai.db` from the tracked gzip archive and opens it.
3. Scrapes Sauto listings from the last day for passenger cars, utility
   vehicles/vans, and motorcycles. Each category keeps its correct Sauto URL
   path and source name in the database.
4. Inserts only listings whose Sauto URL is not already in the database.
5. Reads the complete live Sauto index for passenger cars, utility vehicles,
   motorcycles, and quad bikes. Price buckets keep every API page below the
   Sauto pagination ceiling.
6. Updates Sauto lifecycle columns in `vehicle_app`:
   `is_active`, `last_seen_at`, `missing_since`, `missing_checks`, and
   `inactive_at`.
7. Marks a listing inactive only after it is absent from three consecutive
   successful daily checks. A listing that appears again is reactivated.
8. Compresses the updated DB and commits `data/vehicles_ai.db.gz` back to `main`.
9. The existing Render web service restores the DB archive during startup and
   auto-deploys the new commit. Price estimates
   and comparable listings automatically exclude rows with `is_active = 0`.

If the complete live-index scan fails or its coverage is suspiciously low, the
job exits before lifecycle reconciliation. This prevents a partial Sauto
response from deactivating a large part of the database.

If no new rows are found, it exits without pushing.
