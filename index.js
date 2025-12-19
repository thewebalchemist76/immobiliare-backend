const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ACTOR_ID = process.env.APIFY_ACTOR_ID;

// health check
app.get("/", (req, res) => {
  res.json({ status: "backend ok" });
});

// avvia ricerca
app.post("/search", async (req, res) => {
  try {
    const input = req.body;

    // 1️⃣ avvia Actor
    const run = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs`,
      input,
      { params: { token: APIFY_TOKEN } }
    );

    const runId = run.data.data.id;

    // 2️⃣ polling async (NON blocca risposta)
    pollRun(runId);

    res.json({ ok: true, runId });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Errore avvio actor" });
  }
});

// polling
async function pollRun(runId) {
  console.log("⏳ Polling run:", runId);

  const interval = setInterval(async () => {
    try {
      const r = await axios.get(
        `https://api.apify.com/v2/actor-runs/${runId}`,
        { params: { token: APIFY_TOKEN } }
      );

      const run = r.data.data;

      if (run.status === "SUCCEEDED") {
        clearInterval(interval);

        console.log("✅ Run completato:", runId);

        // 3️⃣ fetch risultati
        const items = await axios.get(
          `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items`,
          { params: { token: APIFY_TOKEN } }
        );

        console.log("📦 Risultati:", items.data.length);

        // STEP SUCCESSIVO:
        // salvare items.data su Supabase
      }

      if (run.status === "FAILED") {
        clearInterval(interval);
        console.error("❌ Run fallito:", runId);
      }
    } catch (e) {
      console.error("Errore polling:", e.message);
    }
  }, 5000); // ogni 5 secondi
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Backend running on port ${PORT}`)
);
