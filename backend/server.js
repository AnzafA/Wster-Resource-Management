const express = require('express');
const cors = require('cors');
const db = require('./database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ml = require('./ml');
const nodemailer = require('nodemailer');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const twilio = require('twilio');
const ExcelJS = require('exceljs');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Ethereal Mock Email Setup
let transporter;
nodemailer.createTestAccount((err, account) => {
    if (account) {
        transporter = nodemailer.createTransport({
            host: account.smtp.host,
            port: account.smtp.port,
            secure: account.smtp.secure,
            auth: { user: account.user, pass: account.pass }
        });
    }
});

const app = express();
const port = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
const IOT_INGEST_KEY = process.env.IOT_INGEST_KEY || 'dev-iot-key';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

app.use(cors());
app.use(express.json());
app.use(express.text()); // To accept raw CSV

// --- REAL-TIME STREAM (SSE) ---
const sseClients = new Set();
function sseBroadcast(eventName, payload) {
    const msg = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
        try { res.write(msg); } catch { /* ignore broken pipe */ }
    }
}

app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    res.write('event: hello\ndata: {"ok":true}\n\n');
    sseClients.add(res);
    req.on('close', () => {
        sseClients.delete(res);
    });
});

async function sendSmsToTargets(message) {
    if (!twilioClient || !TWILIO_FROM_NUMBER) return;

    const targets = await new Promise((resolve) => {
        db.all(`SELECT phone_e164 FROM notification_targets WHERE enabled = 1`, [], (err, rows) => {
            if (err) return resolve([]);
            resolve(rows || []);
        });
    });

    await Promise.allSettled(
        targets.map(t =>
            twilioClient.messages.create({
                from: TWILIO_FROM_NUMBER,
                to: t.phone_e164,
                body: message
            })
        )
    );
}

function createAlert(type, message, severity, { notifySms = true } = {}) {
    return new Promise((resolve) => {
        db.run(`INSERT INTO alerts (type, message, severity) VALUES (?, ?, ?)`, [type, message, severity], function (err) {
            if (!err) {
                sseBroadcast('alert', { id: this.lastID, type, message, severity, timestamp: new Date().toISOString() });
                if (notifySms && severity && severity.toLowerCase().includes('high')) {
                    // Fire-and-forget
                    sendSmsToTargets(`[HydroGrid] ${type}: ${message}`).catch(() => {});
                }
            }
            resolve({ ok: !err, id: this?.lastID });
        });
    });
}

// --- ADMIN AUTH & ENCRYPTION ---
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM admin_users WHERE username = ?`, [username], (err, row) => {
        if (err || !row) return res.status(401).json({ error: 'Invalid credentials' });

        bcrypt.compare(password, row.password_hash, (err, isMatch) => {
            if (isMatch) {
                const token = jwt.sign({ id: row.id, role: 'admin' }, JWT_SECRET, { expiresIn: '2h' });
                res.json({ success: true, token });
            } else {
                res.status(401).json({ error: 'Invalid credentials' });
            }
        });
    });
});

// Middleware for JWT verification
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// --- IOT INGESTION AUTH ---
function authenticateIot(req, res, next) {
    const key = req.headers['x-iot-key'];
    if (!key || key !== IOT_INGEST_KEY) return res.status(401).json({ error: 'Unauthorized device' });
    next();
}

// SECURE CSV DATASET UPLOAD
app.post('/api/admin/upload-dataset', authenticateToken, (req, res) => {
    const csvData = req.body;
    if (!csvData) return res.status(400).json({ error: "No data provided" });

    const lines = csvData.split('\n').map(l => l.trim()).filter(l => l);

    // Very basic CSV parsing: name,capacity,level
    db.serialize(() => {
        db.run("DELETE FROM reservoirs");
        const stmt = db.prepare("INSERT INTO reservoirs (name, capacity_ml, current_level_ml, status) VALUES (?, ?, ?, ?)");

        let imported = 0;
        // Assume row 0 is header: "Dam Name, Max Capacity, Current Level"
        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(',');
            if (parts.length >= 3) {
                const name = parts[0].trim();
                const cap = parseFloat(parts[1]);
                const cur = parseFloat(parts[2]);
                const status = (cur / cap) < 0.4 ? "Danger" : ((cur / cap) > 0.85 ? "Optimal" : "Normal");
                stmt.run(name, cap, cur, status);
                imported++;
            }
        }
        stmt.finalize();

        createAlert('Audit Log', `Official CWC CSV Dataset manually imported via Admin Portal. Imported ${imported} records.`, 'High');
    });

    res.json({ success: true, message: `Dataset applied securely. ${lines.length - 1} records processed.` });
});

// ADMIN: Notification Targets (Twilio recipients)
app.get('/api/admin/notification-targets', authenticateToken, (req, res) => {
    db.all(`SELECT id, label, phone_e164, enabled, created_at FROM notification_targets ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.post('/api/admin/notification-targets', authenticateToken, (req, res) => {
    const { label, phone_e164, enabled } = req.body || {};
    if (!phone_e164 || typeof phone_e164 !== 'string' || !phone_e164.trim().startsWith('+')) {
        return res.status(400).json({ error: 'phone_e164 must be in +<countrycode><number> format' });
    }
    const en = enabled === 0 || enabled === false ? 0 : 1;
    db.run(
        `INSERT INTO notification_targets (label, phone_e164, enabled) VALUES (?, ?, ?)
         ON CONFLICT(phone_e164) DO UPDATE SET label=excluded.label, enabled=excluded.enabled`,
        [label || null, phone_e164.trim(), en],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.delete('/api/admin/notification-targets/:id', authenticateToken, (req, res) => {
    db.run(`DELETE FROM notification_targets WHERE id = ?`, [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, deleted: this.changes });
    });
});

// IOT SENSOR READING INGESTION
// Expected JSON:
// {
//   "deviceUid": "tank-001",
//   "deviceType": "tank|flow|quality|meter",
//   "metricType": "reservoir_level_ml|flow_rate_ml_per_min|ph|turbidity|oxygen|contamination|zone_usage_ml",
//   "value": 123.4,
//   "unit": "ML|ml/min|pH|NTU|mg/L|bool",
//   "reservoirId": 1,
//   "zoneId": 2,
//   "sector": "Domestic|Agriculture|Industrial",
//   "lat": 0,
//   "lng": 0,
//   "timestamp": "2026-04-06T10:00:00Z"
// }
app.post('/api/iot/reading', authenticateIot, (req, res) => {
    const {
        deviceUid,
        deviceType,
        label,
        metricType,
        value,
        unit,
        reservoirId,
        zoneId,
        sector,
        lat,
        lng,
        timestamp
    } = req.body || {};

    if (!deviceUid || !deviceType || !metricType) return res.status(400).json({ error: 'Missing deviceUid/deviceType/metricType' });
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return res.status(400).json({ error: 'value must be a number' });

    const readingTs = timestamp ? new Date(timestamp) : null;
    if (timestamp && Number.isNaN(readingTs?.getTime?.())) return res.status(400).json({ error: 'Invalid timestamp' });

    db.serialize(() => {
        db.run(
            `INSERT INTO sensor_devices (device_uid, device_type, label, reservoir_id, zone_id, lat, lng, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'Active')
             ON CONFLICT(device_uid) DO UPDATE SET
               device_type=excluded.device_type,
               label=COALESCE(excluded.label, sensor_devices.label),
               reservoir_id=COALESCE(excluded.reservoir_id, sensor_devices.reservoir_id),
               zone_id=COALESCE(excluded.zone_id, sensor_devices.zone_id),
               lat=COALESCE(excluded.lat, sensor_devices.lat),
               lng=COALESCE(excluded.lng, sensor_devices.lng),
               status='Active'`,
            [deviceUid, deviceType, label || null, reservoirId || null, zoneId || null, lat || null, lng || null]
        );

        db.get(`SELECT id, reservoir_id, zone_id FROM sensor_devices WHERE device_uid = ?`, [deviceUid], (err, dev) => {
            if (err || !dev) return res.status(500).json({ error: 'Device lookup failed' });

            const rawJson = JSON.stringify(req.body || {});
            const tsSql = readingTs ? readingTs.toISOString() : null;
            const insertSql = tsSql
                ? `INSERT INTO sensor_readings (device_id, metric_type, value, unit, raw_json, timestamp) VALUES (?, ?, ?, ?, ?, ?)`
                : `INSERT INTO sensor_readings (device_id, metric_type, value, unit, raw_json) VALUES (?, ?, ?, ?, ?)`;
            const insertArgs = tsSql
                ? [dev.id, metricType, numericValue, unit || null, rawJson, tsSql]
                : [dev.id, metricType, numericValue, unit || null, rawJson];

            db.run(insertSql, insertArgs, function (err) {
                if (err) return res.status(500).json({ error: err.message });

                // Update derived tables depending on metric type
                const effectiveReservoirId = reservoirId || dev.reservoir_id;
                const effectiveZoneId = zoneId || dev.zone_id;

                if (metricType === 'zone_usage_ml' && effectiveZoneId) {
                    const sec = (sector || 'Domestic').trim();
                    db.run(
                        `INSERT INTO usage_readings (zone_id, sector, value_ml, timestamp) VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
                        [effectiveZoneId, sec, numericValue, tsSql]
                    );
                }

                if (effectiveReservoirId && metricType === 'reservoir_level_ml') {
                    db.get(`SELECT capacity_ml FROM reservoirs WHERE id = ?`, [effectiveReservoirId], (err, row) => {
                        const cap = row?.capacity_ml || null;
                        let status = null;
                        if (cap && cap > 0) {
                            const ratio = numericValue / cap;
                            status = ratio < 0.4 ? "Danger" : (ratio > 0.85 ? "Optimal" : "Normal");
                        }
                        db.run(
                            `UPDATE reservoirs SET current_level_ml = ?, status = COALESCE(?, status) WHERE id = ?`,
                            [numericValue, status, effectiveReservoirId]
                        );
                        db.run(
                            `INSERT INTO reservoir_history (reservoir_id, current_level_ml, timestamp) VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
                            [effectiveReservoirId, numericValue, tsSql]
                        );
                    });
                }

                if (effectiveReservoirId && (metricType === 'ph' || metricType === 'turbidity' || metricType === 'oxygen')) {
                    const field = metricType;
                    db.run(`UPDATE reservoirs SET ${field} = ? WHERE id = ?`, [numericValue, effectiveReservoirId]);
                }

                // Basic threshold alerts
                if (metricType === 'turbidity' && numericValue > 5) {
                    createAlert('Pollution Detection', `High turbidity detected by sensor (${numericValue} NTU).`, 'High');
                }
                if (metricType === 'ph' && (numericValue < 6.5 || numericValue > 8.5)) {
                    createAlert('Water Quality', `Abnormal pH detected by sensor (${numericValue}).`, 'High');
                }

                // Notify UI in real-time
                sseBroadcast('reading', {
                    id: this.lastID,
                    deviceUid,
                    metricType,
                    value: numericValue,
                    unit: unit || null,
                    reservoirId: effectiveReservoirId || null,
                    zoneId: effectiveZoneId || null,
                    timestamp: tsSql || new Date().toISOString()
                });

                res.json({ success: true, readingId: this.lastID });
            });
        });
    });
});


// GET base dashboard stats
app.get('/api/dashboard', (req, res) => {
    db.all("SELECT SUM(capacity_ml) as totalCapacity, SUM(current_level_ml) as totalCurrent FROM reservoirs", [], (err, summary) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(summary[0]);
    });
});

app.get('/api/reservoirs', (req, res) => {
    db.all("SELECT * FROM reservoirs", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/zones', (req, res) => {
    db.all("SELECT * FROM zones", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/alerts', (req, res) => {
    db.all("SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 5", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// USAGE ANALYTICS (time-series)
// range: daily|weekly|monthly  (default: daily)
// optional: zoneId
app.get('/api/usage', (req, res) => {
    const range = (req.query.range || 'daily').toString().toLowerCase();
    const zoneId = req.query.zoneId ? Number(req.query.zoneId) : null;

    const bucket =
        // daily: minute-level trend points
        range === 'daily' ? "%Y-%m-%d %H:%M" :
        // weekly: per-day trend
        range === 'weekly' ? "%Y-%m-%d" :
        // monthly: per-month trend
        "%Y-%m";

    const where = [];
    const params = [];
    if (zoneId && Number.isFinite(zoneId)) {
        where.push('zone_id = ?');
        params.push(zoneId);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    db.all(
        `SELECT strftime('${bucket}', timestamp) AS bucket,
                sector,
                SUM(value_ml) AS total_ml
         FROM usage_readings
         ${whereSql}
         GROUP BY bucket, sector
         ORDER BY bucket ASC`,
        params,
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ range, zoneId, series: rows || [] });
        }
    );
});

// WATER QUALITY (latest snapshots)
app.get('/api/quality/latest', (req, res) => {
    db.all(
        `SELECT id, name, ph, turbidity, oxygen, current_level_ml, capacity_ml, status
         FROM reservoirs
         ORDER BY name ASC`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// WATER QUALITY (history from sensor readings, if present)
app.get('/api/quality/history', (req, res) => {
    const reservoirId = req.query.reservoirId ? Number(req.query.reservoirId) : null;
    if (!reservoirId || !Number.isFinite(reservoirId)) return res.status(400).json({ error: 'reservoirId is required' });

    db.all(
        `SELECT sr.metric_type, sr.value, sr.unit, sr.timestamp, sd.device_uid
         FROM sensor_readings sr
         JOIN sensor_devices sd ON sr.device_id = sd.id
         WHERE sd.reservoir_id = ?
           AND sr.metric_type IN ('ph','turbidity','oxygen')
         ORDER BY sr.timestamp ASC
         LIMIT 500`,
        [reservoirId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        }
    );
});

// ML Predictions & Weather
app.get('/api/predict', async (req, res) => {
    try {
        // Fetch mock weather for a central point (Nagpur approx: 21.1, 79.0) to simplify
        const weatherRes = await fetch("https://api.open-meteo.com/v1/forecast?latitude=21.1&longitude=79.0&daily=precipitation_sum&timezone=auto");
        const weatherData = await weatherRes.json();
        const rain3Days = weatherData.daily.precipitation_sum.slice(0, 3).reduce((a, b) => a + b, 0);

        db.all("SELECT SUM(capacity_ml) as totalCap, SUM(current_level_ml) as totalCur FROM reservoirs", [], (err, resData) => {
            if (err || !resData[0] || !resData[0].totalCap) return res.status(500).json({ error: "Missing reservoir data" });

            db.all("SELECT * FROM zones", [], async (err, zones) => {
                if (err) return res.status(500).json({ error: err.message });

                const predictions = zones.map(zone => {
                    // Factoring in rain: if it rains more than 10mm, risk goes down
                    const rainRelief = (rain3Days > 10) ? 0.1 : 0;
                    const aiResult = ml.predictShortageRisk(resData[0].totalCur, resData[0].totalCap, zone.daily_usage_ml);
                    let riskScore = Math.max(0, aiResult.riskScore - rainRelief);
                    let status = riskScore > 0.8 ? "CRITICAL" : (riskScore > 0.5 ? "WARNING" : "STABLE");

                    return {
                        zone: zone.name,
                        usage: zone.daily_usage_ml,
                        aiRiskScore: (riskScore * 100).toFixed(1) + "%",
                        predictedDaysLeft: aiResult.predictedDays + (rain3Days > 10 ? 5 : 0), // buffer days
                        rainForecastMm: rain3Days.toFixed(1),
                        status: status
                    };
                });
                
                try {
                    // Call Gemini for smart recommendations
                    const prompt = `You are a Smart City Water AI. Analyze this zone data and provide exactly one short actionable recommendation for each zone (e.g. 'Reduce supply by 10%', 'Maintain flow', 'Increase pressure'). Data: ${JSON.stringify(predictions)}. Respond ONLY with a valid JSON array of strings in the exact same order. Never include markdown formatting like \`\`\`json.`;
                    
                    const response = await ai.models.generateContent({
                        model: 'gemini-1.5-flash',
                        contents: prompt
                    });
                    
                    const texts = JSON.parse(response.text.replace(/```json|```/g, '').trim());
                    texts.forEach((txt, i) => {
                        if (predictions[i]) predictions[i].recommendation = txt;
                    });
                } catch(e) {
                    // Fallback if API fails or no key
                    predictions.forEach(p => p.recommendation = "Monitor actively.");
                }

                res.json(predictions);
            });
        });
    } catch (e) {
        res.status(500).json({ error: "Weather API failed" });
    }
});

// Forecasting: Rainfall (Open-Meteo)
app.get('/api/forecast/rainfall', async (req, res) => {
    const lat = req.query.lat ? Number(req.query.lat) : 21.1;
    const lng = req.query.lng ? Number(req.query.lng) : 79.0;
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&daily=precipitation_sum&timezone=auto`;
        const weatherRes = await fetch(url);
        const weatherData = await weatherRes.json();
        res.json({
            lat,
            lng,
            daily: weatherData?.daily || null
        });
    } catch {
        res.status(500).json({ error: 'Weather API failed' });
    }
});

// Forecasting: Demand (simple rolling average + trend)
app.get('/api/forecast/demand', (req, res) => {
    db.all(
        `SELECT strftime('%Y-%m-%d', timestamp) AS day, SUM(value_ml) AS total_ml
         FROM usage_readings
         GROUP BY day
         ORDER BY day DESC
         LIMIT 14`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const hist = (rows || []).reverse();
            const last7 = hist.slice(-7);
            const avg = last7.length ? last7.reduce((a, r) => a + (r.total_ml || 0), 0) / last7.length : null;

            if (!avg) {
                db.get(`SELECT SUM(daily_usage_ml) AS baseline_ml FROM zones`, [], (err, z) => {
                    const base = z?.baseline_ml || 0;
                    res.json({ model: 'baseline', baselineMlPerDay: base, forecast: [{ dayOffset: 1, predicted_ml: base }] });
                });
                return;
            }

            // tiny linear trend using last 7 days (difference between last and first / 6)
            const trend = last7.length >= 2 ? ((last7[last7.length - 1].total_ml - last7[0].total_ml) / Math.max(1, last7.length - 1)) : 0;
            const forecast = Array.from({ length: 7 }).map((_, i) => ({
                dayOffset: i + 1,
                predicted_ml: Math.max(0, avg + trend * (i + 1))
            }));

            res.json({ model: 'rolling_avg_trend', history: hist, avgMlPerDay: avg, trendMlPerDay: trend, forecast });
        }
    );
});

// Forecasting: Reservoir depletion (grid-level)
app.get('/api/forecast/reservoir-depletion', (req, res) => {
    db.get(
        `SELECT SUM(capacity_ml) AS totalCapacity, SUM(current_level_ml) AS totalCurrent FROM reservoirs`,
        [],
        (err, grid) => {
            if (err) return res.status(500).json({ error: err.message });
            const totalCurrent = grid?.totalCurrent || 0;
            const totalCapacity = grid?.totalCapacity || 0;

            db.get(`SELECT SUM(daily_usage_ml) AS baseline_ml FROM zones`, [], (err, z) => {
                const baseline = z?.baseline_ml || 0;
                const demand = baseline > 0 ? baseline : 1;
                const daysLeft = Math.max(0, Math.round(totalCurrent / demand));
                res.json({ totalCapacity, totalCurrent, demandMlPerDay: baseline, predictedDaysLeft: daysLeft });
            });
        }
    );
});

// Leakage / anomaly detection (based on latest reservoir history deltas)
app.get('/api/anomalies', (req, res) => {
    db.all(`SELECT id, name, capacity_ml FROM reservoirs`, [], (err, reservoirs) => {
        if (err) return res.status(500).json({ error: err.message });
        const list = reservoirs || [];
        if (!list.length) return res.json([]);

        const anomalies = [];
        let pending = list.length;

        list.forEach(r => {
            db.all(
                `SELECT current_level_ml, timestamp
                 FROM reservoir_history
                 WHERE reservoir_id = ?
                 ORDER BY timestamp DESC
                 LIMIT 2`,
                [r.id],
                (err, hist) => {
                    if (!err && hist && hist.length === 2 && r.capacity_ml) {
                        const latest = hist[0];
                        const prev = hist[1];
                        const drop = (prev.current_level_ml || 0) - (latest.current_level_ml || 0);
                        const dropPct = drop / r.capacity_ml;
                        if (dropPct >= 0.05) {
                            anomalies.push({
                                reservoirId: r.id,
                                name: r.name,
                                previousLevelMl: prev.current_level_ml,
                                latestLevelMl: latest.current_level_ml,
                                dropMl: drop,
                                dropPct: +(dropPct * 100).toFixed(2),
                                timestamp: latest.timestamp,
                                severity: dropPct >= 0.1 ? 'High' : 'Medium'
                            });
                        }
                    }
                    pending--;
                    if (pending === 0) res.json(anomalies);
                }
            );
        });
    });
});

// REPORTS: Excel exports
app.get('/api/reports/alerts.xlsx', async (req, res) => {
    db.all(`SELECT id, type, message, severity, timestamp FROM alerts ORDER BY timestamp DESC LIMIT 500`, [], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Alerts');
        ws.columns = [
            { header: 'ID', key: 'id', width: 8 },
            { header: 'Type', key: 'type', width: 22 },
            { header: 'Severity', key: 'severity', width: 10 },
            { header: 'Timestamp', key: 'timestamp', width: 22 },
            { header: 'Message', key: 'message', width: 80 }
        ];
        (rows || []).forEach(r => ws.addRow(r));
        ws.getRow(1).font = { bold: true };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="HydroGrid-Alerts.xlsx"');
        await wb.xlsx.write(res);
        res.end();
    });
});

app.get('/api/reports/usage.xlsx', async (req, res) => {
    db.all(
        `SELECT z.name AS zone, u.sector, u.value_ml, u.timestamp
         FROM usage_readings u
         JOIN zones z ON u.zone_id = z.id
         ORDER BY u.timestamp DESC
         LIMIT 2000`,
        [],
        async (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });

            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Usage');
            ws.columns = [
                { header: 'Zone', key: 'zone', width: 22 },
                { header: 'Sector', key: 'sector', width: 14 },
                { header: 'Usage (ML)', key: 'value_ml', width: 14 },
                { header: 'Timestamp', key: 'timestamp', width: 22 }
            ];
            (rows || []).forEach(r => ws.addRow(r));
            ws.getRow(1).font = { bold: true };

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename="HydroGrid-Usage.xlsx"');
            await wb.xlsx.write(res);
            res.end();
        }
    );
});

app.get('/api/reports/quality.xlsx', async (req, res) => {
    db.all(
        `SELECT id, name, ph, turbidity, oxygen, status, current_level_ml, capacity_ml FROM reservoirs ORDER BY name ASC`,
        [],
        async (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });

            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Quality');
            ws.columns = [
                { header: 'Reservoir ID', key: 'id', width: 12 },
                { header: 'Name', key: 'name', width: 26 },
                { header: 'pH', key: 'ph', width: 8 },
                { header: 'Turbidity (NTU)', key: 'turbidity', width: 16 },
                { header: 'Oxygen (mg/L)', key: 'oxygen', width: 14 },
                { header: 'Status', key: 'status', width: 12 },
                { header: 'Current (ML)', key: 'current_level_ml', width: 14 },
                { header: 'Capacity (ML)', key: 'capacity_ml', width: 14 }
            ];
            (rows || []).forEach(r => ws.addRow(r));
            ws.getRow(1).font = { bold: true };

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename="HydroGrid-Quality.xlsx"');
            await wb.xlsx.write(res);
            res.end();
        }
    );
});

// Add History Route
app.get('/api/history', (req, res) => {
    db.all("SELECT reservoir_history.*, reservoirs.name FROM reservoir_history JOIN reservoirs ON reservoir_history.reservoir_id = reservoirs.id ORDER BY timestamp ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Complaints Route
app.post('/api/complaints', (req, res) => {
    const { user_name, type, location, description } = req.body;
    db.run(`INSERT INTO complaints (user_name, type, location, description) VALUES (?, ?, ?, ?)`, [user_name, type, location, description], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        createAlert('Citizen Complaint', `New ${type} at ${location}.`, 'Low', { notifySms: false });
        res.json({ success: true });
    });
});

// Gamification Route
app.get('/api/user', (req, res) => {
    db.get(`SELECT * FROM smart_users WHERE username = 'guest'`, (err, row) => {
        res.json(row || { water_saver_score: 0 });
    });
});

// AI Chatbot Route (Streamlines basic user queries)
app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: "Missing message" });
        
        let dbContext = "No DB data fetched";
        // Fetch a quick DB summary to feed Gemini as Context
        await new Promise((resolve) => {
            db.all("SELECT SUM(capacity_ml) as totalCap, SUM(current_level_ml) as totalCur FROM reservoirs", [], (err, sum) => {
                dbContext = `Current Total Grid Level is ${sum[0].totalCur} out of ${sum[0].totalCap} ML.`;
                resolve();
            });
        });

        const prompt = `Context: ${dbContext}\nYou are HydroGrid AI, a helpful virtual assistant for water management. Respond concisely to the user. User says: "${message}"`;
        
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: prompt
        });
        
        res.json({ reply: response.text });
    } catch(e) {
        res.status(500).json({ reply: "I am having trouble connecting to my neural core right now." });
    }
});

// SIMULATE LIVE DATA SYNC
app.post('/api/sync', (req, res) => {
    db.all("SELECT * FROM reservoirs", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        if (rows.length === 0) {
            // Seed some default reservoirs if empty
            const defaults = [
                { name: 'Bhakra Dam', cap: 9340, lat: 31.411, lng: 76.433 },
                { name: 'Tehri Dam', cap: 4000, lat: 30.378, lng: 78.480 },
                { name: 'Sardar Sarovar', cap: 9500, lat: 21.830, lng: 73.748 },
                { name: 'Hirakud Dam', cap: 8136, lat: 21.527, lng: 83.873 },
                { name: 'Nagarjuna Sagar', cap: 11472, lat: 16.577, lng: 79.314 }
            ];

            db.serialize(() => {
                const stmt = db.prepare("INSERT INTO reservoirs (name, capacity_ml, current_level_ml, status, lat, lng, ph, turbidity, oxygen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
                const histStmt = db.prepare("INSERT INTO reservoir_history (reservoir_id, current_level_ml, timestamp) VALUES (?, ?, datetime('now', ?))");

                defaults.forEach((d, i) => {
                    const id = i + 1;
                    const cur = d.cap * (0.5 + Math.random() * 0.2);
                    const ph = 7.0 + (Math.random() * 1.0 - 0.5); // 6.5 to 7.5
                    const turb = 2.0 + Math.random() * 3.0; // 2.0 to 5.0 NTU
                    const oxy = 8.0 + (Math.random() * 2.0 - 1.0); // 7.0 to 9.0 mg/L

                    stmt.run(d.name, d.cap, cur, "Normal", d.lat, d.lng, ph, turb, oxy);

                    // Seed 10 days of history
                    for (let day = 10; day >= 0; day--) {
                        let pastCur = cur + (Math.random() * 0.1 * d.cap - 0.05 * d.cap); // Random past
                        histStmt.run(id, pastCur, `-${day} days`);
                    }
                });
                stmt.finalize();
                histStmt.finalize();
                createAlert('System', 'Automated reservoir monitoring initialized.', 'Low', { notifySms: false });
                db.get("SELECT 1", () => {
                    res.json({ success: true, message: "Initialized automated reservoirs." });
                });
            });
        } else {
            db.serialize(() => {
                const stmt = db.prepare("UPDATE reservoirs SET current_level_ml = ?, status = ?, ph = ?, turbidity = ?, oxygen = ? WHERE id = ?");
                const histStmt = db.prepare("INSERT INTO reservoir_history (reservoir_id, current_level_ml) VALUES (?, ?)");
                let dangerAlertSent = false;

                // Generate usage readings for analytics (one snapshot per sync)
                db.all("SELECT * FROM zones", [], (err, zones) => {
                    if (!err && zones && zones.length) {
                        zones.forEach(z => {
                            const base = Number(z.daily_usage_ml) || 0;
                            // Add small random noise so line charts look alive
                            const noisy = base * (0.95 + Math.random() * 0.1);
                            const dom = noisy * ((z.domestic_pct || 60) / 100);
                            const ag = noisy * ((z.agriculture_pct || 10) / 100);
                            const ind = noisy * ((z.industrial_pct || 30) / 100);
                            db.run("INSERT INTO usage_readings (zone_id, sector, value_ml) VALUES (?, ?, ?)", [z.id, 'Domestic', dom]);
                            db.run("INSERT INTO usage_readings (zone_id, sector, value_ml) VALUES (?, ?, ?)", [z.id, 'Agriculture', ag]);
                            db.run("INSERT INTO usage_readings (zone_id, sector, value_ml) VALUES (?, ?, ?)", [z.id, 'Industrial', ind]);
                        });
                    }
                });

                rows.forEach(r => {
                    let change = r.capacity_ml * (Math.random() * 0.04 - 0.02); // -2% to +2%
                    let isAnomaly = false;
                    
                    // Simulate Anomaly/Leakage: 5% chance of sudden 5% drop
                    if (Math.random() < 0.05) {
                        change = -(r.capacity_ml * 0.05); // 5% drop
                        isAnomaly = true;
                    }

                    let newLevel = r.current_level_ml + change;
                    if (newLevel > r.capacity_ml) newLevel = r.capacity_ml;
                    if (newLevel < 0) newLevel = 0;

                    const ratio = newLevel / r.capacity_ml;
                    const status = ratio < 0.4 ? "Danger" : (ratio > 0.85 ? "Optimal" : "Normal");

                    const newPh = r.ph ? r.ph + (Math.random() * 0.2 - 0.1) : 7.2;
                    let newTurb = r.turbidity ? r.turbidity + (Math.random() * 0.5 - 0.25) : 3.5;
                    if (newTurb < 0) newTurb = 0.1;
                    let newOxy = r.oxygen ? r.oxygen + (Math.random() * 0.4 - 0.2) : 7.5;
                    if (newOxy < 0) newOxy = 0;

                    stmt.run(newLevel, status, newPh, newTurb, newOxy, r.id);
                    histStmt.run(r.id, newLevel);

                    // Mock Email condition
                    if (status === 'Danger' && transporter && !dangerAlertSent && !isAnomaly) {
                        dangerAlertSent = true; // max 1 email per sync to prevent spam
                        let mailOptions = {
                            from: '"HydroGrid Alerts" <alerts@hydrogrid.local>',
                            to: "city.authority@gov.in",
                            subject: `CRITICAL: ${r.name} Water Level Danger`,
                            text: `${r.name} has dropped below 40% capacity. Current Level: ${Math.round(newLevel)} ML. Immediate action required.`
                        };
                        transporter.sendMail(mailOptions, (error, info) => {
                            if (!error) {
                                const url = nodemailer.getTestMessageUrl(info);
                                // Insert link to click
                                db.run(`INSERT INTO alerts (type, message, severity) VALUES ('Email Dispatched', 'Critical warning sent to authorities. <a href="${url}" target="_blank" style="color:#00d2ff;">View Email</a>', 'High')`);
                            }
                        });
                    }
                    
                    if (isAnomaly) {
                        createAlert('Leak Detected', `Anomaly: Sudden 5% volume drop observed at ${r.name}. Possible major leakage or unrecorded discharge. Investigating pipeline...`, 'High');
                    }
                });
                stmt.finalize();
                histStmt.finalize();
                // Random chance to create a new alert on sync
                if (Math.random() < 0.3 && !dangerAlertSent) {
                    createAlert('Sensor Sync', 'Live data synchronized. Minor fluctuations detected.', 'Low', { notifySms: false });
                }
                db.get("SELECT 1", () => {
                    res.json({ success: true, message: "Live data synced successfully." });
                });
            });
        }
    });
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
