<<<<<<< HEAD
# Smart City Water Grid Management System

A full-stack web application designed for centralizing and monitoring a city's water infrastructure. This project was built utilizing Node.js, Express, a SQLite database, and Vanilla HTML/CSS/JS for the frontend.

## Features Let's you

*   **Real-time Dashboard:** View aggregated capacities and city-wide statuses.
*   **Zone Tracking:** Monitor the daily water consumption across different city zones using interactive `Chart.js` bar charts.
*   **Reservoir Monitoring:** Check the exact ML (Megaliter) status and capacity percentages of all integrated water reservoirs.
*   **Alert System:** A centralized alert hub that logs and categorizes infrastructure warnings (e.g., Leaks, Maintenance, Capacity Drops).
*   **Live Monitor (SSE):** Real-time UI updates from IoT readings using Server-Sent Events.
*   **Water Quality Monitoring:** pH / turbidity / dissolved oxygen snapshots + trend modal.
*   **Forecasting & Anomalies:** Basic demand/depletion forecasting + anomaly detection endpoint.
*   **GIS + Heatmaps:** Google Maps (if API key set) with reservoir markers + scarcity heatmap (Leaflet fallback without key).
*   **Reports:** Export Alerts / Usage / Quality to Excel (`.xlsx`).
*   **SMS Alerts (Twilio):** High severity alerts can notify configured phone targets.
*   **Premium Aesthetic:** Features a fully responsive, modern dark-mode UI with glassmorphism effects and tailored micro-animations.

## Technology Stack

*   **Frontend**: HTML5, Vanilla CSS (Grid/Flexbox, CSS Variables, Glassmorphism), Vanilla JavaScript, Chart.js.
*   **Backend**: Node.js, Express.js, CORS, SSE.
*   **Database**: SQLite (using the `sqlite3` node package with a pre-configured seeding script).
*   **Integrations (optional)**: Twilio (SMS), Google Maps JavaScript API, Gemini API.
*   **Exports**: Excel (`exceljs`), PDF (`html2canvas` + `jsPDF`).

## Running the Project Locally

### 1. Setup Backend

Navigate to the backend directory, install dependencies, and start the server:

```bash
cd backend
npm install
npm start
```
*Note: Starting the server for the first time will automatically instantiate the SQLite database (`database.sqlite`) and seed it with realistic mock data.* The server will run on `http://localhost:3000`.

#### Backend environment variables
Copy `backend/.env.example` to `backend/.env` and fill what you need:
- **Required for production**: `JWT_SECRET`
- **IoT ingestion key**: `IOT_INGEST_KEY` (devices must send header `x-iot-key`)
- **Twilio SMS (optional)**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- **Gemini (optional)**: `GEMINI_API_KEY`

### 2. Setup Frontend

You simply need to serve the `frontend` directory using any static web server. If you have Node.js installed, you can use `serve`:

```bash
cd frontend
npx serve
```
Open the provided local URL in your browser to view the application!

#### Google Maps setup (optional)
Edit `frontend/index.html` and set:
- `window.HYDROGRID_CONFIG.GOOGLE_MAPS_API_KEY = 'YOUR_KEY'`

If you leave it blank, the app falls back to Leaflet.

## Useful API endpoints
- **SSE stream**: `GET /api/stream`
- **IoT ingest**: `POST /api/iot/reading` (header `x-iot-key: <IOT_INGEST_KEY>`)
- **Usage analytics**: `GET /api/usage?range=daily|weekly|monthly`
- **Quality**: `GET /api/quality/latest`, `GET /api/quality/history?reservoirId=1`
- **Forecasts**: `GET /api/forecast/rainfall`, `GET /api/forecast/demand`, `GET /api/forecast/reservoir-depletion`
- **Anomalies**: `GET /api/anomalies`
- **Excel reports**: `GET /api/reports/alerts.xlsx`, `GET /api/reports/usage.xlsx`, `GET /api/reports/quality.xlsx`

## Deployment

Because this project utilizes a file-based SQLite database and standard Node.js server, it can be easily deployed to services like Render, Heroku, or Fly.io.
=======
# Water-Resource-Management
>>>>>>> 32a2f38d158b2aae5d9f10fcb2d24529b561da1b
