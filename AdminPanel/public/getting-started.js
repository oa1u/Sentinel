/* Getting Started page — onboarding helpers and checklist UI for first-time setup. */
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const api = window.AdminPanel && window.AdminPanel.api;
        if (api && typeof api.getAccountInfo === 'function') {
            const accountInfo = await api.getAccountInfo();
            if (accountInfo) {
                document.getElementById('headerUsername').textContent = accountInfo.username || 'User';
                document.getElementById('headerRole').textContent = (accountInfo.role || 'User').toUpperCase();
                document.getElementById('dropdownUsername').textContent = accountInfo.username || 'User';
                document.getElementById('dropdownRole').textContent = (accountInfo.role || 'User').toUpperCase();
                api.applyRoleVisibility(accountInfo);
            }
        }
    } catch (err) { }

    initLaunchChecklistTabs();
    initConfigReadinessChecker();
});

function initLaunchChecklistTabs() {
    const tabWrap = document.getElementById('gsChecklistTabs');
    if (!tabWrap) return;

    const tabs = tabWrap.querySelectorAll('.gs-checklist-tab');
    const panels = document.querySelectorAll('.gs-checklist-panel');
    if (!tabs.length || !panels.length) return;

    const showPanel = (panelKey) => {
        tabs.forEach((tab) => {
            tab.classList.toggle('active', tab.getAttribute('data-gs-checklist') === panelKey);
        });

        panels.forEach((panel) => {
            panel.classList.toggle('active', panel.id === `gsChecklist-${panelKey}`);
        });
    };

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const key = tab.getAttribute('data-gs-checklist');
            if (!key) return;
            showPanel(key);
        });
    });

    showPanel('infra');
}

function initConfigReadinessChecker() {
    const runButton = document.getElementById('gsConfigReadinessRun');
    if (!runButton) return;

    runButton.addEventListener('click', runConfigReadinessCheck);
}

function setReadinessProgress(percent, label) {
    const bounded = Math.max(0, Math.min(100, Number(percent) || 0));
    const progressBar = document.getElementById('gsReadinessProgressBar');
    const progressValue = document.getElementById('gsReadinessProgressValue');
    const progressLabel = document.getElementById('gsReadinessProgressLabel');

    if (progressBar) {
        progressBar.style.width = `${bounded}%`;
    }

    if (progressValue) {
        progressValue.textContent = `${Math.round(bounded)}%`;
    }

    if (progressLabel && label) {
        progressLabel.textContent = label;
    }
}

function renderReadinessSummary(summary) {
    const wrap = document.getElementById('gsReadinessSummary');
    if (!wrap || !summary) return;

    const score = Number(summary.score) || 0;
    const pass = Number(summary.passed) || 0;
    const warn = Number(summary.warnings) || 0;
    const fail = Number(summary.failed) || 0;
    const readyText = summary.ready ? 'Ready: yes' : 'Ready: no';

    wrap.innerHTML = `
		<span class="gs-readiness-chip">Score: ${score}%</span>
		<span class="gs-readiness-chip">Pass: ${pass}</span>
		<span class="gs-readiness-chip">Warn: ${warn}</span>
		<span class="gs-readiness-chip">Fail: ${fail}</span>
		<span class="gs-readiness-chip">${readyText}</span>
	`;
}

function renderReadinessChecks(checks) {
    const list = document.getElementById('gsReadinessList');
    if (!list) return;

    const safeChecks = Array.isArray(checks) ? checks : [];
    if (!safeChecks.length) {
        list.innerHTML = `
			<li class="gs-readiness-item warn">
				<div class="gs-readiness-top">
					<span class="gs-readiness-label">No checks returned</span>
					<span class="gs-readiness-state">warn</span>
				</div>
				<p class="gs-readiness-message">The scanner did not return any check rows.</p>
			</li>
		`;
        return;
    }

    list.innerHTML = safeChecks.map((check) => {
        const status = check && check.status ? String(check.status).toLowerCase() : 'warn';
        const state = status === 'fail' || status === 'warn' || status === 'pass' ? status : 'warn';
        const label = check && check.label ? String(check.label) : 'Unknown check';
        const message = check && check.message ? String(check.message) : 'No details provided.';

        return `
			<li class="gs-readiness-item ${state}">
				<div class="gs-readiness-top">
					<span class="gs-readiness-label">${escapeHtml(label)}</span>
					<span class="gs-readiness-state">${state}</span>
				</div>
				<p class="gs-readiness-message">${escapeHtml(message)}</p>
			</li>
		`;
    }).join('');
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function runConfigReadinessCheck() {
    const runButton = document.getElementById('gsConfigReadinessRun');
    const hint = document.getElementById('gsReadinessHint');
    if (!runButton) return;

    runButton.disabled = true;
    hint.textContent = 'Running config scan…';
    setReadinessProgress(6, 'Starting');

    let fakeProgress = 6;
    const progressTimer = setInterval(() => {
        if (fakeProgress >= 82) return;
        fakeProgress += Math.random() * 8;
        setReadinessProgress(fakeProgress, 'Checking files');
    }, 180);

    try {
        const response = await fetch('/api/getting-started/config-readiness', {
            method: 'GET',
            credentials: 'same-origin',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `Request failed (${response.status})`);
        }

        const payload = await response.json();
        setReadinessProgress(90, 'Finalizing');
        renderReadinessSummary(payload.summary || {});
        renderReadinessChecks(payload.checks || []);
        setReadinessProgress(100, 'Complete');

        const summary = payload.summary || {};
        const failCount = Number(summary.failed) || 0;
        const warnCount = Number(summary.warnings) || 0;
        if (failCount > 0) {
            hint.textContent = `Scan complete: ${failCount} blocking issue(s) need attention.`;
        } else if (warnCount > 0) {
            hint.textContent = `Scan complete: no blockers, but ${warnCount} warning(s) should be reviewed.`;
        } else {
            hint.textContent = 'Scan complete: Config folder looks fully ready.';
        }
    } catch (error) {
        setReadinessProgress(100, 'Failed');
        hint.textContent = `Scan failed: ${error.message}`;
        renderReadinessSummary({ score: 0, passed: 0, warnings: 0, failed: 1, ready: false });
        renderReadinessChecks([
            {
                label: 'Config readiness request',
                status: 'fail',
                message: error.message || 'Unknown error while checking config readiness.'
            }
        ]);
    } finally {
        clearInterval(progressTimer);
        runButton.disabled = false;
    }
}

function toggleUserDropdown() {
    const menu = document.getElementById('userDropdownMenu');
    const trigger = document.querySelector('.user-dropdown-trigger');
    if (menu && trigger) {
        menu.classList.toggle('show');
        trigger.classList.toggle('active');
    }
}

document.addEventListener('click', function (event) {
    const dropdown = document.querySelector('.user-dropdown');
    if (dropdown && !dropdown.contains(event.target)) {
        const menu = document.getElementById('userDropdownMenu');
        const trigger = document.querySelector('.user-dropdown-trigger');
        if (menu) menu.classList.remove('show');
        if (trigger) trigger.classList.remove('active');
    }
});