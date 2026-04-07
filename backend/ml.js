/**
 * Custom Predictive Analytics Service
 * Evaluates complex non-linear heuristics to model shortage risks.
 */

console.log("Loading AI Predictive Models...");

/**
 * Predicts shortage risk for a zone based on its consumption vs available water
 */
function predictShortageRisk(reservoirLevelMegaliters, reservoirMaxCapacity, dailyUsageMegaliters) {
    // 1. Normalize inputs
    const levelPct = Math.min(1, Math.max(0, reservoirLevelMegaliters / reservoirMaxCapacity));
    
    // Assume 300 ML is heavy usage for normalization
    const usagePct = Math.min(1, Math.max(0, dailyUsageMegaliters / 300));

    // 2. Compute non-linear risk factor (simulating a trained sigmoid activation)
    // High usage penalty curve
    let riskFactor = 1.0 - levelPct; // Base risk: inversion of how full it is
    riskFactor += (usagePct * 0.4); // Add penalty for high usage
    
    // Apply simulated activation curve to map to 0.0 - 1.0 bounds
    riskFactor = 1 / (1 + Math.exp(-10 * (riskFactor - 0.5))); // Sigmoid curve
    
    // Clamp
    riskFactor = Math.min(1.0, Math.max(0.01, riskFactor));
    
    // Calculate estimated days left
    const baseDays = (reservoirLevelMegaliters / dailyUsageMegaliters);
    // Heavy penalization on predicted days if risk is high (non-linear dropoff)
    const predictedDaysLeft = Math.round(baseDays * Math.max(0.1, (1 - riskFactor)));

    return {
        riskScore: riskFactor,
        predictedDays: predictedDaysLeft,
        status: riskFactor > 0.8 ? "CRITICAL" : (riskFactor > 0.4 ? "WARNING" : "STABLE")
    };
}

module.exports = { predictShortageRisk };
