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
// ▶️ RUN AGENCY
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

    // ✅ salva SEMPRE il run (senza leggere id di ritorno)
    await supabase.from("agency_runs").insert({
      agency_id: agency.id,
      apify_run_id: runId,
      new_listings_count: 0,
      run_started_at: new Date().toISOString(),
    });

    res.json({ ok: true, apify_run_id: runId });
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
    if (!runId) return res.json({ ok: true });

    console.log("🔔 Webhook ricevuto:", runId);

    // 1️⃣ trova run
    const { data: runs } = await supabase
      .from("agency_runs")
      .select("*")
      .eq("apify_run_id", runId)
      .limit(1);

    if (!runs || runs.length === 0) {
      console.warn("⚠️ agency_run non trovato per run", runId);
      return res.json({ ok: true });
    }

    const run = runs[0];

    // 2️⃣ carica agenzia
    const { data: agency } = await supabase
      .from("agencies")
      .select("*")
      .eq("id", run.agency_id)
      .single();

    // 3️⃣ dataset Apify
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
        first_seen_at: new Date().toISOString(),
      });

      // collegamento run → listing (SEMPRE)
      await supabase.from("agency_run_listings").upsert({
        run_id: run.id,
        listing_id: item.id,
      });

      // collegamento agenzia → listing (solo se nuovo)
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

    // 4️⃣ aggiorna run
    await supabase
      .from("agency_runs")
      .update({
        new_listings_count: newCount,
        run_completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);

    console.log(`✅ ${newCount} nuovi annunci`);

    res.json({ ok: true });
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
