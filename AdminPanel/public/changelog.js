/* Changelog page utilities — helper functions for rendering and interacting with the changelog. */
document.addEventListener('DOMContentLoaded', async () => {
    if (!window.api || !window.ui) {
        const { api, ui } = window.AdminPanel || {};
        window.api = api;
        window.ui = ui;
    }

    try {
        if (window.api && typeof window.api.getAccountInfo === 'function') {
            const accountInfo = await window.api.getAccountInfo();
            if (accountInfo) {
                const username = accountInfo.username || 'User';
                const roleLabel = (accountInfo.role || 'User').toUpperCase();
                const headerUsername = document.getElementById('headerUsername') || document.getElementById('userDisplay');
                const headerRole = document.getElementById('headerRole') || document.getElementById('roleBadge');
                if (headerUsername) headerUsername.textContent = username;
                if (headerRole) headerRole.textContent = roleLabel;
                const dropdownUsername = document.getElementById('dropdownUsername');
                const dropdownRole = document.getElementById('dropdownRole');
                if (dropdownUsername) dropdownUsername.textContent = username;
                if (dropdownRole) dropdownRole.textContent = roleLabel;

                if (typeof window.api.applyRoleVisibility === 'function') {
                    window.api.applyRoleVisibility(accountInfo);
                }
            }
        }
    } catch (err) { }

    const tabs = document.querySelectorAll('#changelogTabs .changelog-tab');
    const tabContents = document.querySelectorAll('.tab-content');

    tabs.forEach((tab) => {
        tab.addEventListener('click', function () {
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');

            const tabName = tab.getAttribute('data-tab');
            tabContents.forEach((tc) => {
                if (tc.id === tabName) {
                    tc.classList.add('active');
                    tc.style.display = '';
                } else {
                    tc.classList.remove('active');
                    tc.style.display = 'none';
                }
            });
        });
    });

    tabContents.forEach((tc, idx) => {
        if (idx !== 0) tc.style.display = 'none';
    });

    const primaryLink = document.getElementById('githubIssuesLink');
    const quickLink = document.getElementById('quickIssuesLink');
    const latestReleaseVersion = document.getElementById('latestReleaseVersion');

    try {
        const response = await fetch('/Config/main.json', { cache: 'no-store' });
        if (response.ok) {
            const config = await response.json();
            const version = String(config?.Version || '').trim();
            if (latestReleaseVersion && version) {
                latestReleaseVersion.textContent = version.toLowerCase().startsWith('v') ? version : `v${version}`;
            }

            const repo = config?.githublink || 'https://github.com/oa1u/Sentinel';
            if (repo) {
                const cleanRepo = String(repo).trim().replace(/\/$/, '');
                const issuesUrl = `${cleanRepo}/issues`;
                if (primaryLink) primaryLink.href = issuesUrl;
                if (quickLink) quickLink.href = issuesUrl;
            }
        }
    } catch (err) { }
});

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