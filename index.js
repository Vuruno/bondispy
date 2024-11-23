const express = require("express");
const axios = require("axios");
const moment = require("moment");
const fs = require("fs");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const START_TIME = new Date(); // To track server uptime

// Utility to log errors
function logError(message) {
  const logMessage = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync("error_log.txt", logMessage, "utf8");
}

// Utility to write data to CSV
function writeToCSV(linea, unidad, lat, lon, hora) {
  const date = moment().format("YYYY-MM-DD");
  const fileName = `csv/${date}.csv`;

  // Check if the file exists; if not, create it and add the header
  if (!fs.existsSync(fileName)) {
    fs.writeFileSync(fileName, "linea;unidad;lat;lon;hora\n", "utf8");
  }

  // Read the current data in the file to check for duplicates
  const fileData = fs.readFileSync(fileName, "utf8");
  const rows = fileData.split("\n");
  const newRow = `${linea};${unidad};${lat};${lon};${hora}`;

  // Check for duplicates and append only if unique
  if (!rows.includes(newRow)) {
    fs.appendFileSync(fileName, `${newRow}\n`, "utf8");
  }
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

        // Save to CSV
        writeToCSV(lineaId, unidad, lat, lon, hora);
      }
    } catch (error) {
      logError(
        `Error tracking positions for linea ${lineaId}: ${error.message}`
      );
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
    logError(`Error fetching bus lines: ${error.message}`);
  }
}

// API Endpoints
app.get("/", (req, res) => {
  res.send(`
    <h1>Available Routes</h1>
    <ul>
      <li><a href="/status" target="_blank">GET /status</a> - Check server status.</li>
      <li><a href="/csv-info" target="_blank">GET /csv-info</a> - Check row counts of all CSV files.</li>
    </ul>
  `);
});

app.get("/status", (req, res) => {
  const date = moment().format("YYYY-MM-DD");
  const fileName = `${date}.csv`;
  let totalPositions = 0;

  // Get today's total positions
  if (fs.existsSync(fileName)) {
    const fileData = fs.readFileSync(fileName, "utf8");
    totalPositions = fileData.split("\n").length - 2; // Exclude header and empty line
  }

  // Get recent errors
  const errors = fs.existsSync("error_log.txt")
    ? fs
        .readFileSync("error_log.txt", "utf8")
        .split("\n")
        .filter((line) => line) // Remove empty lines
        .slice(-10) // Show only the last 10 errors
    : [];

  // Calculate uptime
  const uptime = moment.duration(new Date() - START_TIME).humanize();

  res.json({
    status: "running",
    uptime,
    date,
    totalPositions,
    recentErrors: errors,
  });
});

// New Endpoint: Check CSV File Info
app.get("/csv-info", (req, res) => {
  try {
    // Get all CSV files in the current directory
    const files = fs
      .readdirSync("./csv")
      .filter((file) => file.endsWith(".csv"));

    // Read and count rows for each CSV
    const csvInfo = files.map((file) => {
      const fileData = fs.readFileSync(`csv/${file}`, "utf8");
      const rows = fileData.split("\n").filter((line) => line.trim()); // Remove empty lines
      const rowCount = rows.length - 1;
      const fileSize = Math.round(fs.statSync(`csv/${file}`).size/1000);

      let firstEntryTime = null;
      let lastEntryTime = null;

      if (rowCount > 0) {
        // Extract the datetime column (assumes it's the first column)
        firstEntryTime = rows[1].split(";")[4];
        lastEntryTime = rows[rows.length - 1].split(";")[4];
      }

      return {
        date: file,
        rowCount,
        size: `${fileSize} KB`,
        firstEntryTime,
        lastEntryTime
      }; // Exclude header row
    });

    res.json({
      status: "success",
      csvInfo,
    });
  } catch (error) {
    logError(`Error fetching CSV info: ${error.message}`);
    res
      .status(500)
      .json({ status: "error", message: "Unable to fetch CSV info." });
  }
});

// Start Tracking and Server
fetchBusLinesAndTrackPositions();
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
