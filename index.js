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
app.get("/", (req, res) => {
  res.json({ status: "backend ok" });
});

// ================= SEARCH =================
app.post("/search", async (req, res) => {
  try {
    const input = req.body;
    console.log("➡️ /search chiamata", input);

    const actorInput = {
      location_query: input.location_query ?? null,
      location_id: input.location_id ?? null,
      operation: input.operation || "vendita",

      min_price: input.min_price ?? null,
      max_price: input.max_price ?? null,

      min_rooms: input.min_rooms ?? null,
      max_rooms: input.max_rooms ?? null,

      min_size: input.min_size ?? null,
      max_size: input.max_size ?? null,

      garden: input.garden ?? "Indifferente",
      terrace: !!input.terrace,
      balcony: !!input.balcony,
      lift: !!input.lift,
      furnished: !!input.furnished,
      pool: !!input.pool,
      exclude_auctions: !!input.exclude_auctions,

      max_items: input.max_items || 1,
    };

    if (!actorInput.location_query && !actorInput.location_id) {
      return res.status(400).json({ error: "location_query obbligatorio" });
    }

    console.log("➡️ Avvio Apify", actorInput);

    // 🔥 AVVIO RUN (NON BLOCCANTE)
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      actorInput,
      { headers: { "Content-Type": "application/json" } }
    );

    const runId = runRes.data.data.id;
    console.log("🚀 Run avviato:", runId);

    // salva la search SUBITO
    const { data: searchRow, error } = await supabase
      .from("searches")
      .insert({
        user_id: input.user_id,
        query: actorInput,
        run_id: runId,
        status: "running",
      })
      .select()
      .single();

    if (error) throw error;

    // ✅ RESPONSE IMMEDIATA
    res.json({
      ok: true,
      searchId: searchRow.id,
      runId,
    });
  } catch (err) {
    console.error("❌ ERRORE SEARCH:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
