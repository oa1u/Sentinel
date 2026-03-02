/* Moderation playbook UI helpers — tab switching and role-based visibility handling. */
function applyPlaybookTab(tab) {
    const safeTab = tab || 'overview';
    const tabButtons = document.querySelectorAll('[data-playbook-tab]');
    const tabContents = document.querySelectorAll('.profile-content-area .tab-content');

    tabButtons.forEach((button) => {
        const isActive = button.dataset.playbookTab === safeTab;
        button.classList.toggle('active', isActive);
    });

    tabContents.forEach((panel) => {
        panel.classList.remove('active');
        panel.style.display = 'none';
    });

    const targetId = `playbook${safeTab.charAt(0).toUpperCase()}${safeTab.slice(1)}Content`;
    const activePanel = document.getElementById(targetId);
    if (activePanel) {
        activePanel.classList.add('active');
        activePanel.style.display = '';
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const api = window.api || (window.AdminPanel && window.AdminPanel.api);
        if (api && typeof api.getAccountInfo === 'function') {
            const accountInfo = await api.getAccountInfo();
            if (accountInfo) {
                document.getElementById('headerUsername').textContent = accountInfo.username || 'User';
                document.getElementById('headerRole').textContent = (accountInfo.role || 'User').toUpperCase();
                document.getElementById('dropdownUsername').textContent = accountInfo.username || 'User';
                document.getElementById('dropdownRole').textContent = (accountInfo.role || 'User').toUpperCase();
                if (typeof api.applyRoleVisibility === 'function') {
                    api.applyRoleVisibility(accountInfo);
                }
            }
        }
    } catch (err) { }

    const playbookTabs = document.querySelectorAll('[data-playbook-tab]');
    if (playbookTabs.length > 0) {
        playbookTabs.forEach((button) => {
            button.addEventListener('click', () => {
                applyPlaybookTab(button.dataset.playbookTab);
            });
        });

        const firstActive = document.querySelector('[data-playbook-tab].active');
        applyPlaybookTab(firstActive ? firstActive.dataset.playbookTab : 'overview');
    }
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
