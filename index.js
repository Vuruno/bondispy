const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const moment = require("moment");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB Connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Connected to MongoDB Atlas"))
  .catch((err) => console.error("MongoDB Connection Error:", err));

// MongoDB Schema
const busPositionSchema = new mongoose.Schema({
  datetime: String,
  linea: Number,
  unidad: Number,
  lat: String,
  lon: String,
  hora: String,
});

const BusPosition = mongoose.model("BusPosition", busPositionSchema);

const errorLogSchema = new mongoose.Schema({
  message: String,
  timestamp: { type: Date, default: Date.now },
});

const ErrorLog = mongoose.model("ErrorLog", errorLogSchema);

// Utility to log errors
async function logError(message) {
  const error = new ErrorLog({ message });
  await error.save();
}

// Track Bus Positions
async function trackBusPositions(lineaId) {
  while (true) {
    try {
      const response = await axios.post(
        `https://www.jaha.com.py/api/posicionColectivos?linea=${lineaId}`
      );
      const positions = response.data;

      for (const position of positions) {
        const { unidad, lat, lon, hora } = position;
        const datetime = moment().format(`DD-MM-YYYY ${hora}`);

        // Check for duplicates
        const exists = await BusPosition.findOne({ linea: lineaId, unidad, datetime });
        if (!exists) {
          const newPosition = new BusPosition({ datetime, linea: lineaId, unidad, lat, lon });
          await newPosition.save();
        }
      }
    } catch (error) {
      await logError(`Error tracking positions for linea ${lineaId}: ${error.message}`);
    }

    // Wait for 500ms before next request
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// Fetch Bus Lines and Start Tracking
async function fetchBusLinesAndTrackPositions() {
  try {
    const response = await axios.get("https://www.jaha.com.py/bus/lineas");
    const busLines = response.data;

    // Start tracking positions for each line
    busLines.forEach((line) => trackBusPositions(line.id));
  } catch (error) {
    await logError(`Error fetching bus lines: ${error.message}`);
  }
}

// API Endpoints
app.get("/", (req, res) => {
  res.send(`
    <h1>Available Routes</h1>
    <ul>
      <li><a href="/positions" target="_blank">GET /positions</a> - Retrieve the latest bus positions.</li>
      <li><a href="/errors" target="_blank">GET /errors</a> - Retrieve error logs.</li>
      <li><a href="/status" target="_blank">GET /status</a> - Check server status.</li>
    </ul>
  `);
});

app.get("/positions", async (req, res) => {
  const positions = await BusPosition.find().sort({ datetime: -1 }).limit(100); // Return latest 100 positions
  res.json(positions);
});

app.get("/errors", async (req, res) => {
  const errors = await ErrorLog.find().sort({ timestamp: -1 }).limit(100); // Return latest 100 errors
  res.json(errors);
});

app.get("/status", async (req, res) => {
  const totalPositions = await BusPosition.countDocuments();
  const totalErrors = await ErrorLog.countDocuments();
  res.json({ status: "running", totalPositions, totalErrors });
});

// Start Tracking and Server
fetchBusLinesAndTrackPositions();
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
