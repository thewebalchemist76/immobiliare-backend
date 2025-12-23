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

  if (error || !data) {
    return res.status(404).json({ error: "agenzia non trovata" });
  }

  res.json(data);
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
      ...(agency.filters || {}),
      max_items: 2,
    };

    console.log("🚀 Avvio Apify per agency", agency.id, actorInput);

    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      actorInput,
      { headers: { "Content-Type": "application/json" } }
    );

    const runId = runRes.data.data.id;

    await supabase.from("agency_runs").insert({
      agency_id: agency.id,
      apify_run_id: runId,
      run_started_at: new Date().toISOString(),
      new_listings_count: 0,
    });

    res.json({ ok: true, runId });
  } catch (err) {
    console.error("❌ ERRORE RUN AGENCY:", err.message);
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

    // 1️⃣ recupera agency_run (se esiste)
    const { data: agencyRun } = await supabase
      .from("agency_runs")
      .select("*")
      .eq("apify_run_id", runId)
      .maybeSingle();

    if (!agencyRun) {
      console.warn("⚠️ agency_run non trovato, continuo comunque");
    }

    const agencyId = agencyRun?.agency_id;
    if (!agencyId) {
      return res.status(200).json({ ok: true, skipped: true });
    }

    // 2️⃣ dataset Apify
    const runRes = await axios.get(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );

    const datasetId = runRes.data.data.defaultDatasetId;

    const itemsRes = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&token=${APIFY_TOKEN}`
    );

    const items = itemsRes.data;
    console.log(`📦 ${items.length} annunci ricevuti`);

    let newCount = 0;

    // 3️⃣ salva annunci + collega all’agenzia
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

      // relazione agency_listings
      const { error: linkErr } = await supabase
        .from("agency_listings")
        .insert({
          agency_id: agencyId,
          listing_id: item.id,
        });

      if (!linkErr) {
        newCount++;
      }
    }

    // 4️⃣ aggiorna contatore run
    if (agencyRun) {
      await supabase
        .from("agency_runs")
        .update({ new_listings_count: newCount })
        .eq("id", agencyRun.id);
    }

    console.log(`✅ ${newCount} annunci nuovi collegati all’agenzia`);

    res.json({ ok: true, new_listings_count: newCount });
  } catch (err) {
    console.error("❌ ERRORE WEBHOOK:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
