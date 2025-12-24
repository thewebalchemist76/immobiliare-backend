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
app.get("/", (_req, res) => {
  res.json({ status: "backend ok" });
});

// ======================================================
// 🔹 START AGENCY RUN
// ======================================================
app.post("/run-agency", async (req, res) => {
  try {
    const { agency_id } = req.body;
    if (!agency_id) {
      return res.status(400).json({ error: "agency_id mancante" });
    }

    const { data: agency, error } = await supabase
      .from("agencies")
      .select("*")
      .eq("id", agency_id)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: "agenzia non trovata" });
    }

    const actorInput = {
      points: agency.points,
      operation: "vendita",
      max_items: 2,
    };

    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      actorInput,
      { headers: { "Content-Type": "application/json" } }
    );

    const runId = runRes.data.data.id;

    // 🔑 salva il run ID sull'agenzia (CHIAVE)
    await supabase
      .from("agencies")
      .update({ last_apify_run_id: runId })
      .eq("id", agency.id);

    // log run
    await supabase.from("agency_runs").insert({
      agency_id: agency.id,
      apify_run_id: runId,
      run_started_at: new Date().toISOString(),
      new_listings_count: 0,
    });

    res.json({ ok: true, runId });
  } catch (err) {
    console.error("❌ RUN AGENCY:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 🔔 APIFY WEBHOOK
// ======================================================
app.post("/apify-webhook", async (req, res) => {
  try {
    const runId = req.body?.resource?.id;
    if (!runId) {
      return res.status(400).json({ error: "runId mancante" });
    }

    console.log("🔔 Webhook ricevuto:", runId);

    // 1️⃣ trova agenzia dal run
    const { data: agency, error } = await supabase
      .from("agencies")
      .select("*")
      .eq("last_apify_run_id", runId)
      .single();

    if (error || !agency) {
      console.warn("⚠️ Agenzia non trovata per run", runId);
      return res.json({ ok: true });
    }

    // 2️⃣ dataset
    const runRes = await axios.get(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );

    const datasetId = runRes.data.data.defaultDatasetId;

    const itemsRes = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&token=${APIFY_TOKEN}`
    );

    const items = itemsRes.data;
    let newCount = 0;

    for (const item of items) {
      // listings globali
      await supabase.from("listings").upsert({
        id: item.id,
        title: item.title,
        city: item.city,
        province: item.province,
        price: item.price?.raw ?? null,
        url: item.url,
        raw: item.raw,
      });

      // relazione agenzia-annuncio
      const { data: exists } = await supabase
        .from("agency_listings")
        .select("listing_id")
        .eq("agency_id", agency.id)
        .eq("listing_id", item.id)
        .maybeSingle();

      if (!exists) {
        await supabase.from("agency_listings").insert({
          agency_id: agency.id,
          listing_id: item.id,
        });
        newCount++;
      }
    }

    // aggiorna ultimo run
    await supabase
      .from("agency_runs")
      .update({
        new_listings_count: newCount,
        run_completed_at: new Date().toISOString(),
      })
      .eq("apify_run_id", runId);

    console.log(`✅ ${newCount} nuovi annunci`);

    res.json({ ok: true, newCount });
  } catch (err) {
    console.error("❌ WEBHOOK:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
