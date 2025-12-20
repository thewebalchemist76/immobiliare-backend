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

    // ✅ COSTRUZIONE INPUT SENZA NULL
    const actorInput = {
      ...(input.location_query && { location_query: input.location_query }),
      ...(input.location_id && { location_id: input.location_id }),

      operation: input.operation || "vendita",

      ...(input.min_price != null && { min_price: input.min_price }),
      ...(input.max_price != null && { max_price: input.max_price }),

      ...(input.min_rooms != null && { min_rooms: input.min_rooms }),
      ...(input.max_rooms != null && { max_rooms: input.max_rooms }),

      ...(input.min_size != null && { min_size: input.min_size }),
      ...(input.max_size != null && { max_size: input.max_size }),

      ...(input.garden && { garden: input.garden }),
      ...(input.terrace && { terrace: true }),
      ...(input.balcony && { balcony: true }),
      ...(input.lift && { lift: true }),
      ...(input.furnished && { furnished: true }),
      ...(input.pool && { pool: true }),
      ...(input.exclude_auctions && { exclude_auctions: true }),

      max_items: input.max_items || 1,
    };

    // sicurezza minima
    if (!actorInput.location_query && !actorInput.location_id) {
      return res.status(400).json({
        error: "location_query o location_id obbligatorio",
      });
    }

    console.log("➡️ Avvio Apify", actorInput);

    // 🚀 AVVIO RUN (NON BLOCCANTE)
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
    console.error("❌ ERRORE SEARCH:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
