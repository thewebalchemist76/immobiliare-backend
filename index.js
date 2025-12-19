const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

/* health check */
app.get("/", (req, res) => {
  res.json({ status: "backend ok" });
});

/* launch Apify actor */
app.post("/search", async (req, res) => {
  try {
    const input = req.body;

    const response = await axios.post(
      "https://api.apify.com/v2/acts/thewebalchemist76~immobiliare-scraper/runs?wait=1",
      input,
      {
        params: { token: process.env.APIFY_TOKEN },
        headers: { "Content-Type": "application/json" },
      }
    );

    res.json({
      runId: response.data.data.id,
      status: "started",
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
