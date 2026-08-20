# Render cron update for CarPrice

This repository can update `data/vehicles_ai.db` directly from Render, so the
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
```

`GITHUB_TOKEN` must be a GitHub token with write access to repository contents.
Do not put it into the repository.

## What it does

1. Clones the current backend repository to a temporary folder.
2. Opens `data/vehicles_ai.db`.
3. Scrapes Sauto listings from the last day.
4. Inserts only listings whose Sauto URL is not already in the database.
5. Commits and pushes the updated DB back to `main`.
6. The existing Render web service auto-deploys the new commit.

If no new rows are found, it exits without pushing.
