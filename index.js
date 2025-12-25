const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
  const { agency_id } = req.body;
  if (!agency_id) {
    return res.status(400).json({ error: "agency_id mancante" });
  }

  const { data: agency, error: agencyErr } = await supabase
    .from("agencies")
    .select("*")
    .eq("id", agency_id)
    .single();

  if (agencyErr || !agency) {
    return res.status(404).json({ error: "agenzia non trovata" });
  }

  const actorInput = {
    points: agency.points,
    operation: "vendita",
    max_items: 9999,
  };

  const runRes = await axios.post(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    actorInput,
    { headers: { "Content-Type": "application/json" } }
  );

  const apifyRunId = runRes.data.data.id;

  const { data: run, error: runErr } = await supabase
    .from("agency_runs")
    .insert({
      agency_id: agency.id,
      apify_run_id: apifyRunId,
      status: "running",
      new_listings_count: 0,
    })
    .select()
    .single();

  if (runErr) {
    return res.status(500).json({ error: runErr.message });
  }

  res.json({
    ok: true,
    run_id: run.id,
    apify_run_id: apifyRunId,
  });
});

// ======================================================
// 🔔 APIFY WEBHOOK
// ======================================================
app.post("/apify-webhook", async (req, res) => {
  const apifyRunId = req.body?.resource?.id;
  if (!apifyRunId) return res.json({ ok: true });

  console.log("🔔 Webhook ricevuto:", apifyRunId);

  const { data: run } = await supabase
    .from("agency_runs")
    .select("*")
    .eq("apify_run_id", apifyRunId)
    .single();

  if (!run) {
    console.warn("⚠️ run non trovato");
    return res.json({ ok: true });
  }

  try {
    const runRes = await axios.get(
      `https://api.apify.com/v2/actor-runs/${apifyRunId}?token=${APIFY_TOKEN}`
    );

    const datasetId = runRes.data.data.defaultDatasetId;

    const itemsRes = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&token=${APIFY_TOKEN}`
    );

    const items = itemsRes.data || [];
    let newCount = 0;

    for (const item of items) {
      await supabase.from("listings").upsert({
        id: item.id,
        title: item.title,
        city: item.city,
        province: item.province,
        price: item.price?.raw ?? null,
        url: item.url,
        raw: item,
      });

      await supabase.from("agency_run_listings").insert({
        run_id: run.id,
        listing_id: item.id,
      });

      const { data: exists } = await supabase
        .from("agency_listings")
        .select("listing_id")
        .eq("agency_id", run.agency_id)
        .eq("listing_id", item.id)
        .maybeSingle();

      if (!exists) {
        await supabase.from("agency_listings").insert({
          agency_id: run.agency_id,
          listing_id: item.id,
        });
        newCount++;
      }
    }

    await supabase
      .from("agency_runs")
      .update({
        status: "completed",
        new_listings_count: newCount,
      })
      .eq("id", run.id);

    console.log(`✅ Run completato: ${newCount} nuovi annunci`);
  } catch (err) {
    console.error("❌ Errore webhook:", err.message);

    await supabase
      .from("agency_runs")
      .update({ status: "failed" })
      .eq("id", run.id);
  }

  res.json({ ok: true });
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
