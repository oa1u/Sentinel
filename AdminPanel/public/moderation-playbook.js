
let currentTab = 'overview';

function applyPlaybookTab(tab) {
    const safeTab = tab || 'overview';
    currentTab = safeTab;
    const tabButtons = document.querySelectorAll('[data-playbook-tab]');
    const tabContents = document.querySelectorAll('.playbook-tab-content');

    tabButtons.forEach((button) => {
        const isActive = button.dataset.playbookTab === safeTab;
        button.classList.toggle('active', isActive);
    });

    tabContents.forEach((panel) => {
        panel.classList.remove('active');
        panel.style.display = 'none';

        const cards = panel.querySelectorAll('.playbook-card');
        cards.forEach(c => c.style.display = '');
    });

    const targetId = `playbook${safeTab.charAt(0).toUpperCase()}${safeTab.slice(1)}Content`;
    const activePanel = document.getElementById(targetId);
    if (activePanel) {
        activePanel.classList.add('active');
        activePanel.style.display = '';
    }

    const searchInput = document.getElementById('playbookSearch');
    if (searchInput) searchInput.value = '';
}

function handleSearch(query) {
    const term = query.toLowerCase().trim();
    const tabContents = document.querySelectorAll('.playbook-tab-content');

    if (!term) {
        applyPlaybookTab(currentTab);
        return;
    }

    tabContents.forEach(panel => {
        let hasVisibleCard = false;

        const cards = panel.querySelectorAll('.playbook-card');
        cards.forEach(card => {
            const text = card.textContent.toLowerCase();
            const keywords = (card.dataset.keywords || '').toLowerCase();
            if (text.includes(term) || keywords.includes(term)) {
                card.style.display = '';
                hasVisibleCard = true;
            } else {
                card.style.display = 'none';
            }
        });

        if (hasVisibleCard) {
            panel.style.display = 'block';
            panel.classList.add('active');
        } else {
            panel.style.display = 'none';
            panel.classList.remove('active');
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof document === 'undefined') return;

    try {
        const api = window.api || (window.AdminPanel && window.AdminPanel.api);
        if (api && typeof api.getAccountInfo === 'function') {
            const accountInfo = await api.getAccountInfo();
            if (accountInfo) {
                const safeText = (id, val) => {
                    const el = document.getElementById(id);
                    if (el) el.textContent = String(val || 'User');
                };
                safeText('headerUsername', accountInfo.username);
                safeText('headerRole', accountInfo.role);
                safeText('dropdownUsername', accountInfo.username);
                safeText('dropdownRole', accountInfo.role);

                if (typeof api.applyRoleVisibility === 'function') {
                    api.applyRoleVisibility(accountInfo);
                }
            }
        }
    } catch (err) { console.error('Playbook user sync failed', err); }

    const playbookTabs = document.querySelectorAll('[data-playbook-tab]');
    playbookTabs.forEach((button) => {
        button.addEventListener('click', () => {
            applyPlaybookTab(button.dataset.playbookTab);
        });
    });

    const searchInput = document.getElementById('playbookSearch');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            handleSearch(e.target.value);
        });
    }

    const firstActive = document.querySelector('[data-playbook-tab].active');
    applyPlaybookTab(firstActive ? firstActive.dataset.playbookTab : 'overview');
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
window.copyToClipboard = async function (text) {
    try {
        await navigator.clipboard.writeText(text);
        if (typeof showNotification === 'function') {
            showNotification('Copied to clipboard!', 'success');
        } else {
            alert('Copied specific command to clipboard');
        }
    } catch (err) {
        console.error('Failed to copy: ', err);
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            if (typeof showNotification === 'function') {
                showNotification('Copied to clipboard!', 'success');
            }
        } catch (e) {
            console.error('Fallback copy failed', e);
        }
        document.body.removeChild(textArea);
    }
};
