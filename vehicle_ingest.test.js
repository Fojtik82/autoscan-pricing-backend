import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { initVehicleIngestDb, isAuthorizedIngestRequest } from "./vehicle_ingest.js";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function requestJson(port, authorization, records) {
  const payload = JSON.stringify({ records });
  return new Promise((resolve) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/vehicle-ai/upsert",
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
      }));
    });
    request.on("error", (error) => resolve({ status: 0, body: { error: error.message } }));
    request.end(payload);
  });
}

function getJson(port, requestPath) {
  return new Promise((resolve) => {
    http.get({ hostname: "127.0.0.1", port, path: requestPath }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
      }));
    }).on("error", (error) => resolve({ status: 0, body: { error: error.message } }));
  });
}

test("authenticated anonymous observations upsert without account data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "carprice-ingest-"));
  const dbPath = path.join(root, "vehicles_ai.db");
  try {
    assert.equal(isAuthorizedIngestRequest("Bearer shared-secret", "shared-secret"), true);
    assert.equal(isAuthorizedIngestRequest("Bearer wrong", "shared-secret"), false);
    const ingest = initVehicleIngestDb(dbPath);
    const base = {
      vin: "TMBJJ7NE0J0123456",
      brand: "Skoda",
      model: "Octavia",
      year: 2020,
      equipment: "Adaptivni tempomat",
      tenant_id: "dealer-a",
      customer_name: "Zakaznik",
      seller_name: "Prodavajici",
      source_url: "https://example.invalid/private",
    };
    assert.deepEqual(ingest.upsert([
      { ...base, source_db: "caroffice-anonymized-vehicle" },
      { ...base, source_db: "caroffice-anonymized-purchase", price: 250000 },
      { ...base, source_db: "caroffice-anonymized-asking", price: 400000 },
      { ...base, source_db: "caroffice-anonymized-sold", price: 380000 },
    ]), { upserted: 4, rejected: 0 });
    assert.deepEqual(ingest.upsert([
      { ...base, source_db: "caroffice-anonymized-asking", price: 410000 },
    ]), { upserted: 1, rejected: 0 });
    ingest.close();

    const db = new Database(dbPath, { readonly: true });
    const columns = db.prepare("PRAGMA table_info(vehicle_app)").all().map((row) => row.name);
    const rows = db.prepare("SELECT * FROM vehicle_app ORDER BY source_db").all();
    db.close();
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => row.source_url === ""));
    assert.equal(rows.find((row) => row.source_db === "caroffice-anonymized-asking").price, "410000");
    for (const forbidden of ["tenant_id", "user_id", "customer_name", "seller_name", "account_id"]) {
      assert.ok(!columns.includes(forbidden));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP ingest endpoint rejects a wrong key and accepts the shared key", { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "carprice-http-ingest-"));
  const dbPath = path.join(root, "vehicles_ai.db");
  const bootstrap = initVehicleIngestDb(dbPath);
  bootstrap.close();
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve("server.js")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      VEHICLES_DB_PATH: dbPath,
      SQLITE_PATH: path.join(root, "vin-cache.db"),
      VEHICLE_INGEST_API_KEY: "shared-secret",
    },
    windowsHide: true,
    stdio: "ignore",
  });
  const record = {
    vin: "TMBJJ7NE0J0123456",
    brand: "Skoda",
    model: "Octavia",
    year: 2020,
    source_db: "caroffice-anonymized-asking",
    price: 400000,
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const probe = await requestJson(port, "Bearer wrong", [record]);
      if (probe.status === 401) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    const denied = await requestJson(port, "Bearer wrong", [record]);
    assert.equal(denied.status, 401);
    const accepted = await requestJson(port, "Bearer shared-secret", [record]);
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, { ok: true, upserted: 1, rejected: 0 });
    const comps = await getJson(port, "/comps?brand=Skoda&model=Octavia&year=2020&limit=5");
    assert.equal(comps.status, 200);
    assert.ok(Array.isArray(comps.body));
    assert.equal(comps.body[0]?.price_czk, 400000);
    assert.equal(comps.body[0]?.source, "caroffice-anonymized-asking");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
