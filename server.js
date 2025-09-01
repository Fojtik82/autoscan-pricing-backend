import express from "express";
import cors from "cors";
import { OpenAI } from "openai";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: "*", methods: ["POST", "GET", "OPTIONS"] }));
app.use((req, res, next) => { req.setTimeout(90_000); res.setTimeout(90_000); next(); });

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function extractJsonSafely(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s !== -1 && e !== -1 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch {}
  }
  return null;
}

function buildPrompt(p) {
  const { brand, model, year, mileage, fuel, engine, comparables, vin } = p;
  return `
Jsi odborník na oceňování ojetých vozů v ČR. Vrať **pouze JSON**:
{
  "price_estimate": number,
  "low": number,
  "high": number,
  "reasoning": string,
  "used_data": { "brand": string, "model": string, "year": number, "mileage": number, "fuel": string, "engine": string, "vin": string | null }
}
Ceny v Kč (jen čísla). Zohledni "comparables", pokud jsou.

Vstup:
- VIN: ${vin || "—"}
- Vozidlo: ${brand || ""} ${model || ""}, rok ${year || ""}, nájezd ${mileage || ""} km, palivo: ${fuel || ""}, motor: ${engine || ""}

Comparables:
${JSON.stringify(p.comparables || [], null, 2)}
`.trim();
}

async function withRetry(fn, { retries = 2, delayMs = 800 } = {}) {
  let err;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) { err = e; if (i === retries) break; await new Promise(r => setTimeout(r, delayMs)); }
  }
  throw err;
}

app.get("/", (_req, res) => res.json({ ok: true, service: "AutoScan Pricing Backend", version: "1.0.0" }));

app.post("/estimate", async (req, res) => {
  const { brand = "", model = "", year = null, mileage = null, fuel = "", engine = "", comparables = [], vin = null } = req.body || {};
  if (!brand || !model) return res.status(400).json({ error: "Missing required fields: brand, model" });

  const prompt = buildPrompt({ brand, model, year, mileage, fuel, engine, comparables, vin });

  try {
    const response = await withRetry(async () => {
      return await openai.responses.create({
        model: "gpt-4o-mini",
        input: prompt,
        temperature: 0.3,
        max_output_tokens: 600,
      });
    });

    const content =
      response?.output?.[0]?.content?.[0]?.text ??
      response?.output_text ??
      response?.choices?.[0]?.message?.content ??
      "";

    const parsed = extractJsonSafely(content);
    if (!parsed || typeof parsed !== "object") {
      return res.status(502).json({ error: "Failed to parse model output", raw: content?.slice?.(0, 2000) || null });
    }

    const result = {
      price_estimate: Number(parsed.price_estimate ?? 0),
      low: Number(parsed.low ?? 0),
      high: Number(parsed.high ?? 0),
      reasoning: String(parsed.reasoning ?? ""),
      used_data: {
        brand: String(parsed?.used_data?.brand ?? brand ?? ""),
        model: String(parsed?.used_data?.model ?? model ?? ""),
        year: Number(parsed?.used_data?.year ?? year ?? 0),
        mileage: Number(parsed?.used_data?.mileage ?? mileage ?? 0),
        fuel: String(parsed?.used_data?.fuel ?? fuel ?? ""),
        engine: String(parsed?.used_data?.engine ?? engine ?? ""),
        vin: parsed?.used_data?.vin ?? vin ?? null,
      },
    };
    ["price_estimate", "low", "high"].forEach(k => { if (!Number.isFinite(result[k])) result[k] = 0; });

    res.json(result);
  } catch (e) {
    console.error("OpenAI error:", e?.response?.data || e?.message || e);
    res.status(500).json({ error: "OpenAI request failed", detail: e?.response?.data || e?.message || "Unknown error" });
  }
});

app.listen(PORT, () => console.log(`AutoScan Pricing Backend listening on port ${PORT}`));
