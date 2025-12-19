const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// ===== Supabase =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ===== Apify =====
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR_ID = process.env.APIFY_ACTOR_ID;

// health check
app.get("/", (req, res) => {
  res.json({ status: "backend ok" });
});

// ===== SEARCH =====
app.post("/search", async (req, res) => {
  try {
    const input = req.body;
    console.log("🔍 Nuova ricerca ricevuta:", input);

    // normalizza input per Apify
    const actorInput = {
      municipality: input.municipality,
      operation: input.operation || "vendita",
      min_price:
        input.min_price === null || input.min_price === undefined
          ? 0
          : Number(input.min_price),
      max_price:
        input.max_price === null || input.max_price === undefined
          ? 999999999
          : Number(input.max_price),
      max_items: input.max_items || 1,
    };

    // 1️⃣ Avvia Actor
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      actorInput
    );

    const runId = runRes.data.data.id;
    console.log("🚀 Run avviato:", runId);

    // 2️⃣ Polling
    let status = "RUNNING";
    let runData;

    while (status === "RUNNING" || status === "READY") {
      await new Promise((r) => setTimeout(r, 3000));

      const s = await axios.get(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
      );

      runData = s.data.data;
      status = runData.status;
      console.log("⏳ Polling run:", runId, status);
    }

    if (status !== "SUCCEEDED") {
      throw new Error(`Run fallito: ${status}`);
    }

    console.log("✅ Run completato:", runId);

    // 3️⃣ Dataset
    const datasetId = runData.defaultDatasetId;
    const itemsRes = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&token=${APIFY_TOKEN}`
    );

    const items = itemsRes.data;
    console.log(`📦 Risultati: ${items.length}`);

    // 4️⃣ Salva ricerca
    const { data: searchRow, error: searchErr } = await supabase
      .from("searches")
      .insert({
        query: actorInput,
        run_id: runId,
      })
      .select()
      .single();

    if (searchErr) throw searchErr;

    // 5️⃣ Salva annunci
    for (const item of items) {
      const geo = item.raw?.geography || {};

      const listing = {
        id: item.id,
        title: item.title,
        city: geo.municipality?.name ?? null,
        province: geo.province?.name ?? null,
        price: item.price?.raw ?? null,
        url: item.url,
        raw: item.raw,
      };

      const { error: listingErr } = await supabase
        .from("listings")
        .upsert(listing);

      if (listingErr) {
        console.error("❌ ERRORE LISTING:", listingErr);
        continue;
      }

      const { error: relErr } = await supabase
        .from("search_results")
        .insert({
          search_id: searchRow.id,
          listing_id: item.id,
        });

      if (relErr) {
        console.error("❌ ERRORE SEARCH_RESULTS:", relErr);
      }
    }

    res.json({
      ok: true,
      runId,
      results: items.length,
    });
  } catch (err) {
    console.error("❌ ERRORE SEARCH:", err);
    res.status(500).json({ error: err.message });
  }
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
