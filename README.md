# 💧 Smart City Water Grid Management System

A full-stack web application for monitoring and managing a city's water distribution infrastructure in real time. The platform centralizes reservoir monitoring, water consumption analytics, quality assessment, infrastructure alerts, and predictive insights into a single interactive dashboard.

Built with **Node.js**, **Express.js**, **SQLite**, and **Vanilla JavaScript**, the system provides city administrators with real-time visibility into water resources, enabling faster decision-making and more efficient resource management.

---

## 🚀 Features

### 📊 Real-Time Dashboard
- Monitor city-wide water capacity and overall infrastructure status.
- View live updates from connected IoT devices using **Server-Sent Events (SSE)**.

### 🌍 Zone-Based Water Analytics
- Track daily water consumption across multiple city zones.
- Interactive visualizations powered by **Chart.js**.

### 🏞 Reservoir Monitoring
- View current water levels in megaliters (ML).
- Monitor reservoir capacity percentages in real time.

### ⚠ Alert Management
- Centralized dashboard for infrastructure alerts.
- Categorized alerts including:
  - Water leaks
  - Scheduled maintenance
  - Capacity drops
  - Critical system notifications

### 💧 Water Quality Monitoring
- Monitor key water quality parameters:
  - pH
  - Turbidity
  - Dissolved Oxygen
- View historical trends and snapshots.

### 📈 Forecasting & Anomaly Detection
- Predict future water demand.
- Estimate reservoir depletion.
- Detect abnormal consumption patterns and infrastructure anomalies.

### 🗺 GIS Visualization
- Interactive reservoir mapping using **Google Maps API**.
- Automatic **Leaflet** fallback when a Google Maps API key is unavailable.
- Water scarcity heatmap visualization.

### 📑 Reporting
Generate downloadable reports including:
- Water Usage
- Infrastructure Alerts
- Water Quality

Reports are available in **Excel (.xlsx)** format.

### 📱 SMS Notifications
Send high-priority infrastructure alerts using **Twilio SMS** integration.

### 🎨 Modern User Interface
- Fully responsive design
- Dark mode
- Glassmorphism-inspired UI
- Smooth animations and micro-interactions
- Mobile-friendly layout

---

# 🛠 Technology Stack

## Frontend
- HTML5
- CSS3
- Vanilla JavaScript (ES6+)
- Chart.js

## Backend
- Node.js
- Express.js
- Server-Sent Events (SSE)
- CORS

## Database
- SQLite

## APIs & Integrations
- Google Maps JavaScript API
- Twilio SMS API
- Gemini API *(Optional)*

## Report Generation
- ExcelJS
- jsPDF
- html2canvas

---

# ⚙ Installation

## 1. Clone the Repository

```bash
git clone <repository-url>
cd Water-Resource-Management
```

---

## 2. Backend Setup

Navigate to the backend folder:

```bash
cd backend
```

Install dependencies:

```bash
npm install
```

Start the server:

```bash
npm start
```

On first launch, the application automatically:

- Creates the SQLite database
- Seeds it with realistic sample data

The backend will run at:

```
http://localhost:3000
```

---

## Environment Variables

Create a `.env` file inside the `backend` directory.

```env
JWT_SECRET=your_secret

IOT_INGEST_KEY=your_key

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=

GEMINI_API_KEY=
```

### Required
- JWT_SECRET

### Optional
- Twilio credentials
- Gemini API key

---

## 3. Frontend Setup

Navigate to the frontend directory:

```bash
cd frontend
```

Serve the application using any static server.

Example:

```bash
npx serve
```

Open the generated local URL in your browser.

---

## Google Maps Configuration (Optional)

Inside `frontend/index.html`:

```javascript
window.HYDROGRID_CONFIG.GOOGLE_MAPS_API_KEY = "YOUR_API_KEY";
```

If no API key is provided, the application automatically falls back to **Leaflet** for map visualization.

---

# 📡 API Endpoints

| Endpoint | Description |
|-----------|-------------|
| `GET /api/stream` | Live SSE stream |
| `POST /api/iot/reading` | IoT data ingestion |
| `GET /api/usage` | Water usage analytics |
| `GET /api/quality/latest` | Latest water quality metrics |
| `GET /api/quality/history` | Historical quality data |
| `GET /api/forecast/rainfall` | Rainfall prediction |
| `GET /api/forecast/demand` | Water demand forecasting |
| `GET /api/forecast/reservoir-depletion` | Reservoir depletion prediction |
| `GET /api/anomalies` | Infrastructure anomaly detection |
| `GET /api/reports/*.xlsx` | Export reports |

---

# 🚀 Deployment

The project can be deployed on platforms such as:

- Render
- Fly.io
- Railway
- Heroku

Since the backend uses a lightweight SQLite database, deployment requires minimal configuration.

---

# 📌 Future Enhancements

- AI-powered demand forecasting
- Predictive leak detection
- Mobile application
- Multi-city support
- User authentication & role management
- Cloud database integration (PostgreSQL/MySQL)
- Docker containerization

---

# 👥 Team

Developed as a collaborative software engineering project by a team of three members.
