const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'database.sqlite');
const isInitialRun = !fs.existsSync(dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        ensureSchema(() => {
            if (isInitialRun) {
                seedInitialData();
            }
        });
    }
});

function ensureSchema(cb = () => {}) {
    db.serialize(() => {
        // Core tables (safe for existing DBs)
        db.run(`CREATE TABLE IF NOT EXISTS admin_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password_hash TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS reservoirs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            capacity_ml REAL,
            current_level_ml REAL,
            status TEXT,
            lat REAL,
            lng REAL,
            ph REAL,
            turbidity REAL,
            oxygen REAL
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS reservoir_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reservoir_id INTEGER,
            current_level_ml REAL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(reservoir_id) REFERENCES reservoirs(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS zones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            daily_usage_ml REAL NOT NULL,
            population INTEGER,
            domestic_pct REAL,
            agriculture_pct REAL,
            industrial_pct REAL
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            severity TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS complaints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_name TEXT,
            type TEXT,
            location TEXT,
            description TEXT,
            status TEXT DEFAULT 'Open',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS smart_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            water_saver_score INTEGER DEFAULT 0
        )`);

        // New feature tables (sensors/usage/notifications)
        db.run(`CREATE TABLE IF NOT EXISTS sensor_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_uid TEXT UNIQUE NOT NULL,
            device_type TEXT NOT NULL,
            label TEXT,
            reservoir_id INTEGER,
            zone_id INTEGER,
            lat REAL,
            lng REAL,
            status TEXT DEFAULT 'Active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(reservoir_id) REFERENCES reservoirs(id),
            FOREIGN KEY(zone_id) REFERENCES zones(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS sensor_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id INTEGER,
            metric_type TEXT NOT NULL,
            value REAL NOT NULL,
            unit TEXT,
            raw_json TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(device_id) REFERENCES sensor_devices(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS usage_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            zone_id INTEGER NOT NULL,
            sector TEXT NOT NULL,
            value_ml REAL NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(zone_id) REFERENCES zones(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS notification_targets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT,
            phone_e164 TEXT UNIQUE NOT NULL,
            enabled INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Simple IoT API key store (can be rotated by admin in future)
        db.run(`CREATE TABLE IF NOT EXISTS iot_api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT,
            api_key TEXT UNIQUE NOT NULL,
            enabled INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.get('SELECT 1', [], cb);
    });
}

function seedInitialData() {
    db.serialize(() => {
        // --- Seed Default Encrypted Admin ---
        // admin123
        const salt = bcrypt.genSaltSync(10);
        const pHash = bcrypt.hashSync("admin123", salt);
        db.run(`INSERT OR IGNORE INTO admin_users (username, password_hash) VALUES ('admin', ?)`, [pHash]);

        // Seed Data
        db.run("INSERT OR IGNORE INTO zones (id, name, daily_usage_ml, population, domestic_pct, agriculture_pct, industrial_pct) VALUES (1,'Delhi NCR', 250, 15000000, 60, 10, 30), (2,'Mumbai Metro', 320, 20000000, 50, 5, 45), (3,'Bangalore Tech Hub', 180, 11000000, 55, 5, 40), (4,'Chennai Coastal', 150, 9000000, 50, 15, 35)");
        db.run("INSERT OR IGNORE INTO smart_users (username, water_saver_score) VALUES ('guest', 150)");

        // Default IoT key for local dev (override with env in production)
        db.run("INSERT OR IGNORE INTO iot_api_keys (label, api_key, enabled) VALUES ('default-dev', 'dev-iot-key', 1)");

        console.log("Database initialized with seed data and feature tables.");
    });
}

module.exports = db;
