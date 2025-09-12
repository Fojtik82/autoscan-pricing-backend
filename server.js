import express from "express";
import cors from "cors";
import OpenAI from "openai";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EUR_RATE = Number(process.env.EUR_RATE ?? 24.5);

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: "*", methods: ["POST", "GET", "OPTIONS"] }));
app.use((req, res, next) => { req.setTimeout(90_000); res.setTimeout(90_000); next(); });

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ----------------- helpers ----------------- */
function buildPrompt(p) {
  const { brand, model, year, mileage, fuel, engine, comparables, vin } = p;
  return `
Jsi odborník na oceňování ojetých vozů v ČR.
Vrať **pouze JSON** tohoto tvaru (bez dalšího textu a bez markdownu):

{
  "price_estimate": number,   // odhad v CZK
  "low": number,              // dolní hranice v CZK
  "high": number,             // horní hranice v CZK
  "reasoning": string,        // 1–2 věty
  "used_data": {
    "brand": string, "model": string, "year": number,
    "mileage": number, "fuel": string, "engine": string, "vin": string | null
  }
}

CENY MUSÍ BÝT V CZK. Pokud uvažuješ v EUR, převeď do CZK kurzem ${EUR_RATE} CZK/EUR.
Pole musí být vyplněna čísly/řetězci dle schématu (žádná "N/A"). Nepřidávej další klíče.

Vstup:
- VIN: ${vin || "—"}
- Vozidlo: ${brand || ""} ${model || ""}, rok ${year || ""}, nájezd ${mileage || ""} km, palivo: ${fuel || ""}, motor: ${engine || ""}

Comparables (pokud jsou k dispozici, použij je):
${JSON.stringify(comparables || [], null, 2)}
`.trim();
}

function safeNumber(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

function parseJsonStrict(text) {
  // nechceme řešit ```json ... ```
  try { return JSON.parse(text); } catch { return null; }
}

/* ----------------- endpoints ----------------- */

// info + rychlý check
app.get("/", (_req, res) =>
  res.json({ ok: true, service: "AutoScan Pricing Backend", version: "1.1.0", eur_rate: EUR_RATE })
);

// health endpoint pro Render
app.get("/healthz", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// hlavní endpoint pro odhad (ChatGPT)
app.post("/estimate", async (req, res) => {
  const {
    brand = "", model = "", year = null, mileage = null,
    fuel = "", engine = "", comparables = [], vin = null
  } = req.body || {};

  if (!brand || !model) {
    return res.status(400).json({ error: "Missing required fields: brand, model" });
  }

  const prompt = buildPrompt({ brand, model, year, mileage, fuel, engine, comparables, vin });

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 250,
      response_format: { type: "json_object" }, // <- vynutí čistý JSON
      messages: [
        { role: "system", content: "Jsi odhadce cen ojetých aut v ČR. Vracej přesně JSON dle instrukcí uživatele." },
        { role: "user", content: prompt }
      ]
    });

    const text = resp.choices?.[0]?.message?.content ?? "";
    const parsed = parseJsonStrict(text);

    if (!parsed || typeof parsed !== "object") {
      console.error("Parse error: raw:", text?.slice?.(0, 1000));
      return res.status(502).json({ error: "Failed to parse model output", raw: text?.slice?.(0, 1000) || null });
    }

    const result = {
      price_estimate: safeNumber(parsed.price_estimate),
      low: safeNumber(parsed.low),
      high: safeNumber(parsed.high),
      reasoning: String(parsed.reasoning ?? ""),
      used_data: {
        brand: String(parsed?.used_data?.brand ?? brand ?? ""),
        model: String(parsed?.used_data?.model ?? model ?? ""),
        year: safeNumber(parsed?.used_data?.year ?? year),
        mileage: safeNumber(parsed?.used_data?.mileage ?? mileage),
        fuel: String(parsed?.used_data?.fuel ?? fuel ?? ""),
        engine: String(parsed?.used_data?.engine ?? engine ?? ""),
        vin: parsed?.used_data?.vin ?? vin ?? null
      }
    };

    // sanity check
    ["price_estimate", "low", "high"].forEach(k => { if (!Number.isFinite(result[k]) || result[k] < 0) result[k] = 0; });

    res.json(result);
  } catch (e) {
    // detailní logy do Render Logs
    const detail = e?.response?.data || e?.message || e;
    console.error("OpenAI error in /estimate:", detail);
    res.status(500).json({ error: "OpenAI request failed", detail });
  }
});

// start
app.listen(PORT, () => console.log(`AutoScan Pricing Backend listening on port ${PORT}`));
