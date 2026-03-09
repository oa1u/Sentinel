// Load user info and update navbar for Features page
document.addEventListener('DOMContentLoaded', async () => {
	// Ensure window.api is set (like dashboard.js)
	if (!window.api || !window.ui) {
		const { api, ui } = window.AdminPanel || {};
		window.api = api;
		window.ui = ui;
	}
	try {
		if (window.api && typeof window.api.getAccountInfo === 'function') {
			const accountInfo = await window.api.getAccountInfo();
			if (accountInfo) {
				document.getElementById('headerUsername').textContent = accountInfo.username || 'User';
				document.getElementById('headerRole').textContent = (accountInfo.role || 'User').toUpperCase();
				document.getElementById('dropdownUsername').textContent = accountInfo.username || 'User';
				document.getElementById('dropdownRole').textContent = (accountInfo.role || 'User').toUpperCase();
			}
		}
	} catch (err) { }

	// Tab system logic
	const tabsContainer = document.getElementById('featuresTabs');
	const tabs = Array.from(document.querySelectorAll('.tab'));
	const tabContents = Array.from(document.querySelectorAll('.tab-content'));

	if (tabsContainer) {
		tabsContainer.setAttribute('role', 'tablist');
	}

	const activateTab = (tab) => {
		if (!tab) return;
		const tabName = tab.getAttribute('data-tab');
		if (!tabName) return;

		tabs.forEach((t) => {
			const isActive = t === tab;
			t.classList.toggle('active', isActive);
			t.setAttribute('aria-selected', isActive ? 'true' : 'false');
			t.tabIndex = isActive ? 0 : -1;
		});

		tabContents.forEach((panel) => {
			const isActive = panel.id === `tab-${tabName}`;
			panel.classList.toggle('active', isActive);
			panel.style.display = isActive ? '' : 'none';
		});

		if (typeof tab.scrollIntoView === 'function') {
			tab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
		}
	};

	const wireTab = (tab, index) => {
		const tabName = tab.getAttribute('data-tab');
		const panel = tabName ? document.getElementById(`tab-${tabName}`) : null;

		tab.setAttribute('role', 'tab');
		if (panel) {
			panel.setAttribute('role', 'tabpanel');
			const tabId = `features-tab-${tabName}`;
			tab.id = tabId;
			panel.setAttribute('aria-labelledby', tabId);
		}

		tab.addEventListener('click', () => activateTab(tab));
		tab.addEventListener('keydown', (event) => {
			if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
			event.preventDefault();
			const dir = event.key === 'ArrowLeft' ? -1 : 1;
			let nextIndex = index;
			if (event.key === 'Home') nextIndex = 0;
			else if (event.key === 'End') nextIndex = tabs.length - 1;
			else nextIndex = (index + dir + tabs.length) % tabs.length;

			const nextTab = tabs[nextIndex];
			if (nextTab) {
				nextTab.focus();
				activateTab(nextTab);
			}
		});
	};

	tabs.forEach((tab, index) => wireTab(tab, index));

	// Hide all but the first tab content on load
	tabContents.forEach((panel, idx) => {
		panel.style.display = idx === 0 ? '' : 'none';
	});
	if (tabs[0]) {
		activateTab(tabs[0]);
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