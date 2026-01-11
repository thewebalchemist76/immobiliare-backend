// index.js
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

// ================= FRONTEND URL =================
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// ================= CRON SECRET =================
const CRON_SECRET = process.env.CRON_SECRET;

// ================= HEALTH =================
app.get("/", (_req, res) => res.json({ status: "backend ok" }));

// ======================================================
// helpers
// ======================================================
function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function requireCron(req) {
  const bearer = getBearerToken(req);
  const header = req.headers["x-cron-secret"];
  const query = req.query?.secret;
  const provided = bearer || header || query;

  if (!CRON_SECRET) return { ok: false, status: 500, error: "CRON_SECRET non configurato" };
  if (!provided) return { ok: false, status: 401, error: "Missing cron secret" };
  if (String(provided) !== String(CRON_SECRET))
    return { ok: false, status: 403, error: "Invalid cron secret" };

  return { ok: true };
}

function assertEnv() {
  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push("SUPABASE_SERVICE_KEY");
  if (!APIFY_TOKEN) missing.push("APIFY_TOKEN");
  if (!ACTOR_ID) missing.push("APIFY_ACTOR_ID");
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
}

async function startApifyRunAndCreateAgencyRun(agency) {
  assertEnv();

  const actorInput = {
    points: agency.points,
    operation: "vendita",
    max_items: 50,
  };

  const runRes = await axios.post(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
    actorInput,
    { headers: { "Content-Type": "application/json" } }
  );

  const apifyRunId = runRes?.data?.data?.id;
  if (!apifyRunId) throw new Error("Apify run id mancante");

  const { data: run, error } = await supabase
    .from("agency_runs")
    .insert({
      agency_id: agency.id,
      apify_run_id: apifyRunId,
      run_date: new Date().toISOString().slice(0, 10),
      total_listings: 0,
      new_listings_count: 0,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  return { run_id: run.id, apify_run_id: apifyRunId };
}

// ======================================================
// ▶️ RUN AGENCY
// ======================================================
app.post("/run-agency", async (req, res) => {
  try {
    const { agency_id } = req.body || {};
    if (!agency_id) return res.status(400).json({ error: "agency_id mancante" });

    const { data: agency, error } = await supabase
      .from("agencies")
      .select("*")
      .eq("id", agency_id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!agency) return res.status(404).json({ error: "agenzia non trovata" });

    const out = await startApifyRunAndCreateAgencyRun(agency);
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error("❌ RUN AGENCY:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// ⏰ CRON DAILY
// ======================================================
app.post("/cron/daily", async (req, res) => {
  try {
    const guard = requireCron(req);
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

    const { data: agencies, error } = await supabase.from("agencies").select("id, points");
    if (error) return res.status(500).json({ error: error.message });

    let started = 0;
    const errors = [];

    for (const agency of agencies || []) {
      try {
        await startApifyRunAndCreateAgencyRun(agency);
        started++;
      } catch (e) {
        errors.push({ agency_id: agency.id, error: e.message });
      }
    }

    res.json({ ok: true, started, failed: errors.length, errors });
  } catch (err) {
    console.error("❌ CRON DAILY:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 🔔 APIFY WEBHOOK
// ======================================================
app.post("/apify-webhook", async (req, res) => {
  try {
    const apifyRunId = req.body?.resource?.id;
    if (!apifyRunId) return res.json({ ok: true });

    const { data: run, error: runErr } = await supabase
      .from("agency_runs")
      .select("*")
      .eq("apify_run_id", apifyRunId)
      .maybeSingle();

    if (runErr || !run) return res.json({ ok: true });

    const runInfo = await axios.get(
      `https://api.apify.com/v2/actor-runs/${apifyRunId}?token=${APIFY_TOKEN}`
    );
    const datasetId = runInfo?.data?.data?.defaultDatasetId;
    if (!datasetId) return res.json({ ok: true });

    const itemsRes = await axios.get(
      `https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&token=${APIFY_TOKEN}`
    );

    const items = itemsRes.data || [];
    let newCount = 0;

    for (const item of items) {
      const nowIso = new Date().toISOString();

      const { data: existing } = await supabase
        .from("listings")
        .select("id, source_agency_id")
        .eq("id", item.id)
        .maybeSingle();

      if (!existing) {
        const { error: insErr } = await supabase.from("listings").insert({
          id: item.id,
          title: item.title,
          city: item.city,
          province: item.province,
          price: item.price?.raw ?? null,
          url: item.url,
          raw: item.raw,
          first_seen_at: nowIso,
          source_agency_id: run.agency_id,
        });
        if (insErr) throw new Error(insErr.message);
      } else {
        const { error: updErr } = await supabase
          .from("listings")
          .update({
            title: item.title,
            city: item.city,
            province: item.province,
            price: item.price?.raw ?? null,
            url: item.url,
            raw: item.raw,
          })
          .eq("id", item.id);
        if (updErr) throw new Error(updErr.message);
      }

      await supabase.from("agency_run_listings").upsert(
        { run_id: run.id, listing_id: item.id },
        { onConflict: "run_id,listing_id" }
      );

      const sourceOk =
        !existing || existing.source_agency_id === run.agency_id;

      if (sourceOk) {
        const { data: exists } = await supabase
          .from("agency_listings")
          .select("listing_id")
          .eq("agency_id", run.agency_id)
          .eq("listing_id", item.id)
          .maybeSingle();

        if (!exists) {
          const { error: alErr } = await supabase
            .from("agency_listings")
            .insert({
              agency_id: run.agency_id,
              listing_id: item.id,
            });
          if (alErr) throw new Error(alErr.message);
          newCount++;
        }
      }
    }

    await supabase
      .from("agency_runs")
      .update({
        total_listings: items.length,
        new_listings_count: newCount,
      })
      .eq("id", run.id);

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ WEBHOOK:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
