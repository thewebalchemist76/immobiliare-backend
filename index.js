const axios = require("axios");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

// middleware
app.use(cors());
app.use(express.json());

// health check
app.get("/", (req, res) => {
  res.json({ status: "backend ok" });
});

/**
 * Riceve la ricerca dal frontend
 * e lancia l’Actor Apify
 */
app.post("/search", async (req, res) => {
  const search = req.body;

  console.log("🔍 Nuova ricerca ricevuta:", search);

  try {
    const response = await axios.post(
      `https://api.apify.com/v2/acts/${process.env.APIFY_ACTOR_ID}/runs`,
      {
        input: search,
      },
      {
        params: {
          token: process.env.APIFY_TOKEN,
        },
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    console.log("🚀 Apify run avviato:", response.data.data.id);

    res.json({
      ok: true,
      runId: response.data.data.id,
    });
  } catch (err) {
    console.error("❌ Errore Apify:", err.response?.data || err.message);
    res.status(500).json({ error: "Apify error" });
  }
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
