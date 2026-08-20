import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://www.sauto.cz";
const TABLE = "vehicle_app";

const options = new Set(process.argv.slice(2));
const DRY_RUN = options.has("--dry-run") || process.env.DRY_RUN === "1";

const LIMIT = Number(process.env.SAUTO_LIMIT || 200);
const MAX_PAGES = Number(process.env.SAUTO_MAX_PAGES || 80);
const DETAIL_CONCURRENCY = Number(process.env.SAUTO_DETAIL_CONCURRENCY || 8);

const GITHUB_REPO = process.env.GITHUB_REPO || "Fojtik82/autoscan-pricing-backend";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || "CarPrice DB Bot";
const GIT_AUTHOR_EMAIL =
  process.env.GIT_AUTHOR_EMAIL || "carprice-db-bot@users.noreply.github.com";
const WORK_REPO_DIR =
  process.env.WORK_REPO_DIR ||
  path.join(os.tmpdir(), "autoscan-pricing-backend-work");

const insertColumns = [
  "brand",
  "model",
  "year",
  "mileage",
  "fuel",
  "motor",
  "price",
  "transmission",
  "drive",
  "vin",
  "kw",
  "body",
  "source_url",
  "source_db",
  "title",
  "brand_norm",
  "model_norm",
  "fuel_norm",
  "transmission_norm",
  "drive_norm",
  "motor_norm",
  "engine_ccm",
  "engine_l",
  "trim_norm",
];

function maskToken(text) {
  if (!GITHUB_TOKEN) return text;
  return String(text).replaceAll(GITHUB_TOKEN, "***");
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd || ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });

  if (result.status !== 0) {
    const safeArgs = args.map(maskToken).join(" ");
    const stderr = maskToken(result.stderr || "");
    const stdout = maskToken(result.stdout || "");
    throw new Error(
      `Command failed: ${command} ${safeArgs}\n${stderr || stdout}`.trim(),
    );
  }

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

function firstYear(...values) {
  for (const value of values) {
    const match = String(value ?? "").match(/\b(19|20)\d{2}\b/);
    if (match) return match[0];
  }
  return null;
}

function asText(value) {
  return value === undefined || value === null || value === ""
    ? null
    : String(value);
}

function spacedCcm(value) {
  if (!value) return null;
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function engineLiters(ccm) {
  if (!ccm) return null;
  return (Math.round((Number(ccm) / 1000) * 10) / 10).toFixed(1);
}

function mapFuel(value) {
  const norm = normalize(value);
  if (norm === "nafta") return "diesel";
  if (norm === "benzin") return "benzin";
  if (norm.includes("elektro")) return "elektro";
  if (norm.includes("hybrid")) return "hybrid";
  if (norm.includes("lpg")) return "lpg";
  if (norm.includes("cng")) return "cng";
  return norm || null;
}

function mapTransmission(value) {
  const norm = normalize(value);
  if (norm.includes("automat")) return "automat";
  if (norm.includes("manual")) return "manual";
  return norm || null;
}

function mapDriveDisplay(value) {
  const norm = normalize(value);
  if (!norm) return null;
  if (norm.includes("4") || norm.includes("vsech")) return "4x4";
  if (norm.includes("pred")) return "Predni";
  if (norm.includes("zad")) return "Zadni";
  return value;
}

function mapDriveNorm(value) {
  const display = mapDriveDisplay(value);
  if (display === "4x4") return "4x4";
  if (display === "Predni") return "fwd";
  if (display === "Zadni") return "rwd";
  return normalize(value) || null;
}

function sourceUrl(item) {
  const brand = item.manufacturer_cb?.seo_name;
  const model = item.model_cb?.seo_name;
  if (!brand || !model || !item.id) return null;
  return `${BASE}/osobni/detail/${brand}/${model}/${item.id}`;
}

function buildMotor(detail) {
  const parts = [];
  if (detail.additional_model_name) parts.push(detail.additional_model_name);
  const specs = [];
  if (detail.engine_volume) {
    specs.push(`${spacedCcm(detail.engine_volume)} ccm`);
  }
  if (detail.engine_power) {
    const hp = Math.round(Number(detail.engine_power) * 1.35962);
    specs.push(`${detail.engine_power} kW (${hp} koni)`);
  }
  if (detail.fuel_cb?.name) specs.push(detail.fuel_cb.name);
  if (specs.length) parts.push(specs.join(" / "));
  return parts.join(" / ") || null;
}

function extractTrim(detail) {
  const text = normalize(detail.additional_model_name);
  const known = [
    "Sportline",
    "Elegance",
    "Style",
    "Ambition",
    "Selection",
    "Exclusive",
    "Life",
    "Advanced",
    "Progressive",
    "Xperience",
    "Business",
    "Active",
    "Comfortline",
    "Highline",
    "Trendline",
    "Executive",
    "FR",
    "RS",
  ];
  return known.find((trim) => text.includes(normalize(trim))) ?? null;
}

function toRow(detail) {
  const brand = detail.manufacturer_cb?.name ?? null;
  const model = detail.model_cb?.name ?? null;
  const fuel = detail.fuel_cb?.name ?? null;
  const transmission = detail.gearbox_cb?.name ?? null;
  const motor = buildMotor(detail);
  const url = sourceUrl(detail);

  return {
    brand,
    model,
    year: firstYear(detail.manufacturing_date, detail.in_operation_date),
    mileage: asText(detail.tachometer),
    fuel,
    motor,
    price: asText(detail.price),
    transmission,
    drive: mapDriveDisplay(detail.drive_cb?.name),
    vin: asText(detail.vin),
    kw: asText(detail.engine_power),
    body: detail.vehicle_body_cb?.name ?? null,
    source_url: url,
    source_db: "sauto_1den_cloud",
    title:
      detail.name ??
      [brand, model, detail.additional_model_name].filter(Boolean).join(" "),
    brand_norm: normalize(brand),
    model_norm: normalize(model),
    fuel_norm: mapFuel(fuel),
    transmission_norm: mapTransmission(transmission),
    drive_norm: mapDriveNorm(detail.drive_cb?.name),
    motor_norm: normalize(motor),
    engine_ccm: asText(detail.engine_volume),
    engine_l: engineLiters(detail.engine_volume),
    trim_norm: extractTrim(detail),
  };
}

async function fetchJson(url, attempt = 1) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "accept-language": "cs",
      "user-agent": "Mozilla/5.0 CarPrice cloud daily updater",
    },
  });

  if (!response.ok) {
    if (attempt < 3 && [429, 500, 502, 503, 504].includes(response.status)) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }

  return response.json();
}

function listUrl(offset) {
  const params = new URLSearchParams({
    limit: String(LIMIT),
    offset: String(offset),
    item_age_seo: "1-den",
    condition_seo: "nove,ojete,predvadeci",
    category_id: "838",
    operating_lease: "false",
  });
  return `${BASE}/api/v1/items/search?${params.toString()}`;
}

async function fetchList() {
  const all = [];
  let total = null;
  let pages = 0;

  for (let offset = 0; total === null || offset < total; offset += LIMIT) {
    if (pages >= MAX_PAGES) break;
    let data;
    try {
      data = await fetchJson(listUrl(offset));
    } catch (error) {
      if (String(error.message).startsWith("422 ") && offset >= 10000) {
        console.log(`list stopped at offset ${offset}; Sauto API refuses deeper paging`);
        break;
      }
      throw error;
    }

    total = data.pagination?.total ?? data.results?.length ?? 0;
    all.push(...(data.results ?? []));
    pages += 1;
    console.log(`list ${Math.min(offset + LIMIT, total)}/${total}`);
  }

  return all;
}

async function fetchDetail(id) {
  const data = await fetchJson(`${BASE}/api/v1/items/${id}`);
  return data.result;
}

function prepareRepo() {
  if (process.env.SKIP_GIT === "1") {
    return ROOT;
  }

  if (!GITHUB_TOKEN) {
    if (!fs.existsSync(path.join(ROOT, ".git"))) {
      throw new Error(
        "GITHUB_TOKEN is required on Render, or run this from a git checkout.",
      );
    }
    run("git", ["fetch", "origin", GITHUB_BRANCH], { cwd: ROOT });
    run("git", ["pull", "--ff-only", "origin", GITHUB_BRANCH], { cwd: ROOT });
    return ROOT;
  }

  fs.rmSync(WORK_REPO_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(WORK_REPO_DIR), { recursive: true });
  const remote = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
  run("git", ["clone", "--depth", "1", "--branch", GITHUB_BRANCH, remote, WORK_REPO_DIR], {
    cwd: ROOT,
  });
  return WORK_REPO_DIR;
}

function loadExistingUrls(db) {
  if (!DRY_RUN) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_source_url ON ${TABLE}(source_url)`);
  }
  const rows = db
    .prepare(
      `SELECT source_url FROM ${TABLE}
       WHERE source_url IS NOT NULL
         AND TRIM(source_url) <> ''
         AND source_url LIKE '%sauto.cz%'`,
    )
    .all();
  return new Set(rows.map((row) => row.source_url));
}

async function scrapeNewRows(existingUrls) {
  const items = await fetchList();
  const seen = new Set();
  const candidates = items
    .map((item) => ({ item, url: sourceUrl(item) }))
    .filter(({ url }) => url && !existingUrls.has(url) && !seen.has(url) && seen.add(url));

  console.log(`existing_urls=${existingUrls.size}`);
  console.log(`scraped_list=${items.length}`);
  console.log(`new_candidates=${candidates.length}`);

  const rows = [];
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const detail = await fetchDetail(candidates[index].item.id);
      const row = toRow(detail);
      if (row.source_url && !existingUrls.has(row.source_url)) rows.push(row);
      done += 1;
      if (done % 50 === 0 || done === candidates.length) {
        console.log(`details ${done}/${candidates.length}`);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(DETAIL_CONCURRENCY, candidates.length) },
      () => worker(),
    ),
  );

  return rows;
}

function insertRows(db, rows) {
  if (!rows.length) return 0;

  const placeholders = insertColumns.map(() => "?").join(", ");
  const stmt = db.prepare(
    `INSERT INTO ${TABLE} (${insertColumns.map((col) => `"${col}"`).join(", ")})
     VALUES (${placeholders})`,
  );

  const insert = db.transaction((incomingRows) => {
    let inserted = 0;
    for (const row of incomingRows) {
      const info = stmt.run(insertColumns.map((column) => row[column] ?? null));
      inserted += info.changes;
    }
    return inserted;
  });

  return insert(rows);
}

function commitAndPush(repoDir) {
  run("git", ["config", "user.name", GIT_AUTHOR_NAME], { cwd: repoDir });
  run("git", ["config", "user.email", GIT_AUTHOR_EMAIL], { cwd: repoDir });

  const status = run("git", ["status", "--porcelain", "--", "data/vehicles_ai.db"], {
    cwd: repoDir,
  }).stdout.trim();

  if (!status) {
    return { pushed: false, commit: null, reason: "no_git_change" };
  }

  if (DRY_RUN) {
    return { pushed: false, commit: null, reason: "dry_run" };
  }

  run("git", ["add", "data/vehicles_ai.db"], { cwd: repoDir });
  const message = `Cloud update vehicles_ai.db ${new Date().toISOString().slice(0, 16)}`;
  run("git", ["commit", "-m", message], { cwd: repoDir });
  const commit = run("git", ["rev-parse", "--short", "HEAD"], { cwd: repoDir }).stdout.trim();
  run("git", ["push", "origin", `HEAD:${GITHUB_BRANCH}`], { cwd: repoDir });

  return { pushed: true, commit, reason: "pushed" };
}

async function main() {
  const startedAt = new Date().toISOString();
  const repoDir = prepareRepo();
  const dbPath = path.join(repoDir, "data", "vehicles_ai.db");

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const db = new Database(dbPath, DRY_RUN ? { readonly: true } : {});
  if (!DRY_RUN) {
    db.pragma("journal_mode = DELETE");
  }

  const beforeCount = db.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`).get().count;
  const existingUrls = loadExistingUrls(db);
  const rows = await scrapeNewRows(existingUrls);
  const insertedRows = DRY_RUN ? 0 : insertRows(db, rows);
  const afterCount = db.prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`).get().count;
  db.close();

  const gitResult = commitAndPush(repoDir);

  const summary = {
    ok: true,
    dry_run: DRY_RUN,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    repo: GITHUB_REPO,
    branch: GITHUB_BRANCH,
    db_path: dbPath,
    before_count: beforeCount,
    after_count: afterCount,
    scraped_new_rows: rows.length,
    inserted_rows: insertedRows,
    pushed: gitResult.pushed,
    commit: gitResult.commit,
    result: gitResult.reason,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(maskToken(error.stack || error.message || error));
  process.exit(1);
});
