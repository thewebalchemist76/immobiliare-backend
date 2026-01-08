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

// ================= FRONTEND URL (invite redirect) =================
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// ================= HEALTH =================
app.get("/", (_req, res) => {
  res.json({ status: "backend ok" });
});

// ======================================================
// helpers
// ======================================================
function getBearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function requireTL(req, agency_id) {
  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: "Missing Authorization Bearer token" };

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return { ok: false, status: 401, error: "Invalid session token" };
  }

  const uid = userData.user.id;

  const { data: me, error: meErr } = await supabase
    .from("agents")
    .select("user_id, role, agency_id")
    .eq("user_id", uid)
    .maybeSingle();

  if (meErr) return { ok: false, status: 500, error: meErr.message };
  if (!me) return { ok: false, status: 403, error: "No agent profile" };
  if (me.role !== "tl") return { ok: false, status: 403, error: "Not TL" };
  if (!me.agency_id || me.agency_id !== agency_id)
    return { ok: false, status: 403, error: "TL not in this agency" };

  return { ok: true, uid, me };
}

// ======================================================
// 👤 INVITE AGENT (TL only)
// ======================================================
app.post("/invite-agent", async (req, res) => {
  try {
    const { agency_id, email, first_name, last_name } = req.body || {};
    if (!agency_id) return res.status(400).json({ error: "agency_id mancante" });
    if (!email) return res.status(400).json({ error: "email mancante" });

    // auth: only TL of same agency can invite
    const guard = await requireTL(req, agency_id);
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

    const emailLower = String(email).trim().toLowerCase();
    const fn = first_name ? String(first_name).trim() : null;
    const ln = last_name ? String(last_name).trim() : null;

    // create/invite user in Supabase Auth
    const { data: inviteData, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(
      emailLower,
      {
        redirectTo: FRONTEND_URL,
        data: { agency_id },
      }
    );

    if (inviteErr) return res.status(500).json({ error: inviteErr.message });

    const invitedUserId = inviteData?.user?.id || null;

    // upsert agents row (by agency_id + email)
    const { data: existing, error: existingErr } = await supabase
      .from("agents")
      .select("id, user_id")
      .eq("agency_id", agency_id)
      .eq("email", emailLower)
      .maybeSingle();

    if (existingErr) return res.status(500).json({ error: existingErr.message });

    if (!existing) {
      const { error: insErr } = await supabase.from("agents").insert({
        agency_id,
        email: emailLower,
        first_name: fn,
        last_name: ln,
        role: "agent",
        user_id: invitedUserId,
      });
      if (insErr) return res.status(500).json({ error: insErr.message });
    } else {
      const patch = {
        first_name: fn,
        last_name: ln,
      };
      // se non c’era user_id, lo settiamo dall’invite
      if (!existing.user_id && invitedUserId) patch.user_id = invitedUserId;

      const { error: updErr } = await supabase.from("agents").update(patch).eq("id", existing.id);
      if (updErr) return res.status(500).json({ error: updErr.message });
    }

    res.json({ ok: true, invited: emailLower, user_id: invitedUserId });
  } catch (err) {
    console.error("❌ INVITE AGENT:", err.message);
    res.status(500).json({ error: err.message });
  }
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

    const { data: agency } = await supabase.from("agencies").select("*").eq("id", agency_id).single();

    if (!agency) {
      return res.status(404).json({ error: "agenzia non trovata" });
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

    const apifyRunId = runRes.data.data.id;

    const { data: run } = await supabase
      .from("agency_runs")
      .insert({
        agency_id: agency.id,
        apify_run_id: apifyRunId,
        run_date: new Date().toISOString().slice(0, 10),
        total_listings: 0,
        new_listings: 0,
      })
      .select()
      .single();

    res.json({ ok: true, run_id: run.id, apify_run_id: apifyRunId });
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
    const apifyRunId = req.body?.resource?.id;
    if (!apifyRunId) return res.json({ ok: true });

    console.log("🔔 Webhook ricevuto:", apifyRunId);

    const { data: run } = await supabase
      .from("agency_runs")
      .select("*")
      .eq("apify_run_id", apifyRunId)
      .single();

    if (!run) {
      console.warn("⚠️ agency_run non trovato");
      return res.json({ ok: true });
    }

    const runInfo = await axios.get(
      `https://api.apify.com/v2/actor-runs/${apifyRunId}?token=${APIFY_TOKEN}`
    );

    const datasetId = runInfo.data.data.defaultDatasetId;

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
        total_listings: items.length,
        new_listings: newCount,
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
