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
  if (!agency_id) return res.status(400).json({ error: "agency_id mancante" });

  const { data: agency } = await supabase
    .from("agencies")
    .select("*")
    .eq("id", agency_id)
    .single();

  if (!agency) return res.status(404).json({ error: "agenzia non trovata" });

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

  const { data: run } = await supabase
    .from("agency_runs")
    .insert({
      agency_id: agency.id,
      apify_run_id: runId,
      new_listings_count: 0,
      run_started_at: new Date().toISOString(),
    })
    .select()
    .single();

  res.json({ ok: true, runId: run.apify_run_id, run_db_id: run.id });
});

// ======================================================
// 🔔 APIFY WEBHOOK
// ======================================================
app.post("/apify-webhook", async (req, res) => {
  const runId = req.body?.resource?.id;
  if (!runId) return res.json({ ok: true });

  console.log("🔔 Webhook ricevuto:", runId);

  const { data: run } = await supabase
    .from("agency_runs")
    .select("*")
    .eq("apify_run_id", runId)
    .single();

  if (!run) {
    console.warn("⚠️ run non trovato");
    return res.json({ ok: true });
  }

  const { data: agency } = await supabase
    .from("agencies")
    .select("*")
    .eq("id", run.agency_id)
    .single();

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

    // collega AL RUN (SEMPRE)
    await supabase.from("agency_run_listings").upsert({
      run_id: run.id,
      listing_id: item.id,
    });

    // collega ALL’AGENZIA (solo se nuovo)
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

  await supabase
    .from("agency_runs")
    .update({
      new_listings_count: newCount,
      run_completed_at: new Date().toISOString(),
    })
    .eq("id", run.id);

  console.log(`✅ ${newCount} nuovi annunci`);

  res.json({ ok: true });
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
