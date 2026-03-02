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
	const tabs = document.querySelectorAll('.tab');
	const tabContents = document.querySelectorAll('.tab-content');
	tabs.forEach(tab => {
		tab.addEventListener('click', function () {
			tabs.forEach(t => t.classList.remove('active'));
			tab.classList.add('active');
			const tabName = tab.getAttribute('data-tab');
			tabContents.forEach(tc => {
				if (tc.id === 'tab-' + tabName) {
					tc.classList.add('active');
					tc.style.display = '';
				} else {
					tc.classList.remove('active');
					tc.style.display = 'none';
				}
			});
		});
	});
	// Hide all but the first tab content on load
	tabContents.forEach((tc, idx) => {
		if (idx !== 0) tc.style.display = 'none';
	});
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