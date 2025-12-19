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
 * (per ora solo log, poi chiamerà Apify)
 */
app.post("/search", async (req, res) => {
  const search = req.body;

  console.log("🔍 Nuova ricerca ricevuta:", search);

  // STEP SUCCESSIVO (NON ORA):
  // - chiamare Apify Actor API
  // - salvare search su Supabase

  res.json({ ok: true });
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
