const API_BASE = (window.HYDROGRID_CONFIG && window.HYDROGRID_CONFIG.API_BASE) ? window.HYDROGRID_CONFIG.API_BASE : 'http://localhost:3000/api';
const formatNumber = (num) => new Intl.NumberFormat().format(Math.round(num));
const timeAgo = (dateStr) => {
    const min = Math.round((new Date() - new Date(dateStr)) / 60000);
    return min < 60 ? `${min}m ago` : `${Math.round(min/60)}h ago`;
};

function getCanvasCtx(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const ctx = el.getContext && el.getContext('2d');
    return ctx || null;
}

function applyChartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.color = 'rgba(230, 230, 230, 0.72)';
    Chart.defaults.font.family = "'Outfit', system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
}

function modernChartOptions({ stacked = false } = {}) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: {
                position: 'bottom',
                labels: { padding: 16 }
            },
            tooltip: {
                backgroundColor: 'rgba(11, 18, 32, 0.92)',
                borderColor: 'rgba(255,255,255,0.08)',
                borderWidth: 1,
                padding: 12,
                displayColors: true
            }
        },
        scales: {
            x: {
                stacked,
                grid: { color: 'rgba(255,255,255,0.06)' },
                ticks: { color: 'rgba(228, 230, 235, 0.65)' }
            },
            y: {
                stacked,
                grid: { color: 'rgba(255,255,255,0.06)' },
                ticks: { color: 'rgba(228, 230, 235, 0.65)' }
            }
        },
        elements: {
            line: { borderWidth: 2 },
            point: { radius: 2, hoverRadius: 5 }
        }
    };
}

let chartInstance = null;
let historyChartInstance = null;
let usageTrendChartInstance = null;
let qualityChartInstance = null;
let liveLevelChartInstance = null;
let liveFlowChartInstance = null;
let mapInstance = null;
let googleMapInstance = null;
let googleHeatmapLayer = null;
let googleMarkers = [];
let googlePipeline = null;
let googleMapsLoadingPromise = null;
let currentJWT = localStorage.getItem('hydrogrid_admin_jwt') || null;
let currentUsageRange = 'daily';

// In-memory “live” buffers (fed by SSE)
const liveBuffers = {
    level: [], // {t, v}
    flow: []   // {t, v}
};

// Ensure auth headers are passed if we have a JWT
async function fetchAPI(endpoint, options = {}) {
    const headers = { ...options.headers };
    if (currentJWT) headers['Authorization'] = `Bearer ${currentJWT}`;
    
    const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
    if (!res.ok) throw new Error("API call failed");
    return res.json();
}

// --- REAL-TIME STREAM (SSE) ---
function startRealtimeStream() {
    try {
        const es = new EventSource(`${API_BASE}/stream`);
        es.addEventListener('reading', (evt) => {
            try {
                const r = JSON.parse(evt.data);
                const t = new Date(r.timestamp || Date.now()).toLocaleTimeString();
                if (r.metricType === 'reservoir_level_ml') {
                    liveBuffers.level.push({ t, v: Number(r.value) });
                    if (liveBuffers.level.length > 40) liveBuffers.level.shift();
                    if (liveLevelChartInstance) {
                        liveLevelChartInstance.data.labels = liveBuffers.level.map(p => p.t);
                        liveLevelChartInstance.data.datasets[0].data = liveBuffers.level.map(p => p.v);
                        liveLevelChartInstance.update('none');
                    }
                }
                if (r.metricType === 'flow_rate_ml_per_min') {
                    liveBuffers.flow.push({ t, v: Number(r.value) });
                    if (liveBuffers.flow.length > 40) liveBuffers.flow.shift();
                    if (liveFlowChartInstance) {
                        liveFlowChartInstance.data.labels = liveBuffers.flow.map(p => p.t);
                        liveFlowChartInstance.data.datasets[0].data = liveBuffers.flow.map(p => p.v);
                        liveFlowChartInstance.update('none');
                    }
                }
            } catch { /* ignore */ }
        });

        es.addEventListener('alert', () => {
            // Refresh dashboard alerts if user is on dashboard
            const dash = document.getElementById('view-dashboard');
            if (dash && dash.classList.contains('active')) renderDashboard();
        });

        es.onerror = () => {
            // Browser will auto-reconnect; keep silent
        };
    } catch (e) {
        console.warn("SSE not available", e);
    }
}

async function renderDashboard() {
    try {
        const [sum, alerts] = await Promise.all([fetchAPI('/dashboard'), fetchAPI('/alerts')]);
        document.querySelector('.metric-value').textContent = formatNumber(sum.totalCurrent);
        const percentage = ((sum.totalCurrent / sum.totalCapacity) * 100).toFixed(1);
        setTimeout(() => {
            document.getElementById('total-capacity-bar').style.width = `${percentage}%`;
            document.getElementById('capacity-percent').textContent = `${percentage}% Capacity`;
        }, 100);

        // Render Alerts with interactive data-id
        const listEl = document.getElementById('alerts-list');
        listEl.innerHTML = alerts.map(a => `
            <li class="alert-item ${a.severity.includes('High') ? 'High' : 'Low'}" onclick="dismissAlert(this)">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span class="alert-type"><i data-lucide="${a.severity.includes('High') ? 'alert-triangle' : 'info'}" style="width:14px; height:14px; margin-right:4px;"></i>${a.type}</span>
                    <span class="alert-time">${timeAgo(a.timestamp)}</span>
                </div>
                <span class="alert-msg">${a.message}</span>
            </li>
        `).join('');
        lucide.createIcons();
    } catch (e) { console.error(e); }
}

// Function to handle interactive alert dismissal
window.dismissAlert = (element) => {
    // Add CSS class to trigger sliding animation
    element.classList.add('acknowledged');
    setTimeout(() => {
        element.remove();
        // Check if no alerts left
        const listEl = document.getElementById('alerts-list');
        if (listEl.children.length === 0) {
            listEl.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding: 20px;">All caught up! No active alerts.</p>';
        }
    }, 400); // Matches CSS animation duration
}

async function renderReservoirs() {
    try {
        const data = await fetchAPI('/reservoirs');
        document.getElementById('reservoirs-grid-full').innerHTML = data.map((r, i) => {
            const pct = ((r.current_level_ml / r.capacity_ml) * 100).toFixed(1);
            return `
            <div class="card glass-card reservoir-card" style="animation-delay: ${i*0.1}s; cursor:pointer;" onclick="openHistoryModal(${r.id}, '${r.name}')">
                <div class="res-header">
                    <h4 style="max-width: 70%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${r.name}">${r.name}</h4>
                    <span class="status-badge status-${r.status.split(' ')[0]}">${r.status}</span>
                </div>
                <div class="res-stats">
                    <div class="res-stat-row"><span>Current</span><span class="value">${formatNumber(r.current_level_ml)} ML</span></div>
                    <div class="res-stat-row"><span>Max</span><span class="value">${formatNumber(r.capacity_ml)} ML</span></div>
                    <div class="progress-bar-container">
                        <div class="progress-bar" style="width: ${pct}%; background: ${pct < 40 ? 'var(--danger)' : 'var(--primary)'}"></div>
                    </div>
                    ${r.ph ? `
                    <div style="display:flex; justify-content:space-between; margin-top:10px; font-size:0.8rem; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 8px; color:var(--text-muted);">
                        <span title="pH Level"><i data-lucide="activity" style="width:12px; height:12px;"></i> ${r.ph.toFixed(1)}</span>
                        <span title="Turbidity (NTU)"><i data-lucide="alert-circle" style="width:12px; height:12px;"></i> ${r.turbidity.toFixed(1)} NTU</span>
                        <span title="Dissolved Oxygen"><i data-lucide="wind" style="width:12px; height:12px;"></i> ${r.oxygen.toFixed(1)} mg/L</span>
                    </div>
                    ` : ''}
                </div>
            </div>`;
        }).join('');
        lucide.createIcons();
    } catch (e) { console.error(e); }
}

async function renderAnalytics() {
    try {
        const data = await fetchAPI('/zones');
        applyChartDefaults();
        const ctx = getCanvasCtx('zonesChart');
        if (!ctx) return;
        if (chartInstance) chartInstance.destroy();
        
        chartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.map(z => z.name),
                datasets: [
                    {
                        label: 'Domestic',
                        data: data.map(z => z.daily_usage_ml * ((z.domestic_pct || 60)/100)),
                        backgroundColor: '#F5C84C',
                        borderRadius: 10,
                        borderSkipped: false
                    },
                    {
                        label: 'Agriculture',
                        data: data.map(z => z.daily_usage_ml * ((z.agriculture_pct || 10)/100)),
                        backgroundColor: '#BDBDBD',
                        borderRadius: 10,
                        borderSkipped: false
                    },
                    {
                        label: 'Industrial',
                        data: data.map(z => z.daily_usage_ml * ((z.industrial_pct || 30)/100)),
                        backgroundColor: '#E6E6E6',
                        borderRadius: 10,
                        borderSkipped: false
                    }
                ]
            },
            options: modernChartOptions({ stacked: true })
        });

        await renderUsageTrend(currentUsageRange);
    } catch (e) { console.error(e); }
}

async function renderUsageTrend(range = 'daily') {
    try {
        applyChartDefaults();
        const data = await fetchAPI(`/usage?range=${encodeURIComponent(range)}`);
        const rows = data.series || [];
        const buckets = [...new Set(rows.map(r => r.bucket))];
        const totals = buckets.map(b => {
            const sum = rows.filter(r => r.bucket === b).reduce((a, r) => a + (r.total_ml || 0), 0);
            return sum;
        });

        const ctx = getCanvasCtx('usageTrendChart');
        if (!ctx) return;
        if (usageTrendChartInstance) usageTrendChartInstance.destroy();

        if (!buckets.length) {
            usageTrendChartInstance = new Chart(ctx, {
                type: 'line',
                data: { labels: ['No usage data yet'], datasets: [{ label: 'Total Usage', data: [0], borderColor: 'rgba(245,200,76,0.25)' }] },
                options: modernChartOptions()
            });
            return;
        }

        const gradient = ctx.createLinearGradient(0, 0, 0, 260);
        gradient.addColorStop(0, 'rgba(245, 200, 76, 0.24)');
        gradient.addColorStop(1, 'rgba(245, 200, 76, 0.02)');

        usageTrendChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: buckets,
                datasets: [{
                    label: `Total Usage (${range})`,
                    data: totals,
                    borderColor: '#F5C84C',
                    backgroundColor: gradient,
                    fill: true,
                    tension: 0.35,
                    pointRadius: 2
                }]
            },
            options: modernChartOptions()
        });
    } catch (e) {
        console.error(e);
    }
}

async function renderLive() {
    try {
        applyChartDefaults();

        const levelCtx = getCanvasCtx('liveLevelChart');
        if (!levelCtx) return;
        if (liveLevelChartInstance) liveLevelChartInstance.destroy();

        const levelGradient = levelCtx.createLinearGradient(0, 0, 0, 260);
        levelGradient.addColorStop(0, 'rgba(245, 200, 76, 0.22)');
        levelGradient.addColorStop(1, 'rgba(245, 200, 76, 0.02)');

        // Seed charts from existing reservoir history if we have no live points yet.
        if (liveBuffers.level.length === 0) {
            try {
                const historyData = await fetchAPI('/history');
                // Pick the reservoir with most points (or first)
                const byRes = new Map();
                (historyData || []).forEach(h => {
                    if (!h || !h.reservoir_id) return;
                    const arr = byRes.get(h.reservoir_id) || [];
                    arr.push(h);
                    byRes.set(h.reservoir_id, arr);
                });
                const first = [...byRes.values()].sort((a, b) => b.length - a.length)[0] || [];
                const slice = first.slice(-25);
                liveBuffers.level = slice.map(h => ({
                    t: new Date(h.timestamp).toLocaleTimeString(),
                    v: Number(h.current_level_ml)
                }));

                // Approximate flow rate from history delta (ML per interval)
                if (liveBuffers.flow.length === 0 && slice.length >= 2) {
                    liveBuffers.flow = slice.slice(1).map((h, idx) => {
                        const prev = slice[idx];
                        const dv = Number(h.current_level_ml) - Number(prev.current_level_ml);
                        return { t: new Date(h.timestamp).toLocaleTimeString(), v: dv };
                    });
                }
            } catch (e) {
                console.warn('Live seed failed', e);
            }
        }

        liveLevelChartInstance = new Chart(levelCtx, {
            type: 'line',
            data: {
                labels: liveBuffers.level.map(p => p.t),
                datasets: [{
                    label: 'Reservoir Level (ML)',
                    data: liveBuffers.level.map(p => p.v),
                    borderColor: '#F5C84C',
                    backgroundColor: levelGradient,
                    fill: true,
                    tension: 0.35,
                    pointRadius: 2
                }]
            },
            options: modernChartOptions()
        });

        const flowCtx = getCanvasCtx('liveFlowChart');
        if (!flowCtx) return;
        if (liveFlowChartInstance) liveFlowChartInstance.destroy();

        const flowGradient = flowCtx.createLinearGradient(0, 0, 0, 260);
        flowGradient.addColorStop(0, 'rgba(189, 189, 189, 0.22)');
        flowGradient.addColorStop(1, 'rgba(189, 189, 189, 0.02)');

        liveFlowChartInstance = new Chart(flowCtx, {
            type: 'line',
            data: {
                labels: liveBuffers.flow.map(p => p.t),
                datasets: [{
                    label: 'Flow Rate (Δ ML per check)',
                    data: liveBuffers.flow.map(p => p.v),
                    borderColor: '#BDBDBD',
                    backgroundColor: flowGradient,
                    fill: true,
                    tension: 0.35,
                    pointRadius: 2
                }]
            },
            options: modernChartOptions()
        });
    } catch (e) {
        console.error(e);
    }
}

async function renderQuality() {
    try {
        const data = await fetchAPI('/quality/latest');
        const grid = document.getElementById('quality-grid-full');
        grid.innerHTML = (data || []).map((r, i) => {
            const ph = (r.ph === null || r.ph === undefined) ? '--' : r.ph.toFixed(1);
            const turb = (r.turbidity === null || r.turbidity === undefined) ? '--' : r.turbidity.toFixed(1);
            const oxy = (r.oxygen === null || r.oxygen === undefined) ? '--' : r.oxygen.toFixed(1);
            const turbBad = (r.turbidity !== null && r.turbidity !== undefined && r.turbidity > 5);
            const phBad = (r.ph !== null && r.ph !== undefined && (r.ph < 6.5 || r.ph > 8.5));
            const badge = (turbBad || phBad) ? `<span class="status-badge status-CRITICAL">ALERT</span>` : `<span class="status-badge status-STABLE">OK</span>`;
            return `
            <div class="card glass-card reservoir-card" style="animation-delay:${i * 0.06}s; cursor:pointer;" onclick="openQualityModal(${r.id}, '${r.name.replace(/'/g, "\\'")}')">
                <div class="res-header">
                    <h4 style="max-width: 70%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${r.name}">${r.name}</h4>
                    ${badge}
                </div>
                <div class="res-stats">
                    <div class="res-stat-row"><span>pH</span><span class="value">${ph}</span></div>
                    <div class="res-stat-row"><span>Turbidity</span><span class="value">${turb} NTU</span></div>
                    <div class="res-stat-row"><span>Dissolved Oxygen</span><span class="value">${oxy} mg/L</span></div>
                </div>
            </div>`;
        }).join('');
        lucide.createIcons();
    } catch (e) {
        console.error(e);
    }
}

window.openQualityModal = async (reservoirId, name) => {
    document.getElementById('quality-modal').style.display = 'flex';
    document.getElementById('quality-title').innerText = name;

    try {
        applyChartDefaults();
        const hist = await fetchAPI(`/quality/history?reservoirId=${encodeURIComponent(reservoirId)}`);
        const rows = (hist || []).filter(h => h && h.timestamp);
        // Build a unified time axis so datasets always align with labels
        const ts = [...new Set(rows.map(r => new Date(r.timestamp).toISOString()))].sort();
        const labels = ts.map(t => new Date(t).toLocaleString());
        const byMetric = (metric) => {
            const map = new Map(rows.filter(r => r.metric_type === metric).map(r => [new Date(r.timestamp).toISOString(), Number(r.value)]));
            return ts.map(t => map.has(t) ? map.get(t) : null);
        };

        const ctx = getCanvasCtx('qualityChart');
        if (!ctx) return;
        if (qualityChartInstance) qualityChartInstance.destroy();

        const g1 = ctx.createLinearGradient(0, 0, 0, 260);
        g1.addColorStop(0, 'rgba(245, 200, 76, 0.22)');
        g1.addColorStop(1, 'rgba(245, 200, 76, 0.02)');
        const g2 = ctx.createLinearGradient(0, 0, 0, 260);
        g2.addColorStop(0, 'rgba(189, 189, 189, 0.22)');
        g2.addColorStop(1, 'rgba(189, 189, 189, 0.02)');
        const g3 = ctx.createLinearGradient(0, 0, 0, 260);
        g3.addColorStop(0, 'rgba(230, 230, 230, 0.16)');
        g3.addColorStop(1, 'rgba(230, 230, 230, 0.02)');

        qualityChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    { label: 'pH', data: byMetric('ph'), borderColor: '#F5C84C', backgroundColor: g1, fill: true, tension: 0.35, spanGaps: true },
                    { label: 'Turbidity (NTU)', data: byMetric('turbidity'), borderColor: '#BDBDBD', backgroundColor: g2, fill: true, tension: 0.35, spanGaps: true },
                    { label: 'Oxygen (mg/L)', data: byMetric('oxygen'), borderColor: '#E6E6E6', backgroundColor: g3, fill: true, tension: 0.35, spanGaps: true }
                ]
            },
            options: modernChartOptions()
        });
    } catch (e) {
        console.error(e);
    }
};

async function renderAI() {
    try {
        const grid = document.getElementById('ai-grid-full');
        grid.innerHTML = '<p>Running Neural Network analysis...</p>';
        const data = await fetchAPI('/predict');
        
        grid.innerHTML = data.map((prediction, i) => {
            const isDanger = prediction.status === "CRITICAL" || prediction.status === "WARNING";
            return `
            <div class="card glass-card reservoir-card" style="animation-delay: ${i*0.1}s; border-color: ${isDanger ? 'rgba(245,200,76,0.35)' : 'rgba(189,189,189,0.25)'};">
                <div class="res-header">
                    <h4>${prediction.zone}</h4>
                    <span class="status-badge status-${prediction.status}">${prediction.status}</span>
                </div>
                <div class="res-stats">
                    <div class="res-stat-row"><span>Daily Usage</span><span class="value">${prediction.usage} ML</span></div>
                    <div class="res-stat-row"><span>3-Day Rain Forecast</span><span class="value" style="color:var(--primary)">${prediction.rainForecastMm} mm</span></div>
                    <div class="res-stat-row"><span style="color:var(--primary)">AI Risk Score</span><span class="value">${prediction.aiRiskScore}</span></div>
                    <div style="margin-top: 15px; padding: 12px; background: rgba(0,0,0,0.3); border-radius: 8px; text-align: center;">
                        <span style="font-size:0.85rem; color:var(--text-muted); display:block;">Predicted Shortage In:</span>
                        <strong style="font-size:1.5rem; color:${isDanger ? 'var(--danger)' : 'var(--success)'}">${prediction.predictedDaysLeft} Days</strong>
                    </div>
                </div>
            </div>`;
        }).join('');
    } catch (e) { console.error(e); }
}

// Map logic
async function renderMap() {
    try {
        const key = window.HYDROGRID_CONFIG && window.HYDROGRID_CONFIG.GOOGLE_MAPS_API_KEY;

        // Prefer Google Maps if configured; fall back to Leaflet if not.
        if (key && key.trim()) {
            if (!googleMapsLoadingPromise) {
                googleMapsLoadingPromise = new Promise((resolve, reject) => {
                    if (window.google && window.google.maps) return resolve();
                    const s = document.createElement('script');
                    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key.trim())}&libraries=visualization`;
                    s.async = true;
                    s.onload = () => resolve();
                    s.onerror = () => reject(new Error('Google Maps script failed to load'));
                    document.head.appendChild(s);
                });
            }
            await googleMapsLoadingPromise;

            if (!googleMapInstance) {
                googleMapInstance = new google.maps.Map(document.getElementById('india-map'), {
                    center: { lat: 22.0, lng: 79.0 },
                    zoom: 5,
                    styles: [
                        { elementType: "geometry", stylers: [{ color: "#1a1e29" }] },
                        { elementType: "labels.text.stroke", stylers: [{ color: "#1a1e29" }] },
                        { elementType: "labels.text.fill", stylers: [{ color: "#9ca3af" }] },
                        { featureType: "poi", stylers: [{ visibility: "off" }] }
                    ],
                    streetViewControl: false,
                    mapTypeControl: false,
                    fullscreenControl: false
                });
            }

            const data = await fetchAPI('/reservoirs');

            // Clear markers
            googleMarkers.forEach(m => m.setMap(null));
            googleMarkers = [];

            const heatPoints = [];
            const polyPath = [];

            (data || []).forEach(r => {
                if (!r.lat || !r.lng) return;
                const pos = { lat: Number(r.lat), lng: Number(r.lng) };
                const ratio = r.capacity_ml ? (r.current_level_ml / r.capacity_ml) : 0;
                const scarcity = 1 - Math.max(0, Math.min(1, ratio));

                const marker = new google.maps.Marker({
                    position: pos,
                    map: googleMapInstance,
                    title: r.name,
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        fillColor: (r.status === 'Danger') ? '#F5C84C' : (r.status === 'Optimal' ? '#BDBDBD' : '#E6E6E6'),
                        fillOpacity: 0.9,
                        strokeWeight: 2,
                        strokeColor: '#ffffff',
                        scale: 6
                    }
                });
                const info = new google.maps.InfoWindow({
                    content: `<div style="color:#111"><strong>${r.name}</strong><br/>Status: ${r.status}<br/>Level: ${formatNumber(r.current_level_ml)} ML</div>`
                });
                marker.addListener('click', () => info.open({ anchor: marker, map: googleMapInstance }));
                googleMarkers.push(marker);

                heatPoints.push({ location: new google.maps.LatLng(pos.lat, pos.lng), weight: scarcity * 10 });
                polyPath.push(pos);
            });

            // Heatmap: scarcity
            if (googleHeatmapLayer) googleHeatmapLayer.setMap(null);
            if (google.maps.visualization && google.maps.visualization.HeatmapLayer) {
                googleHeatmapLayer = new google.maps.visualization.HeatmapLayer({
                    data: heatPoints,
                    radius: 30,
                    dissipating: true
                });
                googleHeatmapLayer.setMap(googleMapInstance);
            }

            // Simple pipeline overlay demo: connect reservoir points (if any)
            if (googlePipeline) googlePipeline.setMap(null);
            if (polyPath.length >= 2) {
                googlePipeline = new google.maps.Polyline({
                    path: polyPath,
                    geodesic: true,
                    strokeColor: '#F5C84C',
                    strokeOpacity: 0.55,
                    strokeWeight: 3
                });
                googlePipeline.setMap(googleMapInstance);
            }

            // Leaflet instance (if previously created) isn't used when Google Maps is enabled.
            return;
        }

        // Leaflet fallback (kept for local runs without Maps key)
        if (!mapInstance) {
            mapInstance = L.map('india-map').setView([22.0, 79.0], 5);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; OpenStreetMap contributors'
            }).addTo(mapInstance);
        }

        const data = await fetchAPI('/reservoirs');
        mapInstance.eachLayer((layer) => {
            if (layer instanceof L.Marker || layer.options?.radius === 40) { mapInstance.removeLayer(layer); }
        });

        const heatData = [];
        (data || []).forEach(r => {
            if (r.lat && r.lng) {
                const isDanger = r.status === 'Danger';
                const isOpt = r.status === 'Optimal';
                const color = isDanger ? '#F5C84C' : (isOpt ? '#BDBDBD' : '#E6E6E6');

                const markerHtml = `<div style="background-color: ${color}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 10px ${color};"></div>`;
                const customIcon = L.divIcon({ className: 'custom-icon', html: markerHtml, iconSize: [14, 14] });

                L.marker([r.lat, r.lng], { icon: customIcon })
                    .addTo(mapInstance)
                    .bindPopup(`<strong style="color: #333;">${r.name}</strong><br><span style="color: #333;">Status: ${r.status}</span><br><span style="color: #333;">Level: ${formatNumber(r.current_level_ml)} ML</span>`);

                heatData.push([r.lat, r.lng, 1 - (r.current_level_ml / r.capacity_ml)]);
            }
        });

        if (L.heatLayer) {
            L.heatLayer(heatData, { radius: 40, blur: 25, maxZoom: 10, gradient: { 0.4: '#E6E6E6', 0.6: '#F5C84C', 1: '#F5C84C' } }).addTo(mapInstance);
        }
        setTimeout(() => mapInstance.invalidateSize(), 300);
    } catch (e) { console.error(e); }
}

// History Modal
window.openHistoryModal = async (id, name) => {
    document.getElementById('history-modal').style.display = 'flex';
    document.getElementById('history-title').innerText = name;
    
    try {
        const historyData = await fetchAPI('/history');
        const resHistory = historyData.filter(h => h.reservoir_id === id);
        
        applyChartDefaults();
        const ctx = getCanvasCtx('historyChart');
        if (!ctx) return;
        if (historyChartInstance) historyChartInstance.destroy();
        
        const histGradient = ctx.createLinearGradient(0, 0, 0, 260);
        histGradient.addColorStop(0, 'rgba(245, 200, 76, 0.22)');
        histGradient.addColorStop(1, 'rgba(245, 200, 76, 0.02)');

        historyChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: resHistory.map((h, i) => i === resHistory.length - 1 ? 'Now' : `-${resHistory.length - 1 - i} checks`),
                datasets: [{
                    label: 'Level (ML)',
                    data: resHistory.map(h => h.current_level_ml),
                    borderColor: '#F5C84C',
                    backgroundColor: histGradient,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: modernChartOptions()
        });
    } catch (e) { console.error(e); }
};

function switchView(viewId) {
    document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`view-${viewId}`).classList.add('active');
    
    document.querySelectorAll('.nav-links li').forEach(li => li.classList.remove('active'));
    const link = document.querySelector(`a[data-view="${viewId}"]`);
    if(link) link.parentElement.classList.add('active');

    const titleEl = document.getElementById('page-title');
    if(viewId === 'dashboard') { titleEl.innerText = "Operations Dashboard"; renderDashboard(); }
    if(viewId === 'reservoirs') { titleEl.innerText = "Reservoir Grid"; renderReservoirs(); }
    if(viewId === 'live') { titleEl.innerText = "Real-Time Monitor"; renderLive(); }
    if(viewId === 'quality') { titleEl.innerText = "Water Quality"; renderQuality(); }
    if(viewId === 'map') { titleEl.innerText = "Geographic Overview"; renderMap(); }
    if(viewId === 'analytics') { titleEl.innerText = "City Analytics"; renderAnalytics(); }
    if(viewId === 'ai') { titleEl.innerText = "Predictive Intelligence"; renderAI(); }
    if(viewId === 'irrigation') { titleEl.innerText = "Agricultural Grid"; }
    if(viewId === 'complaint') { titleEl.innerText = "Citizen Portal"; }
    if(viewId === 'reports') { titleEl.innerText = "Reports"; }
    if(viewId === 'admin') { 
        titleEl.innerText = "Admin Operations";
        // Check if already logged in via cached token
        if (currentJWT) {
            document.getElementById('admin-login-panel').style.display = 'none';
            document.getElementById('admin-secure-panel').style.display = 'block';
        } else {
            document.getElementById('admin-login-panel').style.display = 'block';
            document.getElementById('admin-secure-panel').style.display = 'none';
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-view]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            switchView(e.currentTarget.dataset.view);
        });
    });

    switchView('dashboard');
    startRealtimeStream();
    
    // Fetch Gamification score
    fetchAPI('/user').then(data => {
        if(data && data.water_saver_score !== undefined) {
            document.getElementById('gamification-score').innerText = `💎 ${data.water_saver_score} pts`;
        }
    }).catch(e => console.error(e));

    // PDF Export Logic
    const exportBtn = document.getElementById('btn-export-pdf');
    if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
            const btn = document.getElementById('btn-export-pdf');
            const originalHTML = btn.innerHTML;
            btn.innerHTML = `<i data-lucide="loader" class="spin" style="width:16px; margin-right:8px; vertical-align:middle;"></i> Exporting...`;
            btn.disabled = true;
            lucide.createIcons();
            
            try {
                // Ensure map tile loads nicely if viewing map
                const canvas = await html2canvas(document.body, { backgroundColor: '#0f1118', allowTaint: true, useCORS: true });
                const imgData = canvas.toDataURL('image/png');
                const pdf = new jspdf.jsPDF('p', 'mm', 'a4');
                const pdfWidth = pdf.internal.pageSize.getWidth();
                const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
                
                pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
                pdf.save('HydroGrid-Report.pdf');
            } catch(e) {
                console.error("PDF Export failed", e);
                alert("PDF export failed.");
            } finally {
                btn.innerHTML = originalHTML;
                btn.disabled = false;
                lucide.createIcons();
            }
        });
    }

    // Sync Data Logic
    const syncBtn = document.getElementById('btn-sync-data');
    if (syncBtn) {
        syncBtn.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const originalHTML = btn.innerHTML;
            btn.innerHTML = `<i data-lucide="loader" class="spin" style="width:16px; margin-right:8px; vertical-align:middle;"></i> Syncing...`;
            btn.disabled = true;
            lucide.createIcons();

            try {
                const res = await fetch(`${API_BASE}/sync`, { method: 'POST' });
                if (res.ok) {
                    // Re-render current view to see the minimal changes
                    const activeView = document.querySelector('.nav-links li.active a');
                    if (activeView) switchView(activeView.dataset.view);
                }
            } catch(err) {
                console.error("Sync failed", err);
            } finally {
                btn.innerHTML = originalHTML;
                btn.disabled = false;
                lucide.createIcons();
            }
        });
    }

    // Admin Login Logic
    document.getElementById('btn-login').addEventListener('click', async () => {
        const u = document.getElementById('admin-user').value;
        const p = document.getElementById('admin-pass').value;
        try {
            const res = await fetch(`${API_BASE}/admin/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: u, password: p })
            });
            const data = await res.json();
            if (data.token) {
                currentJWT = data.token;
                localStorage.setItem('hydrogrid_admin_jwt', currentJWT);
                document.getElementById('admin-login-panel').style.display = 'none';
                document.getElementById('admin-secure-panel').style.display = 'block';
                document.getElementById('login-err').style.display = 'none';
            } else {
                document.getElementById('login-err').style.display = 'block';
            }
        } catch(err) {
            document.getElementById('login-err').style.display = 'block';
        }
    });

    // CSV File Selection Enabler
    document.getElementById('csv-upload').addEventListener('change', (e) => {
        document.getElementById('btn-upload').disabled = !e.target.files.length;
    });

    // CSV File Upload Logic
    document.getElementById('btn-upload').addEventListener('click', async (e) => {
        const file = document.getElementById('csv-upload').files[0];
        if (!file) return;

        const btn = e.currentTarget;
        const originalText = btn.innerHTML;
        btn.innerHTML = `<i data-lucide="loader" class="spin" style="width:16px; margin-right:8px;"></i> Uploading...`;
        lucide.createIcons();

        const reader = new FileReader();
        reader.onload = async (event) => {
            const rawCSV = event.target.result;
            try {
                const res = await fetch(`${API_BASE}/admin/upload-dataset`, {
                    method: 'POST',
                    headers: { 
                        'Authorization': `Bearer ${currentJWT}`,
                        'Content-Type': 'text/plain' 
                    },
                    body: rawCSV
                });
                if (res.ok) {
                    alert('Official CWC Dataset securely verified and imported!');
                    document.getElementById('csv-upload').value = '';
                    btn.disabled = true;
                } else {
                    alert('Encryption verification failed or invalid CSV.');
                }
            } catch(e) {
                alert('Connection error.');
            } finally {
                btn.innerHTML = originalText;
            }
        };
        reader.readAsText(file);
    });

    // Complaint Form Submission
    const cmpBtn = document.getElementById('btn-submit-complaint');
    if (cmpBtn) {
        cmpBtn.addEventListener('click', async () => {
            const name = document.getElementById('cmp-name').value;
            const type = document.getElementById('cmp-type').value;
            const loc = document.getElementById('cmp-loc').value;
            const desc = document.getElementById('cmp-desc').value;
            if (!name || !loc || !desc) return alert("Please fill all fields");

            cmpBtn.disabled = true;
            cmpBtn.innerHTML = `<i data-lucide="loader" class="spin" style="width:16px;"></i> Submitting...`;
            lucide.createIcons();
            try {
                await fetchAPI('/complaints', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_name: name, type, location: loc, description: desc })
                });
                alert("Report Submitted! Thank you for maintaining the grid. +10 Water Saver Points.");
                document.getElementById('cmp-desc').value = '';
                document.getElementById('cmp-name').value = '';
                document.getElementById('cmp-loc').value = '';
                
                // Optimistically update gamification score
                let scoreEl = document.getElementById('gamification-score');
                if(scoreEl) {
                    let pts = parseInt(scoreEl.innerText.replace(/[^0-9]/g, '')) || 0;
                    scoreEl.innerText = `💎 ${pts + 10} pts`;
                }
            } catch(e) {
                alert("Submission failed. Network Error.");
            } finally {
                cmpBtn.disabled = false;
                cmpBtn.innerHTML = "Submit Report";
            }
        });
    }

    // AI CHAT LOGIC
    document.getElementById('btn-toggle-chat').addEventListener('click', () => {
        const w = document.getElementById('ai-chat-window');
        w.style.display = w.style.display === 'none' ? 'flex' : 'none';
        if (w.style.display === 'flex') document.getElementById('ai-chat-input').focus();
    });

    const sendMsg = async () => {
        const input = document.getElementById('ai-chat-input');
        const text = input.value.trim();
        if (!text) return;
        
        const messages = document.getElementById('ai-chat-messages');
        messages.innerHTML += `
            <div style="align-self:flex-end; background:var(--primary); color:#fff; padding:10px 15px; border-radius:15px; border-bottom-right-radius:0; max-width:85%; font-size:0.9rem;">
                ${text}
            </div>
        `;
        input.value = '';
        messages.scrollTop = messages.scrollHeight;
        
        messages.innerHTML += `
            <div id="ai-typing" style="align-self:flex-start; background:rgba(0,210,255,0.1); padding:10px 15px; border-radius:15px; border-bottom-left-radius:0; max-width:85%; border:1px solid rgba(0,210,255,0.3); font-size:0.9rem; color:var(--text-muted);">
                <i data-lucide="loader" class="spin" style="width:14px; height:14px; margin-right:5px; vertical-align:middle;"></i> Thinking...
            </div>
        `;
        lucide.createIcons();
        messages.scrollTop = messages.scrollHeight;
        
        try {
            const res = await fetch(`${API_BASE}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text })
            });
            const data = await res.json();
            document.getElementById('ai-typing').remove();
            
            messages.innerHTML += `
                <div style="align-self:flex-start; background:rgba(0,210,255,0.1); padding:10px 15px; border-radius:15px; border-bottom-left-radius:0; max-width:85%; border:1px solid rgba(0,210,255,0.3); font-size:0.9rem;">
                    ${data.reply}
                </div>
            `;
        } catch(e) {
            if(document.getElementById('ai-typing')) document.getElementById('ai-typing').remove();
            messages.innerHTML += `<div style="align-self:flex-start; color:var(--danger); font-size:0.85rem;">Error connecting to AI. Make sure you set your API key in .env.</div>`;
        }
        messages.scrollTop = messages.scrollHeight;
    };

    document.getElementById('ai-chat-send').addEventListener('click', sendMsg);
    document.getElementById('ai-chat-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMsg();
    });

    // Usage range toggles
    const bindRange = (id, range) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', async () => {
            currentUsageRange = range;
            await renderUsageTrend(range);
        });
    };
    bindRange('usage-range-daily', 'daily');
    bindRange('usage-range-weekly', 'weekly');
    bindRange('usage-range-monthly', 'monthly');

    // Report export buttons (backend endpoints added later)
    const dl = (path) => window.open(`${API_BASE}${path}`, '_blank');
    const a = document.getElementById('btn-export-alerts-xlsx');
    if (a) a.addEventListener('click', () => dl('/reports/alerts.xlsx'));
    const u = document.getElementById('btn-export-usage-xlsx');
    if (u) u.addEventListener('click', () => dl('/reports/usage.xlsx'));
    const q = document.getElementById('btn-export-quality-xlsx');
    if (q) q.addEventListener('click', () => dl('/reports/quality.xlsx'));
});
