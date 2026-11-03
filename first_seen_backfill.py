"""Recover confirmed observations from immutable DB archives, never publication dates.

Snapshots contain only known imported ads, not the entire historical live index.
Absence from them must therefore NOT be treated as proof of a new publication.
"""
import argparse
import contextlib
from concurrent.futures import ThreadPoolExecutor
from collections import deque
import datetime as dt
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import time
import urllib.request


def listing_key(url):
    sauto = re.match(r"https?://(?:www\.)?sauto\.cz/(?:osobni|uzitkova|motorky|ctyrkolky)/detail/[^/]+/[^/]+/(\d+)(?:[/?#]|$)", url or "", re.I)
    if sauto:
        return "sauto:" + str(int(sauto[1]))
    bazos = re.match(r"https?://(auto|motorky)\.bazos\.cz/inzerat/(\d+)/[^/?#]+(?:[?#].*)?$", url or "", re.I)
    if bazos:
        return f"bazos:{bazos[1].lower()}.bazos.cz:{int(bazos[2])}"
    return None


def timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, TypeError, AttributeError):
        return None


def collect_snapshot(connection, revision, committed_at, observations):
    columns = {row[1] for row in connection.execute("PRAGMA table_info(vehicle_app)")}
    if "last_seen_at" not in columns:
        return 0
    count = 0
    for url, seen in connection.execute("SELECT source_url, last_seen_at FROM vehicle_app WHERE last_seen_at IS NOT NULL"):
        key, seen = listing_key(url), timestamp(seen)
        if not key or not seen or seen > committed_at:
            continue
        count += 1
        if key not in observations or seen < observations[key][0]:
            observations[key] = (seen, "github_snapshot:" + revision)
    return count


def apply_observations(connection, observations):
    """Only move the earliest observation back; never change lifecycle state."""
    updated = 0
    with connection:
        for rowid, url, current in connection.execute("SELECT rowid, source_url, first_seen_at FROM vehicle_app"):
            key = listing_key(url)
            evidence = observations.get(key)
            if not evidence or (current and current <= evidence[0]):
                continue
            seen, provenance = evidence
            connection.execute("""UPDATE vehicle_app SET first_seen_at=?, first_seen_after_at=NULL,
                first_seen_is_observed=0, first_seen_evidence=? WHERE rowid=?""", (seen, provenance, rowid))
            updated += 1
        for key, (seen, provenance) in observations.items():
            connection.execute("""INSERT INTO listing_first_seen
                (listing_key, first_seen_at, first_seen_after_at, first_seen_is_observed, evidence)
                VALUES (?, ?, NULL, 0, ?)
                ON CONFLICT(listing_key) DO UPDATE SET first_seen_at=excluded.first_seen_at,
                    first_seen_after_at=NULL, first_seen_is_observed=0, evidence=excluded.evidence
                WHERE excluded.first_seen_at < listing_first_seen.first_seen_at""", (key, seen, provenance))
    return updated


def api_json(url):
    headers = {"User-Agent": "CarPrice-first-seen-repair", "Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90) as response:
        return json.load(response)


def archive_commits(repo, ref, since):
    commits = []
    for page in range(1, 101):
        batch = api_json(f"https://api.github.com/repos/{repo}/commits?sha={ref}&path=data/vehicles_ai.db.gz&since={since}T00:00:00Z&per_page=100&page={page}")
        commits.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise RuntimeError("Incomplete archive history: pagination limit exceeded")
    if not commits:
        raise RuntimeError("No historical archives found")
    return sorted(commits, key=lambda commit: commit["commit"]["committer"]["date"])


def download_snapshot(repo, sha, target):
    # The public raw host never receives the API token.
    url = f"https://raw.githubusercontent.com/{repo}/{sha}/data/vehicles_ai.db.gz"
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "CarPrice-first-seen-repair"})
            with urllib.request.urlopen(request, timeout=120) as response, gzip.GzipFile(fileobj=response) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
            return
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--repo", default="Fojtik82/autoscan-pricing-backend")
    parser.add_argument("--ref", required=True)
    parser.add_argument("--since", default="2026-09-01")
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=3)
    parser.add_argument("--report", type=Path, default=Path("first-seen-backfill-report.json"))
    args = parser.parse_args()
    commits = archive_commits(args.repo, args.ref, args.since)
    observations, archives = {}, []
    with tempfile.TemporaryDirectory(prefix="carprice-first-seen-") as directory, ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending, remaining = deque(), iter(enumerate(commits, 1))

        def schedule_next():
            item = next(remaining, None)
            if item is None:
                return
            index, commit = item
            target = Path(directory) / f"snapshot-{index}.db"
            pending.append((index, commit, target, pool.submit(download_snapshot, args.repo, commit["sha"], target)))

        for _ in range(args.workers):
            schedule_next()
        while pending:
            index, commit, target, future = pending.popleft()
            future.result()
            sha = commit["sha"]
            with contextlib.closing(sqlite3.connect(target.as_uri() + "?mode=ro", uri=True)) as snapshot:
                snapshot.execute("PRAGMA trusted_schema=OFF")
                if snapshot.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise RuntimeError("Historical archive failed SQLite integrity check: " + sha)
                count = collect_snapshot(snapshot, sha, timestamp(commit["commit"]["committer"]["date"]), observations)
            archives.append({"commit": sha, "observations": count})
            print(json.dumps({"archive": index, "total": len(commits), "commit": sha, "unique_observed_ads": len(observations)}), flush=True)
            target.unlink()
            schedule_next()
    # All input archives must succeed before publishing any reconstructed dates.
    with contextlib.closing(sqlite3.connect(args.database)) as database:
        before_count = database.execute("SELECT COUNT(*) FROM vehicle_app").fetchone()[0]
        updated = apply_observations(database, observations)
        after_count = database.execute("SELECT COUNT(*) FROM vehicle_app").fetchone()[0]
        if before_count != after_count or database.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Repaired database failed verification")
        stats = database.execute("""SELECT COUNT(*), COUNT(first_seen_at),
            SUM(first_seen_is_observed=1), SUM(first_seen_evidence LIKE 'github_snapshot:%') FROM vehicle_app""").fetchone()
    report = {"ok": True, "ref": args.ref, "archives": archives, "unique_historical_ads": len(observations),
              "rows_improved": updated, "row_count": stats[0], "with_first_observation": stats[1],
              "bounded_arrivals": stats[2], "rows_with_archive_evidence": stats[3],
              "publication_dates_reconstructed": False}
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "archives"}), flush=True)


if __name__ == "__main__":
    main()
