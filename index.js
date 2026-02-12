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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ================= APIFY =================
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR_ID = process.env.APIFY_ACTOR_ID;

// ================= FRONTEND URL =================
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// ================= CRON SECRET =================
const CRON_SECRET = process.env.CRON_SECRET;

// ================= HEALTH =================
app.get("/", (_req, res) => res.json({ status: "backend ok" }));
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/diag/supabase-auth", async (_req, res) => {
  try {
    const t0 = Date.now();
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/health`);
    const ms = Date.now() - t0;
    const body = await r.text();
    res.status(200).json({ ok: r.ok, status: r.status, ms, body: body || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

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
  if (String(provided) !== String(CRON_SECRET)) return { ok: false, status: 403, error: "Invalid cron secret" };

  return { ok: true };
}

function isUuid(v) {
  const s = String(v || "");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function isEmail(v) {
  const s = String(v || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

async function getAuthUser(req) {
  const token = getBearerToken(req);
  if (!token) return { user: null, error: "Missing bearer token" };
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return { user: null, error: error?.message || "Invalid token" };
  return { user: data.user, error: null };
}

async function getAgentProfileByUser(user) {
  const uid = user?.id;
  const email = user?.email;
  if (!uid && !email) return { agent: null, error: "Missing user id/email" };

  const tryQuery = async (qb) => {
    const { data, error } = await qb.maybeSingle();
    if (error) return { data: null, error };
    return { data, error: null };
  };

  let res = null;
  if (uid) {
    res = await tryQuery(supabase.from("agents").select("id,user_id,email,role,agency_id").eq("id", uid));
    if (res?.data) return { agent: res.data, error: null };

    res = await tryQuery(supabase.from("agents").select("id,user_id,email,role,agency_id").eq("user_id", uid));
    if (res?.data) return { agent: res.data, error: null };
  }

  if (email) {
    res = await tryQuery(supabase.from("agents").select("id,user_id,email,role,agency_id").eq("email", email));
    if (res?.data) return { agent: res.data, error: null };
  }

  return { agent: null, error: null };
}

function assertEnv() {
  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_KEY) missing.push("SUPABASE_SERVICE_KEY");
  if (!APIFY_TOKEN) missing.push("APIFY_TOKEN");
  if (!ACTOR_ID) missing.push("APIFY_ACTOR_ID");
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
}

function errToMessage(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  if (err.error_description) return err.error_description;
  try {
    return JSON.stringify(err);
  } catch (_e) {
    return String(err);
  }
}

async function startApifyRunAndCreateAgencyRun(agency) {
  assertEnv();

  if (!agency?.id || !isUuid(agency.id)) {
    throw new Error(`agency.id non valido (uuid): "${agency?.id}"`);
  }

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
    if (!isUuid(agency_id)) return res.status(400).json({ error: `agency_id non valido (uuid): "${agency_id}"` });

    const { data: agency, error } = await supabase.from("agencies").select("*").eq("id", agency_id).maybeSingle();

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
// ✉️ INVITE AGENT (solo TL)
// ======================================================
app.post("/invite-agent", async (req, res) => {
  try {
    assertEnv();

    const { user, error: authErr } = await getAuthUser(req);
    if (authErr) return res.status(401).json({ error: authErr });

    const { agent, error: agentErr } = await getAgentProfileByUser(user);
    if (agentErr) return res.status(500).json({ error: agentErr.message || String(agentErr) });
    if (!agent || agent.role !== "tl") return res.status(403).json({ error: "Permesso negato" });

    const { agency_id, email, first_name, last_name } = req.body || {};
    if (!agency_id) return res.status(400).json({ error: "agency_id mancante" });
    if (!isUuid(agency_id)) return res.status(400).json({ error: `agency_id non valido (uuid): "${agency_id}"` });
    if (!email || !isEmail(email)) return res.status(400).json({ error: "email non valida" });

    const { data: agency, error: agencyErr } = await supabase.from("agencies").select("id").eq("id", agency_id).maybeSingle();
    if (agencyErr) return res.status(500).json({ error: agencyErr.message });
    if (!agency) return res.status(404).json({ error: "agenzia non trovata" });

    const { data: invited, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo: FRONTEND_URL,
      data: {
        first_name: first_name || null,
        last_name: last_name || null,
        agency_id,
        role: "agent",
      },
    });
    if (inviteErr) {
      const msg = errToMessage(inviteErr);
      console.error("❌ INVITE AGENT (Supabase):", inviteErr);
      return res.status(500).json({ error: msg, code: inviteErr.code || null });
    }

    const userId = invited?.user?.id || null;
    if (userId) {
      const { data: existing, error: exErr } = await supabase
        .from("agents")
        .select("id,user_id,email")
        .or(`user_id.eq.${userId},email.eq.${email}`)
        .maybeSingle();
      if (exErr) return res.status(500).json({ error: exErr.message });

      const payload = {
        user_id: userId,
        email,
        role: "agent",
        agency_id,
        first_name: first_name || null,
        last_name: last_name || null,
      };

      if (existing?.id) {
        const { error: updErr } = await supabase.from("agents").update(payload).eq("id", existing.id);
        if (updErr) return res.status(500).json({ error: updErr.message });
      } else {
        const { error: insErr } = await supabase.from("agents").insert(payload);
        if (insErr) return res.status(500).json({ error: insErr.message });
      }
    }

    return res.json({ ok: true, user_id: userId });
  } catch (err) {
    console.error("❌ INVITE AGENT:", err);
    res.status(500).json({ error: errToMessage(err) });
  }
});

// ======================================================
// ⏰ CRON DAILY (tutte le agenzie)
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
        if (!agency?.id || !isUuid(agency.id)) {
          errors.push({ agency_id: agency?.id ?? null, error: `agency_id non valido (uuid): "${agency?.id}"` });
          continue;
        }
        await startApifyRunAndCreateAgencyRun(agency);
        started++;
      } catch (e) {
        errors.push({ agency_id: agency?.id ?? null, error: e.message });
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

    const { data: run, error: runErr } = await supabase.from("agency_runs").select("*").eq("apify_run_id", apifyRunId).maybeSingle();
    if (runErr || !run) return res.json({ ok: true });

    const runInfo = await axios.get(`https://api.apify.com/v2/actor-runs/${apifyRunId}?token=${APIFY_TOKEN}`);
    const datasetId = runInfo?.data?.data?.defaultDatasetId;
    if (!datasetId) return res.json({ ok: true });

    const itemsRes = await axios.get(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&token=${APIFY_TOKEN}`);
    const items = itemsRes.data || [];

    let newCount = 0;

    for (const item of items) {
      const nowIso = new Date().toISOString();

      const { data: existing, error: exErr } = await supabase
        .from("listings")
        .select("id, source_agency_id")
        .eq("id", item.id)
        .maybeSingle();

      if (exErr) throw new Error(exErr.message);

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

      {
        const { error: arlErr } = await supabase
          .from("agency_run_listings")
          .upsert({ run_id: run.id, listing_id: item.id }, { onConflict: "run_id,listing_id" });
        if (arlErr) throw new Error(arlErr.message);
      }

      const sourceOk = !existing || existing.source_agency_id === run.agency_id;

      if (sourceOk) {
        const { data: exists, error: alSelErr } = await supabase
          .from("agency_listings")
          .select("listing_id")
          .eq("agency_id", run.agency_id)
          .eq("listing_id", item.id)
          .maybeSingle();

        if (alSelErr) throw new Error(alSelErr.message);

        if (!exists) {
          const { error: alErr } = await supabase.from("agency_listings").insert({
            agency_id: run.agency_id,
            listing_id: item.id,
          });
          if (alErr) throw new Error(alErr.message);
          newCount++;
        }
      }
    }

    {
      const { error: updRunErr } = await supabase
        .from("agency_runs")
        .update({ total_listings: items.length, new_listings_count: newCount })
        .eq("id", run.id);

      if (updRunErr) throw new Error(updRunErr.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ WEBHOOK:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
