import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { makeReader, updateNicheSources } from "./niche_sources.js";

const SOURCE = { id: "rajveteranu", host: "www.rajveteranu.cz" };
const DETAIL = "https://www.rajveteranu.cz/80499-jawa-250-cz-1958";
const ok = () => new Response("<title>Jawa</title>Complete detail");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function harness(handler, { robots = "User-agent: *\nDisallow:\n" } = {}) {
  let clock = Date.parse("2026-10-20T10:00:00Z");
  const calls = [];
  const warnings = [];
  const sleeps = [];
  return {
    calls, warnings, sleeps,
    options: {
      fetchImpl: async (input, init) => {
        const url = String(input);
        const call = { url, init, at: clock };
        calls.push(call);
        return url.endsWith("/robots.txt") ? new Response(robots) : handler(call);
      },
      now: () => clock,
      sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; },
      onRetry: (message) => warnings.push(message),
    },
  };
}

test("a transient fetch failure recovers with a fresh paced request", async () => {
  let attempts = 0;
  const fake = harness(() => {
    if (++attempts === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    return ok();
  });
  const read = await makeReader(SOURCE, fake.options);
  const result = await read(DETAIL);
  assert.equal(result.status, 200);
  assert.match(result.html, /Complete detail/);
  assert.equal(attempts, 2);
  assert.equal(fake.warnings.length, 1);
  assert.match(fake.warnings[0], /retry 2\/4.*1000ms/);
  const calls = fake.calls.filter((call) => call.url === DETAIL);
  assert.ok(calls[1].at - calls[0].at >= 1000);
  assert.notEqual(calls[0].init.signal, calls[1].init.signal);
  assert.equal(calls[1].init.redirect, "manual");
});

test("retries stop after four failures with exponential backoff", async () => {
  const fake = harness(() => { throw new TypeError("fetch failed"); });
  const read = await makeReader(SOURCE, fake.options);
  await assert.rejects(read(DETAIL), /failed after 4 attempts: fetch failed/);
  const calls = fake.calls.filter((call) => call.url === DETAIL);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(1).map((call, i) => call.at - calls[i].at), [1000, 2000, 4000]);
  assert.equal(fake.warnings.length, 3);
});

for (const status of [408, 429, 500, 502, 503, 504]) {
  test("HTTP " + status + " recovers and closes the failed response", async () => {
    let attempts = 0;
    let cancelled = false;
    const fake = harness(() => ++attempts === 1
      ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }) : ok());
    const read = await makeReader(SOURCE, fake.options);
    assert.equal((await read(DETAIL)).status, 200);
    assert.equal(attempts, 2);
    assert.equal(cancelled, true);
  });
}

for (const retryAfter of ["10", "Tue, 20 Oct 2026 10:00:10 GMT"]) {
  test("Retry-After is respected: " + retryAfter, async () => {
    let attempts = 0;
    const fake = harness(() => ++attempts === 1
      ? new Response("Busy", { status: 429, headers: { "Retry-After": retryAfter } }) : ok());
    const read = await makeReader(SOURCE, fake.options);
    await read(DETAIL);
    const calls = fake.calls.filter((call) => call.url === DETAIL);
    assert.ok(calls[1].at >= Date.parse("2026-10-20T10:00:10Z"));
    if (retryAfter === "10") assert.ok(calls[1].at - calls[0].at >= 10000);
  });
}

test("a Retry-After beyond the budget fails instead of retrying early", async () => {
  const fake = harness(() => new Response("Busy", { status: 503, headers: { "Retry-After": "120" } }));
  const read = await makeReader(SOURCE, fake.options);
  await assert.rejects(read(DETAIL), /Retry-After exceeds/);
  assert.equal(fake.calls.filter((call) => call.url === DETAIL).length, 1);
  assert.equal(fake.warnings.length, 0);
});

test("Retry-After also delays a second worker that was already waiting", async () => {
  let clock = Date.parse("2026-10-20T10:00:00Z");
  const waits = [];
  const requests = [];
  const started = deferred();
  const failed = deferred();
  const firstResponse = deferred();
  let first = true;
  const read = await makeReader(SOURCE, {
    now: () => clock,
    sleepImpl: (ms) => new Promise((resolve) => waits.push({ ms, resolve })),
    onRetry: () => failed.resolve(),
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:\n");
      requests.push({ url, at: clock });
      if (first) { first = false; started.resolve(); return firstResponse.promise; }
      return ok();
    },
  });
  const one = read(DETAIL);
  // Advance the initial crawl pacing before the first detail starts.
  await new Promise((resolve) => setImmediate(resolve));
  const initialWait = waits.shift();
  clock += initialWait.ms;
  initialWait.resolve();
  await started.promise;
  const two = read(DETAIL.replace("80499", "80500"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waits.length, 1);
  firstResponse.resolve(new Response("Busy", { status: 429, headers: { "Retry-After": "10" } }));
  await failed.promise;
  const alreadyWaiting = waits.shift();
  clock += alreadyWaiting.ms;
  alreadyWaiting.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  while (requests.length < 3) {
    const wait = waits.shift();
    assert.ok(wait, "both pending reads must remain paced");
    clock += wait.ms;
    wait.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all([one, two]);
  assert.ok(requests.slice(1).every((request) => request.at - requests[0].at >= 10000));
});

test("a truncated response is discarded before retrying the entire detail", async () => {
  let attempts = 0;
  const fake = harness(() => {
    if (++attempts !== 1) return ok();
    let first = true;
    return new Response(new ReadableStream({
      pull(controller) {
        if (first) { first = false; controller.enqueue(new TextEncoder().encode("partial data")); }
        else controller.error(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } }));
      },
    }));
  });
  const read = await makeReader(SOURCE, fake.options);
  const result = await read(DETAIL);
  assert.equal(attempts, 2);
  assert.equal(result.html, "<title>Jawa</title>Complete detail");
});

test("request timeouts recover", async () => {
  let attempts = 0;
  const fake = harness(() => {
    if (++attempts === 1) throw new DOMException("Request timed out", "TimeoutError");
    return ok();
  });
  const read = await makeReader(SOURCE, fake.options);
  assert.equal((await read(DETAIL)).status, 200);
  assert.equal(attempts, 2);
});

for (const status of [401, 403, 404, 410]) {
  test("HTTP " + status + " is never retried", async () => {
    const fake = harness(() => new Response("Unavailable", { status }));
    const read = await makeReader(SOURCE, fake.options);
    if (status === 404 || status === 410) assert.equal((await read(DETAIL)).status, status);
    else await assert.rejects(read(DETAIL), new RegExp("HTTP " + status));
    assert.equal(fake.calls.filter((call) => call.url === DETAIL).length, 1);
    assert.equal(fake.warnings.length, 0);
  });
}

test("certificate failures and access challenges are not retried", async () => {
  for (const failure of [
    () => { throw new TypeError("fetch failed", { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }); },
    () => new Response("<title>Verify you are human</title>"),
  ]) {
    const fake = harness(failure);
    const read = await makeReader(SOURCE, fake.options);
    await assert.rejects(read(DETAIL));
    assert.equal(fake.calls.filter((call) => call.url === DETAIL).length, 1);
    assert.equal(fake.warnings.length, 0);
  }
});

test("robots and same-host redirect checks still block unsafe requests", async () => {
  const blocked = harness(ok, { robots: "User-agent: *\nDisallow: /80499\n" });
  const blockedRead = await makeReader(SOURCE, blocked.options);
  await assert.rejects(blockedRead(DETAIL), /robots disallows/);
  assert.equal(blocked.calls.length, 1);

  const redirect = harness(() => new Response(null, {
    status: 302, headers: { Location: "https://example.com/other" },
  }));
  const redirectedRead = await makeReader(SOURCE, redirect.options);
  await assert.rejects(redirectedRead(DETAIL), /unsafe redirect/);
  assert.equal(redirect.calls.length, 2);
  assert.equal(redirect.warnings.length, 0);
});

test("robots crawl-delay remains in force during retries", async () => {
  let attempts = 0;
  const fake = harness(() => ++attempts === 1 ? new Response("Busy", { status: 503 }) : ok(), {
    robots: "User-agent: *\nCrawl-delay: 5\n",
  });
  const read = await makeReader(SOURCE, fake.options);
  await read(DETAIL);
  const calls = fake.calls.filter((call) => call.url === DETAIL);
  assert.ok(calls[1].at - calls[0].at >= 5000);
});

test("exhausted detail retries preserve all existing source rows and completion state", async (t) => {
  const savedFetch = globalThis.fetch;
  const savedFlag = process.env.SPORTOVNIVOZY_ENABLED;
  const savedRajFlag = process.env.RAJVETERANU_ENABLED;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:\n");
    if (url.endsWith("/komplet")) return new Response('<h1>Kompletní nabídka</h1>'
      + '<table class="vypisDilo zalamovaniTextu"><a href="' + DETAIL + '">Jawa</a></table>');
    throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  };
  process.env.SPORTOVNIVOZY_ENABLED = "0";
  process.env.RAJVETERANU_ENABLED = "1";
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedFlag === undefined) delete process.env.SPORTOVNIVOZY_ENABLED;
    else process.env.SPORTOVNIVOZY_ENABLED = savedFlag;
    if (savedRajFlag === undefined) delete process.env.RAJVETERANU_ENABLED;
    else process.env.RAJVETERANU_ENABLED = savedRajFlag;
  });
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE vehicle_app (source_url TEXT, price INTEGER, is_active INTEGER, missing_checks INTEGER);"
    + "CREATE TABLE market_source_runs (source TEXT PRIMARY KEY, completed_at TEXT, indexed INTEGER, priced INTEGER)");
  db.prepare("INSERT INTO vehicle_app VALUES (?, 120000, 1, 0)").run(DETAIL);
  db.prepare("INSERT INTO market_source_runs VALUES ('rajveteranu', '2026-10-18', 1, 1)").run();
  const before = db.prepare("SELECT * FROM vehicle_app").all();
  const beforeRuns = db.prepare("SELECT * FROM market_source_runs").all();
  const result = await updateNicheSources(db);
  assert.equal(result.find((source) => source.source === "rajveteranu").ok, false);
  assert.match(result.find((source) => source.source === "rajveteranu").error, /failed after 4 attempts/);
  assert.deepEqual(db.prepare("SELECT * FROM vehicle_app").all(), before);
  assert.deepEqual(db.prepare("SELECT * FROM market_source_runs").all(), beforeRuns);
});
