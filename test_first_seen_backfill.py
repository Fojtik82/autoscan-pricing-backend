import sqlite3
import unittest
from first_seen_backfill import apply_observations, collect_snapshot, listing_key


class BackfillTests(unittest.TestCase):
    def test_historical_duplicates_use_earliest_live_observation_and_ignore_missing_checks(self):
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.execute('CREATE TABLE vehicle_app(source_url TEXT, last_seen_at TEXT, last_checked_at TEXT)')
        db.executemany('INSERT INTO vehicle_app VALUES (?,?,?)', [
            ('https://sauto.cz/osobni/detail/skoda/octavia/123', '2026-09-03T08:00:00Z', '2026-11-02T08:00:00Z'),
            ('https://www.sauto.cz/osobni/detail/skoda/octavia/123?x=1', '2026-09-02T08:00:00Z', None),
            ('https://auto.bazos.cz/inzerat/456/auto.php', None, '2026-11-02T08:00:00Z'),
            ('https://example.org/?sauto.cz', '2026-09-01T08:00:00Z', None),
            ('https://auto.bazos.cz/inzerat/789/auto.php', '2027-01-01T08:00:00Z', None),
        ])
        evidence = {}
        collect_snapshot(db, 'abc', '2026-11-02T23:00:00.000Z', evidence)
        self.assertEqual(evidence, {'sauto:123': ('2026-09-02T08:00:00.000Z', 'github_snapshot:abc')})

    def test_repair_is_idempotent_preserves_lifecycle_and_does_not_claim_known_publication(self):
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.executescript('''CREATE TABLE vehicle_app(source_url TEXT, first_seen_at TEXT,
            first_seen_after_at TEXT, first_seen_is_observed INTEGER, first_seen_evidence TEXT,
            is_active INTEGER, inactive_at TEXT);
            CREATE TABLE listing_first_seen(listing_key TEXT PRIMARY KEY, first_seen_at TEXT,
            first_seen_after_at TEXT, first_seen_is_observed INTEGER, evidence TEXT);''')
        db.execute('INSERT INTO vehicle_app VALUES (?,?,NULL,0,?,0,?)',
                   ('https://auto.bazos.cz/inzerat/456/auto.php', '2026-10-01T08:00:00.000Z', 'legacy_last_seen', '2026-10-03T08:00:00Z'))
        evidence = {'bazos:auto.bazos.cz:456': ('2026-09-02T08:00:00.000Z', 'github_snapshot:abc')}
        self.assertEqual(apply_observations(db, evidence), 1)
        self.assertEqual(apply_observations(db, evidence), 0)
        row = db.execute('SELECT first_seen_at,first_seen_is_observed,is_active,inactive_at FROM vehicle_app').fetchone()
        self.assertEqual(row, ('2026-09-02T08:00:00.000Z', 0, 0, '2026-10-03T08:00:00Z'))
        later = {'bazos:auto.bazos.cz:456': ('2026-10-01T08:00:00.000Z', 'github_snapshot:def')}
        self.assertEqual(apply_observations(db, later), 0)
        self.assertEqual(db.execute('SELECT first_seen_at FROM listing_first_seen').fetchone()[0], row[0])

    def test_bazos_domains_are_separate(self):
        self.assertNotEqual(listing_key('https://auto.bazos.cz/inzerat/123/x.php'),
                            listing_key('https://motorky.bazos.cz/inzerat/123/x.php'))


if __name__ == '__main__':
    unittest.main()
