const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// ================= SUPABASE =================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ================= APIFY =================
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR_ID = process.env.APIFY_ACTOR_ID;

// ================= HEALTH =================
app.get("/", (req, res) => {
  res.json({ status: "backend ok" });
});

// ================= SEARCH =================
app.post("/search", async (req, res) => {
  try {
    const input = req.body;
    console.log("🔍 Nuova ricerca ricevuta:", input);

    // 1️⃣ Normalizza input per Apify
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

    // 2️⃣ Avvia Actor
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      actorInput,
      { headers: { "Content-Type": "application/json" } }
    );

    const runId = runRes.data.data.id;
    console.log("🚀 Run avviato:", runId);

    // 3️⃣ Polling stato run
    let status = "RUNNING";
    let runData;

    while (status === "RUNNING" || status === "READY") {
      await new Promise((r) => setTimeout(r, 3000));

      const statusRes = await axios.get(
        `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
      );

      runData = statusRes.data.data;
      status = runData.status;
      console.log("⏳ Polling run:", runId, status);
    }

    if (status !== "SUCCEEDED") {
      throw new Error(`Run fallito: ${status}`);
    }

    console.log("✅ Run completato:", runId);

    // 4️⃣ Leggi dataset
    const datasetId = runData.defaultDatasetId;
    const itemsRes = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&token=${APIFY_TOKEN}`
    );

    const items = itemsRes.data;
    console.log(`📦 Risultati: ${items.length}`);

    // 5️⃣ Salva ricerca
    const { data: searchRow, error: searchErr } = await supabase
      .from("searches")
      .insert({
        user_id: input.user_id,
        query: actorInput,
        run_id: runId,
      })
      .select()
      .single();

    if (searchErr) throw searchErr;

    // 6️⃣ Salva annunci + relazione
    for (const item of items) {
      const { error: listingErr } = await supabase
        .from("listings")
        .upsert({
          id: item.id,
          title: item.title,
          city: item.city,
          province: item.province,
          price: item.price?.raw ?? null,
          url: item.url,
          raw: item.raw,
        });

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

    // 7️⃣ Response
    res.json({
      ok: true,
      searchId: searchRow.id,
      runId,
      results: items.length,
    });
  } catch (err) {
    console.error("❌ ERRORE SEARCH:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
