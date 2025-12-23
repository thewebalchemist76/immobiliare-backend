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
  try {
    const userId = req.query.user_id;

    if (!userId) {
      return res.status(400).json({ error: "user_id mancante" });
    }

    const { data, error } = await supabase
      .from("agencies")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "agenzia non trovata" });
    }

    res.json(data);
  } catch (err) {
    console.error("❌ ERRORE GET AGENCY:", err.message);
    res.status(500).json({ error: err.message });
  }
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

    // 2️⃣ CREA agency_run SUBITO (evita race condition)
    const { data: agencyRun, error: runErr } = await supabase
      .from("agency_runs")
      .insert({
        agency_id: agency.id,
        run_date: new Date().toISOString().slice(0, 10),
        new_listings_count: 0,
      })
      .select()
      .single();

    if (runErr) throw runErr;

    // 3️⃣ input Apify (solo vendita)
    const actorInput = {
      points: agency.points,
      operation: "vendita",
      ...(agency.filters || {}),
      max_items: 2,
    };

    console.log("🚀 Avvio Apify per agency", agency.id, actorInput);

    // 4️⃣ avvia run Apify
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      actorInput,
      { headers: { "Content-Type": "application/json" } }
    );

    const runId = runRes.data.data.id;

    // 5️⃣ collega agency_run al run Apify
    await supabase
      .from("agency_runs")
      .update({ apify_run_id: runId })
      .eq("id", agencyRun.id);

    res.json({ ok: true, runId });
  } catch (err) {
    console.error("❌ ERRORE RUN AGENCY:", err.response?.data || err.message);
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

    console.log("🔔 Webhook Apify ricevuto per run:", runId);

    // 1️⃣ trova agency_run
    const { data: agencyRun, error: runErr } = await supabase
      .from("agency_runs")
      .select("*")
      .eq("apify_run_id", runId)
      .single();

    if (runErr || !agencyRun) {
      console.error("❌ agency_run non trovato per run:", runId);
      return res.status(404).json({ error: "agency_run non trovato" });
    }

    const agencyId = agencyRun.agency_id;

    // 2️⃣ recupera dataset Apify
    const runRes = await axios.get(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );

    const datasetId = runRes.data.data.defaultDatasetId;

    const itemsRes = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&token=${APIFY_TOKEN}`
    );

    const items = itemsRes.data || [];
    console.log(`📦 ${items.length} annunci ricevuti`);

    let newCount = 0;

    // 3️⃣ processa annunci
    for (const item of items) {
      // salva listing globale
      await supabase.from("listings").upsert({
        id: item.id,
        title: item.title,
        city: item.city,
        province: item.province,
        price: item.price?.raw ?? null,
        url: item.url,
        raw: item.raw,
      });

      // collega a agenzia se nuovo
      const { data: existing } = await supabase
        .from("agency_listings")
        .select("listing_id")
        .eq("agency_id", agencyId)
        .eq("listing_id", item.id)
        .maybeSingle();

      if (!existing) {
        await supabase.from("agency_listings").insert({
          agency_id: agencyId,
          listing_id: item.id,
        });
        newCount++;
      }
    }

    // 4️⃣ aggiorna contatore nuovi annunci
    await supabase
      .from("agency_runs")
      .update({ new_listings_count: newCount })
      .eq("id", agencyRun.id);

    console.log(`✅ Agency run ${agencyRun.id}: ${newCount} annunci nuovi`);

    res.json({ ok: true, new_listings_count: newCount });
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
