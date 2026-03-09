function showNotification(message, type = 'info') {
    if (type === 'success' && typeof showSuccess === 'function') return showSuccess('Success', message);
    if (type === 'error' && typeof showError === 'function') return showError('Error', message);
    if (type === 'warning' && typeof showWarning === 'function') return showWarning('Warning', message);
    if (typeof showInfo === 'function') return showInfo('Info', message);
    console.log(`[${type}] ${message}`);
}

window.verificationChallengeChart = window.verificationChallengeChart || null;
window.verificationAnalyticsData = window.verificationAnalyticsData || null;

function escapeVerificationValue(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatVerificationLastUpdated(timestamp) {
    const lastUpdatedEl = document.getElementById('verificationAnalyticsLastUpdated');
    if (!lastUpdatedEl) return;
    if (!timestamp) {
        lastUpdatedEl.textContent = 'Last updated: --';
        return;
    }
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        lastUpdatedEl.textContent = 'Last updated: --';
        return;
    }
    lastUpdatedEl.textContent = `Last updated: ${date.toLocaleString()}`;
}

async function loadVerificationAnalytics() {
    const summarySessions = document.getElementById('verificationSummarySessions');
    const summarySuccessRate = document.getElementById('verificationSummarySuccessRate');
    const summaryFallback = document.getElementById('verificationSummaryFallback');
    const summaryTimeouts = document.getElementById('verificationSummaryTimeouts');
    const summaryPenalties = document.getElementById('verificationSummaryPenalties');
    const summaryOverrides = document.getElementById('verificationSummaryOverrides');
    const modeBreakdown = document.getElementById('verificationModeBreakdown');
    const legendEl = document.getElementById('verificationChallengeLegend');
    const recentBody = document.getElementById('verificationRecentTableBody');
    const pieCanvas = document.getElementById('verificationChallengePieChart');

    if (!summarySessions || !summarySuccessRate || !summaryFallback || !summaryTimeouts || !summaryPenalties || !summaryOverrides || !modeBreakdown || !legendEl || !recentBody) {
        return;
    }

    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/owner/verification-analytics?days=30');
        if (!response.ok) {
            throw new Error(data?.error || 'Failed to fetch verification analytics');
        }

        const summary = data?.summary || {};
        const breakdown = data?.breakdown || {};
        const challengeTypes = breakdown.challengeTypes || {};
        const verificationModes = breakdown.verificationModes || {};
        const recent = Array.isArray(data?.recent) ? data.recent.slice(0, 25) : [];

        window.verificationAnalyticsData = {
            summary,
            breakdown,
            recent,
            days: Number(data?.days || 30),
            updatedAt: data?.updatedAt || null
        };

        summarySessions.textContent = Number(summary.sessionsStarted || 0).toLocaleString();
        summarySuccessRate.textContent = `${Number(summary.successRate || 0).toFixed(1)}%`;
        summaryFallback.textContent = Number(summary.fallbackUsed || 0).toLocaleString();
        summaryTimeouts.textContent = Number(summary.timeouts || 0).toLocaleString();
        summaryPenalties.textContent = Number(summary.penaltiesApplied || 0).toLocaleString();
        summaryOverrides.textContent = Number(summary.staffOverrides || 0).toLocaleString();

        const modeRows = Object.entries(verificationModes);
        if (!modeRows.length) {
            modeBreakdown.innerHTML = '<span class="text-muted">No mode data yet.</span>';
        } else {
            const totalModes = modeRows.reduce((acc, [, value]) => acc + Number(value || 0), 0);
            modeBreakdown.innerHTML = modeRows.map(([mode, value]) => {
                const count = Number(value || 0);
                const pct = totalModes > 0 ? ((count / totalModes) * 100).toFixed(1) : '0.0';
                return `<div style="margin-bottom:0.5rem;"><strong>${escapeVerificationValue(mode)}</strong>: ${count.toLocaleString()} (${pct}%)</div>`;
            }).join('');
        }

        const challengeRows = Object.entries(challengeTypes).filter(([, value]) => Number(value || 0) > 0);
        const labels = challengeRows.map(([label]) => label);
        const values = challengeRows.map(([, value]) => Number(value || 0));
        const colors = ['#5b7fff', '#5bffb8', '#ffd45b', '#ff5b5b', '#a78bfa'];

        if (window.verificationChallengeChart) {
            window.verificationChallengeChart.destroy();
            window.verificationChallengeChart = null;
        }

        if (pieCanvas && labels.length && typeof Chart !== 'undefined') {
            window.verificationChallengeChart = new Chart(pieCanvas, {
                type: 'pie',
                data: {
                    labels,
                    datasets: [{
                        data: values,
                        backgroundColor: colors.slice(0, labels.length),
                        borderColor: '#222c37',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    plugins: {
                        legend: { display: false }
                    }
                }
            });
        }

        if (!labels.length) {
            legendEl.innerHTML = '<div class="text-muted">No challenge distribution data yet.</div>';
        } else {
            const challengeTotal = values.reduce((acc, value) => acc + value, 0);
            legendEl.innerHTML = labels.map((label, index) => {
                const value = values[index];
                const pct = challengeTotal > 0 ? ((value / challengeTotal) * 100).toFixed(1) : '0.0';
                return `<div style="margin-bottom:0.35rem;"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${colors[index]};margin-right:0.45rem;"></span>${escapeVerificationValue(label)}: ${value.toLocaleString()} (${pct}%)</div>`;
            }).join('');
        }

        if (!recent.length) {
            recentBody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No recent verification events.</td></tr>';
        } else {
            recentBody.innerHTML = recent.map((event) => {
                const timestamp = event.timestamp ? new Date(event.timestamp) : null;
                const timeText = timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toLocaleString() : 'Unknown';
                const userText = event.username ? `${escapeVerificationValue(event.username)}` : (event.userId ? escapeVerificationValue(event.userId) : 'Unknown');
                return `
                    <tr>
                        <td>${escapeVerificationValue(timeText)}</td>
                        <td>${userText}</td>
                        <td>${escapeVerificationValue(event.type || '-')}</td>
                        <td>${escapeVerificationValue(event.mode || '-')}</td>
                        <td>${escapeVerificationValue(event.challengeType || '-')}</td>
                        <td>${escapeVerificationValue(event.reason || '-')}</td>
                    </tr>
                `;
            }).join('');
        }

        formatVerificationLastUpdated(data?.updatedAt || new Date().toISOString());
    } catch (error) {
        console.error('Error loading verification analytics:', error);
        window.verificationAnalyticsData = null;
        modeBreakdown.innerHTML = '<span class="text-muted">Failed to load mode breakdown.</span>';
        legendEl.innerHTML = '<div class="message error">Failed to load challenge distribution.</div>';
        recentBody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Failed to load recent verification events.</td></tr>';
        formatVerificationLastUpdated(null);
    }
}

window.loadVerificationAnalytics = loadVerificationAnalytics;

function csvEscape(value) {
    const raw = String(value ?? '');
    const escaped = raw.replace(/"/g, '""');
    return `"${escaped}"`;
}

function exportVerificationEventsCsv() {
    const payload = window.verificationAnalyticsData;
    if (!payload || !Array.isArray(payload.recent)) {
        showError('Export Failed', 'Load verification analytics before exporting.');
        return;
    }

    const summary = payload.summary || {};
    const rows = [];

    rows.push('Metric,Value');
    rows.push(`Window Days,${csvEscape(payload.days || 30)}`);
    rows.push(`Updated At,${csvEscape(payload.updatedAt || new Date().toISOString())}`);
    rows.push(`Sessions Started,${csvEscape(summary.sessionsStarted || 0)}`);
    rows.push(`Success Rate,${csvEscape(`${Number(summary.successRate || 0).toFixed(1)}%`)}`);
    rows.push(`Fallback Used,${csvEscape(summary.fallbackUsed || 0)}`);
    rows.push(`Timeouts,${csvEscape(summary.timeouts || 0)}`);
    rows.push(`Penalties Applied,${csvEscape(summary.penaltiesApplied || 0)}`);
    rows.push(`Staff Overrides,${csvEscape(summary.staffOverrides || 0)}`);
    rows.push('');

    rows.push('Timestamp,User,Type,Mode,ChallengeType,Reason,DurationMs');
    payload.recent.forEach((event) => {
        rows.push([
            csvEscape(event?.timestamp || ''),
            csvEscape(event?.username || event?.userId || ''),
            csvEscape(event?.type || ''),
            csvEscape(event?.mode || ''),
            csvEscape(event?.challengeType || ''),
            csvEscape(event?.reason || ''),
            csvEscape(event?.durationMs || '')
        ].join(','));
    });

    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `verification-analytics-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.URL.revokeObjectURL(url);

    showSuccess('Exported', 'Verification analytics exported to CSV.');
}

window.exportVerificationEventsCsv = exportVerificationEventsCsv;

let allAlertSettings = [];
let allActiveAlerts = [];
let pendingAlertToggleByType = {};

async function loadAlertAnalytics() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/owner/alert-settings-analytics');
        if (!response.ok) {
            showNotification('Failed to load alert analytics', 'error');
            return;
        }

        allAlertSettings = data.settings || [];
        updateAlertStats(data.summary);
        filterAlertSettings();

        await loadActiveAlerts();
        await loadAlertMonitorStatus();
    } catch (error) {
        console.error('Error loading alert analytics:', error);
        showNotification('Failed to load alert analytics', 'error');
        renderAlertMonitorStatus(null);
    }
}

function formatMonitorStatusTime(value) {
    if (!value) return 'Never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Never';
    return date.toLocaleString();
}

function renderAlertMonitorStatus(status) {
    const statusEl = document.getElementById('alertMonitorStatusText');
    if (!statusEl) return;

    if (!status) {
        statusEl.textContent = 'Alert monitor status: unavailable.';
        return;
    }

    const running = status.running ? 'Running now' : 'Idle';
    const lastRun = formatMonitorStatusTime(status.lastRunAt);
    const lastSuccess = formatMonitorStatusTime(status.lastSuccessAt);
    const durationMs = Number(status.lastDurationMs || 0);
    const durationLabel = durationMs > 0 ? `${durationMs}ms` : 'N/A';
    const errorText = status.lastError ? ` | Last issue: ${status.lastError}` : '';
    statusEl.textContent = `Alert monitor: ${running} | Last run: ${lastRun} | Last success: ${lastSuccess} | Duration: ${durationLabel}${errorText}`;
}

async function loadAlertMonitorStatus() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/alerts/status');
        if (!response.ok) {
            renderAlertMonitorStatus(null);
            return;
        }
        renderAlertMonitorStatus(data || null);
    } catch (error) {
        console.error('Error loading alert monitor status:', error);
        renderAlertMonitorStatus(null);
    }
}

function updateAlertStats(summary) {
    document.getElementById('totalAlertSettings').textContent = summary?.total || 0;
    document.getElementById('enabledAlertSettings').textContent = summary?.enabled || 0;
    document.getElementById('activeAlertsCount').textContent = summary?.activeAlerts || 0;
    document.getElementById('recentAlertsCount').textContent = summary?.recentAlerts || 0;
}

function filterAlertSettings() {
    const filter = document.getElementById('alertStatusFilter')?.value || 'all';

    let filtered = allAlertSettings;
    if (filter === 'enabled') {
        filtered = allAlertSettings.filter(s => s.enabled);
    } else if (filter === 'disabled') {
        filtered = allAlertSettings.filter(s => !s.enabled);
    }

    renderAlertSettings(filtered);
}

function renderAlertSettings(settings) {
    const container = document.getElementById('alertSettingsContainer');

    if (!settings || settings.length === 0) {
        container.innerHTML = `
                    <div style="text-align: center; padding: 3rem; color: var(--text-secondary);">
                        <div style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.5;">&#128269;</div>
                        <div style="font-size: 1.1rem; font-weight: 600;">No alert settings found</div>
                        <div style="font-size: 0.9rem; margin-top: 0.5rem;">Try adjusting your filters</div>
                    </div>`;
        return;
    }

    let html = '';
    settings.forEach(setting => {
        const lastTriggered = setting.last_triggered ? new Date(setting.last_triggered).toLocaleString() : 'Never';
        const alertTypeDisplay = setting.alert_type.replace('_', ' ').toUpperCase();
        const isTogglePending = Boolean(pendingAlertToggleByType[setting.alert_type]);

        html += `
                    <div class="alert-setting-card">
                        <div class="alert-setting-header">
                            <div class="alert-setting-title">
                                <span class="alert-type-badge ${setting.alert_type}">${alertTypeDisplay}</span>
                            </div>
                            <span class="alert-enabled-badge ${setting.enabled ? 'enabled' : 'disabled'}">
                                ${setting.enabled ? '&#9989; Enabled' : '&#128683; Disabled'}
                            </span>
                        </div>

                        <div class="alert-setting-body">
                            <div class="alert-info-item">
                                <div class="alert-info-label">&#128200; Threshold</div>
                                <div class="alert-info-value">${setting.threshold}%</div>
                            </div>
                            <div class="alert-info-item">
                                <div class="alert-info-label">&#128680; Active Alerts</div>
                                <div class="alert-info-value">${setting.active_alerts}</div>
                            </div>
                            <div class="alert-info-item">
                                <div class="alert-info-label">&#128202; Recent (30d)</div>
                                <div class="alert-info-value">${setting.recent_triggered}</div>
                            </div>
                            <div class="alert-info-item">
                                <div class="alert-info-label">&#128347; Last Triggered</div>
                                <div class="alert-info-value">${lastTriggered}</div>
                            </div>
                        </div>

                        <div class="alert-setting-footer">
                            <button class="btn-alert-edit" onclick="editAlertSetting('${setting.alert_type}', ${setting.threshold}, ${setting.enabled})">
                                &#9881; Edit Settings
                            </button>
                            <button class="btn-alert-toggle" onclick="toggleAlertEnabled('${setting.alert_type}', ${!setting.enabled})" ${isTogglePending ? 'disabled' : ''}>
                                ${isTogglePending ? '&#9203; Saving...' : (setting.enabled ? '&#128683; Disable' : '&#9989; Enable')}
                            </button>
                        </div>
                    </div>
                `;
    });

    container.innerHTML = html;
}

async function editAlertSetting(alertType, currentThreshold, currentEnabled) {
    if (typeof window.showPromptModal !== 'function') {
        showNotification('Prompt modal unavailable. Please refresh and try again.', 'error');
        return;
    }

    const newThreshold = await window.showPromptModal({
        title: `Edit ${alertType} Threshold`,
        label: `Enter new threshold for ${alertType} (current: ${currentThreshold}%):`,
        placeholder: '0-100',
        defaultValue: String(currentThreshold),
        confirmText: 'Update Threshold',
        cancelText: 'Cancel',
        inputType: 'number',
        validate: (value) => {
            const parsed = Number.parseFloat(value);
            if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
                return 'Threshold must be between 0 and 100.';
            }
            return true;
        }
    });
    if (newThreshold === null) return;

    const threshold = parseFloat(newThreshold);
    if (isNaN(threshold) || threshold < 0 || threshold > 100) {
        showNotification('Invalid threshold value. Must be between 0 and 100.', 'error');
        return;
    }

    try {
        const { response } = await window.AdminPanel.api.postJson(`/api/alerts/settings/${alertType}`, {
            threshold: threshold,
            enabled: currentEnabled
        });

        if (response.ok) {
            showNotification(`Updated ${alertType} threshold to ${threshold}%`, 'success');
            await loadAlertAnalytics();
        } else {
            showNotification('Failed to update alert settings', 'error');
        }
    } catch (error) {
        console.error('Error updating alert settings:', error);
        showNotification('Failed to update alert settings', 'error');
    }
}

async function toggleAlertEnabled(alertType, newEnabled) {
    if (pendingAlertToggleByType[alertType]) return;

    try {
        const setting = allAlertSettings.find(s => s.alert_type === alertType);
        if (!setting) return;

        const previousEnabled = Boolean(setting.enabled);
        pendingAlertToggleByType[alertType] = true;
        setting.enabled = Boolean(newEnabled);
        filterAlertSettings();

        const { response } = await window.AdminPanel.api.postJson(`/api/alerts/settings/${alertType}`, {
            threshold: setting.threshold,
            enabled: newEnabled
        });

        if (response.ok) {
            showNotification(`${alertType} alert ${newEnabled ? 'enabled' : 'disabled'}`, 'success');
            try {
                await loadAlertAnalytics();
            } catch (refreshError) {
                console.error('Error refreshing alert analytics after toggle:', refreshError);
            }
        } else {
            setting.enabled = previousEnabled;
            filterAlertSettings();
            showNotification('Failed to toggle alert status', 'error');
        }
    } catch (error) {
        console.error('Error toggling alert:', error);
        const fallbackSetting = allAlertSettings.find(s => s.alert_type === alertType);
        if (fallbackSetting) {
            fallbackSetting.enabled = !Boolean(newEnabled);
            filterAlertSettings();
        }
        showNotification('Failed to toggle alert status', 'error');
    } finally {
        pendingAlertToggleByType[alertType] = false;
        filterAlertSettings();
    }
}

async function loadActiveAlerts() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/alerts/active');
        if (!response.ok) {
            renderActiveAlerts([]);
            return;
        }

        allActiveAlerts = data || [];
        renderActiveAlerts(allActiveAlerts);
    } catch (error) {
        console.error('Error loading active alerts:', error);
        renderActiveAlerts([]);
    }
}

function renderActiveAlerts(alerts) {
    const container = document.getElementById('activeAlertsContainer');

    if (!alerts || alerts.length === 0) {
        container.innerHTML = `
                    <div style="text-align: center; padding: 2rem; color: var(--text-secondary);">
                        <div style="font-size: 2rem; margin-bottom: 0.75rem; opacity: 0.5;">&#9989;</div>
                        <div style="font-size: 1rem; font-weight: 600;">No active alerts</div>
                        <div style="font-size: 0.85rem; margin-top: 0.35rem;">All systems operating normally</div>
                    </div>`;
        return;
    }

    let html = '';
    alerts.forEach(alert => {
        const createdAt = new Date(alert.created_at).toLocaleString();

        html += `
                    <div class="active-alert-card">
                        <div class="active-alert-header">
                            <div class="active-alert-type">${alert.alert_type.replace('_', ' ').toUpperCase()}</div>
                            <span class="active-alert-severity ${alert.severity}">${alert.severity.toUpperCase()}</span>
                        </div>
                        <div class="active-alert-message">${alert.message}</div>
                        <div class="active-alert-footer">
                            <span>Value: <strong>${alert.value}</strong> / Threshold: <strong>${alert.threshold}</strong></span>
                            <span>${createdAt}</span>
                            <button class="btn-resolve-alert" onclick="resolveAlert(${alert.id})">
                                &#10004; Resolve
                            </button>
                        </div>
                    </div>
                `;
    });

    container.innerHTML = html;
}

async function resolveAlert(alertId) {
    const confirmed = await window.modalManager?.showConfirm({
        title: 'Resolve Alert',
        message: 'Are you sure you want to resolve this alert?',
        confirmText: 'Resolve',
        cancelText: 'Cancel',
        type: 'warning'
    });
    if (!confirmed) return;

    try {
        const { response } = await window.AdminPanel.api.postJson(`/api/alerts/${alertId}/resolve`, {});
        if (response.ok) {
            showNotification('Alert resolved successfully', 'success');
            await loadAlertAnalytics();
        } else {
            showNotification('Failed to resolve alert', 'error');
        }
    } catch (error) {
        console.error('Error resolving alert:', error);
        showNotification('Failed to resolve alert', 'error');
    }
}

function exportAlertSettings() {
    if (allAlertSettings.length === 0) {
        showNotification('No alert settings to export', 'warning');
        return;
    }

    const csvHeaders = ['Alert Type', 'Threshold (%)', 'Enabled', 'Active Alerts', 'Recent Triggered', 'Last Triggered'];
    const csvRows = allAlertSettings.map(setting => [
        setting.alert_type,
        setting.threshold,
        setting.enabled ? 'Yes' : 'No',
        setting.active_alerts,
        setting.recent_triggered,
        setting.last_triggered ? new Date(setting.last_triggered).toLocaleString() : 'Never'
    ]);

    const csv = [csvHeaders.join(',')].concat(
        csvRows.map(row => row.map(cell => `"${cell}"`).join(','))
    ).join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `alert-settings-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    showNotification('Alert settings exported successfully', 'success');
}

let emailAnalyticsTrendChart = null;
let emailAnalyticsRefreshIntervalId = null;
let emailAnalyticsLastUpdatedAt = null;
let emailAnalyticsLastUpdatedTickerId = null;
let emailAnalyticsPieChart = null;
let latestEmailRecentRows = [];

function formatRelativeTime(dateValue) {
    if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) return 'unknown';
    const diffMs = Date.now() - dateValue.getTime();
    const seconds = Math.max(0, Math.floor(diffMs / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function sanitizeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderEmailAnalyticsLastUpdated() {
    const lastUpdatedEl = document.getElementById('emailAnalyticsPieLastUpdated');
    if (!lastUpdatedEl) return;

    if (!emailAnalyticsLastUpdatedAt) {
        lastUpdatedEl.textContent = 'Last updated: --';
        lastUpdatedEl.style.color = 'var(--text-secondary)';
        return;
    }

    const ageMs = Date.now() - emailAnalyticsLastUpdatedAt.getTime();
    if (ageMs < 60 * 1000) {
        lastUpdatedEl.style.color = 'var(--color-green)';
    } else if (ageMs < 5 * 60 * 1000) {
        lastUpdatedEl.style.color = 'var(--color-orange)';
    } else {
        lastUpdatedEl.style.color = 'var(--color-red)';
    }

    const absolute = emailAnalyticsLastUpdatedAt.toLocaleString();
    const relative = formatRelativeTime(emailAnalyticsLastUpdatedAt);
    lastUpdatedEl.textContent = `Last updated: ${absolute} (${relative})`;
}

function startEmailAnalyticsLastUpdatedTicker() {
    if (emailAnalyticsLastUpdatedTickerId) {
        clearInterval(emailAnalyticsLastUpdatedTickerId);
    }

    emailAnalyticsLastUpdatedTickerId = setInterval(() => {
        const tab = document.getElementById('email-analytics');
        const isActive = Boolean(tab && tab.classList.contains('active'));
        if (isActive && !document.hidden) {
            renderEmailAnalyticsLastUpdated();
        }
    }, 15000);
}

function startEmailAnalyticsAutoRefresh() {
    if (emailAnalyticsRefreshIntervalId) {
        clearInterval(emailAnalyticsRefreshIntervalId);
    }

    emailAnalyticsRefreshIntervalId = setInterval(() => {
        const tab = document.getElementById('email-analytics');
        const isActive = Boolean(tab && tab.classList.contains('active'));
        if (isActive && !document.hidden) {
            loadEmailAnalyticsPie();
        }
    }, 45000);
}

function renderEmailSummary(summary) {
    const total30d = Number(summary?.last30d || 0);
    const sentTotal = Number(summary?.sentTotal || 0);
    const failedTotal = Number(summary?.failedTotal || 0);
    const blockedTotal = Number(summary?.blockedTotal || 0);
    const transientFailedTotal = Number(summary?.transientFailedTotal || 0);
    const permanentFailedTotal = Number(summary?.permanentFailedTotal || 0);
    const avgLatencyMs = Number(summary?.avgLatencyMs || 0);
    const successRate = total30d > 0 ? ((sentTotal / total30d) * 100).toFixed(1) : '0.0';

    const totalEl = document.getElementById('emailSummaryTotal');
    const successEl = document.getElementById('emailSummarySuccessRate');
    const last24El = document.getElementById('emailSummaryLast24h');
    const failEl = document.getElementById('emailSummaryFailures');
    const transientEl = document.getElementById('emailSummaryTransientFails');
    const permanentEl = document.getElementById('emailSummaryPermanentFails');
    const latencyEl = document.getElementById('emailSummaryAvgLatency');

    if (totalEl) totalEl.textContent = total30d.toLocaleString();
    if (successEl) successEl.textContent = `${successRate}%`;
    if (last24El) last24El.textContent = Number(summary?.last24h || 0).toLocaleString();
    if (failEl) failEl.textContent = (failedTotal + blockedTotal).toLocaleString();
    if (transientEl) transientEl.textContent = transientFailedTotal.toLocaleString();
    if (permanentEl) permanentEl.textContent = permanentFailedTotal.toLocaleString();
    if (latencyEl) latencyEl.textContent = avgLatencyMs > 0 ? avgLatencyMs.toFixed(0) : '0';
}

function renderEmailFailureCategories(categories) {
    const tbody = document.getElementById('emailFailureCategoryBody');
    if (!tbody) return;

    if (!Array.isArray(categories) || categories.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" class="text-center text-muted">No failure categories available</td></tr>';
        return;
    }

    tbody.innerHTML = categories.map((row) => {
        const category = String(row.category || 'other').replace(/_/g, ' ');
        const count = Number(row.count || 0);
        return `<tr>
                    <td>${sanitizeHtml(category)}</td>
                    <td>${count.toLocaleString()}</td>
                </tr>`;
    }).join('');
}

function renderEmailFailingDomains(domains) {
    const tbody = document.getElementById('emailFailingDomainBody');
    if (!tbody) return;

    if (!Array.isArray(domains) || domains.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No failing domains detected</td></tr>';
        return;
    }

    tbody.innerHTML = domains.map((row) => {
        const total = Number(row.total || 0);
        const failed = Number(row.failed || 0);
        const blocked = Number(row.blocked || 0);
        const failedOrBlocked = failed + blocked;
        const failureRate = total > 0 ? ((failedOrBlocked / total) * 100).toFixed(1) : '0.0';

        return `<tr>
                    <td>${sanitizeHtml(row.recipient_domain || '-')}</td>
                    <td>${total.toLocaleString()}</td>
                    <td>${failedOrBlocked.toLocaleString()}</td>
                    <td>${failureRate}%</td>
                </tr>`;
    }).join('');
}

function renderEmailTemplatePie(templates) {
    const pieCanvas = document.getElementById('emailAnalyticsPieChart');
    const legendEl = document.getElementById('emailAnalyticsPieLegend');
    if (!pieCanvas || !legendEl) return;

    if (!Array.isArray(templates) || templates.length === 0) {
        legendEl.innerHTML = '<div class="text-muted">No template analytics available yet</div>';
        if (emailAnalyticsPieChart) {
            emailAnalyticsPieChart.destroy();
            emailAnalyticsPieChart = null;
        }
        return;
    }

    const labels = templates.map(row => row.template_name || 'generic');
    const values = templates.map(row => Number(row.total || 0));
    const colors = [
        '#5b7fff', '#5bffb8', '#ffd45b', '#ff5b5b', '#ffb84d', '#a78bfa', '#f472b6', '#34d399', '#f87171', '#facc15'
    ];

    if (emailAnalyticsPieChart) emailAnalyticsPieChart.destroy();
    emailAnalyticsPieChart = new Chart(pieCanvas, {
        type: 'pie',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: colors.slice(0, labels.length),
                borderColor: '#222c37',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            const label = context.label || '';
                            const value = context.parsed || 0;
                            const total = values.reduce((a, b) => a + b, 0);
                            const percent = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
                            return `${label}: ${value} (${percent}%)`;
                        }
                    }
                }
            }
        }
    });

    const total = values.reduce((a, b) => a + b, 0);
    legendEl.innerHTML = labels.map((label, i) => {
        const value = values[i];
        const percent = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
        return `<span style="display:inline-block;width:12px;height:12px;background:${colors[i]};border-radius:3px;margin-right:7px;vertical-align:middle;"></span><span style="font-weight:600;">${sanitizeHtml(label)}</span>: <span>${value} (${percent}%)</span>`;
    }).join('<br>');
}

function renderEmailTemplateBreakdown(templates) {
    const tbody = document.getElementById('emailTemplateBreakdownBody');
    if (!tbody) return;

    if (!Array.isArray(templates) || templates.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No template breakdown available</td></tr>';
        return;
    }

    tbody.innerHTML = templates.map((row) => {
        const total = Number(row.total || 0);
        const sent = Number(row.sent || 0);
        const failed = Number(row.failed || 0);
        const blocked = Number(row.blocked || 0);
        const successRate = total > 0 ? ((sent / total) * 100).toFixed(1) : '0.0';
        return `<tr>
                    <td>${sanitizeHtml(row.template_name || 'generic')}</td>
                    <td>${total}</td>
                    <td style="color: var(--color-green);">${sent}</td>
                    <td style="color: var(--color-red);">${failed}</td>
                    <td style="color: var(--color-orange);">${blocked}</td>
                    <td>${successRate}%</td>
                </tr>`;
    }).join('');
}

function renderEmailTrend(trends) {
    const canvas = document.getElementById('emailAnalyticsTrendChart');
    if (!canvas) return;

    if (emailAnalyticsTrendChart) {
        emailAnalyticsTrendChart.destroy();
        emailAnalyticsTrendChart = null;
    }

    if (!Array.isArray(trends) || trends.length === 0) {
        return;
    }

    const labels = trends.map(row => new Date(row.day).toLocaleDateString());
    const sent = trends.map(row => Number(row.sent || 0));
    const failed = trends.map(row => Number(row.failed || 0));
    const blocked = trends.map(row => Number(row.blocked || 0));

    emailAnalyticsTrendChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Sent',
                    data: sent,
                    borderColor: '#34d399',
                    backgroundColor: 'rgba(52, 211, 153, 0.2)',
                    tension: 0.35,
                    fill: true
                },
                {
                    label: 'Failed',
                    data: failed,
                    borderColor: '#f87171',
                    backgroundColor: 'rgba(248, 113, 113, 0.15)',
                    tension: 0.35,
                    fill: true
                },
                {
                    label: 'Blocked',
                    data: blocked,
                    borderColor: '#facc15',
                    backgroundColor: 'rgba(250, 204, 21, 0.15)',
                    tension: 0.35,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    position: 'top'
                }
            },
            scales: {
                y: {
                    beginAtZero: true
                }
            }
        }
    });
}

function renderEmailRecentRows(recentRows) {
    const tbody = document.getElementById('emailRecentTableBody');
    if (!tbody) return;

    if (!Array.isArray(recentRows) || recentRows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No recent deliveries found</td></tr>';
        return;
    }

    tbody.innerHTML = recentRows.map((row) => {
        const status = String(row.status || '').toLowerCase();
        let statusColor = 'var(--text-secondary)';
        if (status === 'sent') statusColor = 'var(--color-green)';
        if (status === 'failed') statusColor = 'var(--color-red)';
        if (status === 'blocked') statusColor = 'var(--color-orange)';

        return `<tr>
                    <td>${new Date(row.created_at).toLocaleString()}</td>
                    <td>${sanitizeHtml(row.recipient_email || '-')}</td>
                    <td>${sanitizeHtml(row.template_name || 'generic')}</td>
                    <td style="color: ${statusColor}; font-weight: 700; text-transform: uppercase;">${sanitizeHtml(status || '-')}</td>
                    <td>${sanitizeHtml(row.subject || '-')}</td>
                    <td>${sanitizeHtml(row.error_message || '-')}</td>
                </tr>`;
    }).join('');
}

function exportEmailRecentCsv() {
    if (!Array.isArray(latestEmailRecentRows) || latestEmailRecentRows.length === 0) {
        showNotification('No recent email deliveries to export', 'warning');
        return;
    }

    const headers = ['Created At', 'Recipient', 'Template', 'Status', 'Subject', 'Error'];
    const rows = latestEmailRecentRows.map((row) => [
        new Date(row.created_at).toLocaleString(),
        row.recipient_email || '',
        row.template_name || '',
        row.status || '',
        row.subject || '',
        row.error_message || ''
    ]);

    const csv = [headers.join(',')]
        .concat(rows.map(cols => cols.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')))
        .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `email-analytics-recent-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function loadEmailAnalyticsPie() {
    const legendEl = document.getElementById('emailAnalyticsPieLegend');
    if (!legendEl) return;

    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/owner/email-analytics');
        if (!response.ok) {
            legendEl.innerHTML = '<div class="message error">Failed to load email analytics</div>';
            return;
        }

        const summary = data?.summary || {};
        const templates = Array.isArray(data?.templates) ? data.templates : [];
        const trends = Array.isArray(data?.trends) ? data.trends : [];
        const recent = Array.isArray(data?.recent) ? data.recent : [];
        const failureCategories = Array.isArray(data?.failureCategories) ? data.failureCategories : [];
        const failingDomains = Array.isArray(data?.failingDomains) ? data.failingDomains : [];

        latestEmailRecentRows = recent;
        renderEmailSummary(summary);
        renderEmailTemplatePie(templates);
        renderEmailTemplateBreakdown(templates);
        renderEmailTrend(trends);
        renderEmailRecentRows(recent);
        renderEmailFailureCategories(failureCategories);
        renderEmailFailingDomains(failingDomains);

        emailAnalyticsLastUpdatedAt = new Date();
        renderEmailAnalyticsLastUpdated();
    } catch (error) {
        legendEl.innerHTML = '<div class="message error">Failed to load email analytics</div>';
        emailAnalyticsLastUpdatedAt = null;
        renderEmailAnalyticsLastUpdated();
    }
}

async function loadEmailAnalytics() {
    await loadEmailAnalyticsPie();
}

document.addEventListener('DOMContentLoaded', function () {
    startEmailAnalyticsAutoRefresh();
    startEmailAnalyticsLastUpdatedTicker();

    const tabs = document.querySelectorAll('#ownerTabs .tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', function () {
            const tabName = tab.getAttribute('data-tab');
            if (tabName === 'alert-analytics') {
                loadAlertAnalytics();
            }
            if (tabName === 'email-analytics') {
                loadEmailAnalyticsPie();
            }
            if (tabName === 'verification-analytics') {
                loadVerificationAnalytics();
            }
        });
    });

    const alertTab = document.getElementById('alert-analytics');
    if (alertTab && alertTab.classList.contains('active')) {
        loadAlertAnalytics();
    }

    const emailTab = document.getElementById('email-analytics');
    if (emailTab && emailTab.classList.contains('active')) {
        loadEmailAnalyticsPie();
    }

    const verificationTab = document.getElementById('verification-analytics');
    if (verificationTab && verificationTab.classList.contains('active')) {
        loadVerificationAnalytics();
    }
});

window.addEventListener('beforeunload', () => {
    if (emailAnalyticsRefreshIntervalId) {
        clearInterval(emailAnalyticsRefreshIntervalId);
        emailAnalyticsRefreshIntervalId = null;
    }
    if (emailAnalyticsLastUpdatedTickerId) {
        clearInterval(emailAnalyticsLastUpdatedTickerId);
        emailAnalyticsLastUpdatedTickerId = null;
    }
});