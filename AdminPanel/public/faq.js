document.addEventListener('DOMContentLoaded', async () => {
	try {
		let api = window.api || (window.AdminPanel && window.AdminPanel.api);
		if (!api && window.AdminPanel) api = window.AdminPanel.api;
		if (api && typeof api.getAccountInfo === 'function') {
			const accountInfo = await api.getAccountInfo();
			if (accountInfo) {
				document.getElementById('headerUsername').textContent = accountInfo.username || 'User';
				document.getElementById('headerRole').textContent = (accountInfo.role || 'User').toUpperCase();
				document.getElementById('dropdownUsername').textContent = accountInfo.username || 'User';
				document.getElementById('dropdownRole').textContent = (accountInfo.role || 'User').toUpperCase();
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