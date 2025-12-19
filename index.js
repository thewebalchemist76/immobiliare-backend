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
    const search = req.body;
    console.log("🔍 Nuova ricerca ricevuta:", search);

    // INPUT CONFORME A INPUT_SCHEMA
    const actorInput = {
      municipality: search.municipality,
      operation: search.operation || "vendita",
      min_price: search.min_price ?? null,
      max_price: search.max_price ?? null,
      max_items: search.max_items ?? 1,
    };

    // 1️⃣ Avvia Actor
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      actorInput,
      { headers: { "Content-Type": "application/json" } }
    );

    const runId = runRes.data.data.id;
    console.log("🚀 Run avviato:", runId);

    // 2️⃣ Polling run
    let runStatus = "RUNNING";
    let runData;

    while (runStatus === "RUNNING" || runStatus === "READY") {
      await new Promise((r) => setTimeout(r, 3000));

      const statusRes = await axios.get(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
      );

      runData = statusRes.data.data;
      runStatus = runData.status;

      console.log("⏳ Polling run:", runId, runStatus);
    }

    if (runStatus !== "SUCCEEDED") {
      throw new Error(`Run fallito: ${runStatus}`);
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
    const { data: searchRow, error: searchError } = await supabase
      .from("searches")
      .insert({
        query: actorInput,
        run_id: runId,
      })
      .select()
      .single();

    if (searchError) throw searchError;

    // 5️⃣ Salva annunci
    for (const item of items) {
      await supabase.from("listings").upsert({
        id: item.id,
        title: item.title,
        city: item.city,
        province: item.province,
        price: item.price?.raw ?? null,
        url: item.url,
        raw: item.raw,
      });

      await supabase.from("search_results").insert({
        search_id: searchRow.id,
        listing_id: item.id,
      });
    }

    res.json({ ok: true, runId, results: items.length });
  } catch (err) {
    console.error("❌ ERRORE SEARCH:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
