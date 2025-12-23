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
// 🔹 GET AGENCY (una per utente)
// ======================================================
app.get("/agency/me", async (req, res) => {
  const userId = req.query.user_id;

  if (!userId) {
    return res.status(400).json({ error: "user_id mancante" });
  }

  const { data, error } = await supabase
    .from("agencies")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error) {
    return res.status(404).json({ error: "agenzia non trovata" });
  }

  res.json(data);
});


// ======================================================
// 🔹 START DAILY CHECK (vendita, zona fissa)
// ======================================================
app.post("/run-agency", async (req, res) => {
  try {
    const { agency_id } = req.body;

    if (!agency_id) {
      return res.status(400).json({ error: "agency_id mancante" });
    }

    // 1️⃣ carica agenzia
    const { data: agency, error } = await supabase
      .from("agencies")
      .select("*")
      .eq("id", agency_id)
      .single();

    if (error || !agency) {
      return res.status(404).json({ error: "agenzia non trovata" });
    }

    // 2️⃣ input Apify (solo vendita)
    const actorInput = {
      points: agency.points,
      operation: "vendita",
      ...agency.filters,
      max_items: 2
    };

    console.log("🚀 Avvio Apify per agency", agency.id, actorInput);

    // 3️⃣ avvia run Apify
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      actorInput,
      { headers: { "Content-Type": "application/json" } }
    );

    const runId = runRes.data.data.id;

    // 4️⃣ crea run giornaliera (vuota, verrà aggiornata dal webhook)
    await supabase.from("agency_runs").upsert({
      agency_id: agency.id,
      run_date: new Date().toISOString().slice(0, 10),
      total_listings: 0,
      new_listings: 0
    });

    res.json({ ok: true, runId });
  } catch (err) {
    console.error("❌ ERRORE RUN AGENCY:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});


// ======================================================
// 🔔 APIFY WEBHOOK (CUORE LOGICA NUOVI ANNUNCI)
// ======================================================
app.post("/apify-webhook", async (req, res) => {
  try {
    const runId = req.body?.resource?.id;
    if (!runId) {
      return res.status(400).json({ error: "runId mancante" });
    }

    console.log("🔔 Webhook ricevuto per run:", runId);

    // 1️⃣ recupera run Apify
    const runRes = await axios.get(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );

    const runData = runRes.data.data;
    const datasetId = runData.defaultDatasetId;
    const actorInput = runData.options?.input || {};

    // 2️⃣ trova agenzia tramite points
    const { data: agency, error: agencyErr } = await supabase
      .from("agencies")
      .select("*")
      .eq("points", actorInput.points)
      .single();

    if (agencyErr || !agency) {
      console.error("❌ Agenzia non trovata per run", runId);
      return res.status(404).json({ error: "agenzia non trovata" });
    }

    // 3️⃣ scarica dataset
    const itemsRes = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&token=${APIFY_TOKEN}`
    );

    const items = itemsRes.data;
    let newCount = 0;

    // 4️⃣ processa annunci
    for (const item of items) {
      // UPSERT listings
      await supabase.from("listings").upsert({
        id: item.id,
        title: item.title,
        city: item.city,
        province: item.province,
        price: item.price?.raw ?? null,
        url: item.url,
        raw: item.raw
      });

      // collega a agenzia (NUOVO se non esiste)
      const { error: linkErr } = await supabase
        .from("agency_listings")
        .insert({
          agency_id: agency.id,
          listing_id: item.id
        });

      if (!linkErr) {
        newCount++;
      }
    }

    // 5️⃣ aggiorna run giornaliera
    await supabase
      .from("agency_runs")
      .update({
        total_listings: items.length,
        new_listings: newCount
      })
      .eq("agency_id", agency.id)
      .eq("run_date", new Date().toISOString().slice(0, 10));

    console.log(
      `✅ Agency ${agency.id} – ${newCount} nuovi annunci su ${items.length}`
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ ERRORE WEBHOOK:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});


// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
