// Revoke invite code (owner panel)
async function revokeInvite(code) {
    if (!code) return;
    if (!confirm('Are you sure you want to revoke this invite code?')) return;
    try {
        const response = await fetch(`/api/invites/revoke/${encodeURIComponent(code)}`, { method: 'POST', credentials: 'include' });
        if (response.ok) {
            // Remove the invite row from the UI
            const btn = document.querySelector(`button[onclick*="revokeInvite('${code}')"]`);
            if (btn) {
                const row = btn.closest('tr');
                if (row) row.remove();
            }
        } else {
            const data = await response.json().catch(() => ({}));
            alert('Failed to delete invite: ' + (data.error || response.statusText));
        }
    } catch (error) {
        alert('Error deleting invite: ' + error.message);
    }
}
// This function lets you open and close the user dropdown menu. Makes navigation easier for owners.
function toggleUserDropdown() {
    const menu = document.getElementById('userDropdownMenu');
    const trigger = document.querySelector('.user-dropdown-trigger');
    if (menu && trigger) {
        menu.classList.toggle('show');
        trigger.classList.toggle('active');
    }
}
// This script handles all the owner-level features and access. Only for the top admin!
if (!window.api || !window.ui) {
    const { api, ui } = window.AdminPanel || {};
    window.api = api;
    window.ui = ui;
}

document.addEventListener('DOMContentLoaded', async () => {
    let accountInfo;
    try {
        accountInfo = await checkOwnerAccess();
        if (accountInfo && typeof accountInfo === 'object' && accountInfo.username && accountInfo.role) {
            if (typeof io !== 'undefined') {
                try {
                    window.socket = io({
                        auth: {
                            username: accountInfo.username,
                            role: accountInfo.role
                        }
                    });
                } catch (err) {
                    console.error('Socket.IO connection failed:', err);
                }
            }
        } else {
            console.error('Owner account info missing or invalid:', accountInfo);
            window.location.href = '/unauthorized';
            return;
        }
    } catch (error) {
        console.error('Failed to load owner account info:', error);
        window.location.href = '/unauthorized';
        return;
    }
    
    // Set up tab event listeners
    document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabName = e.target.dataset.tab;
            if (tabName) {
                switchTab(e, tabName);
            }
        });
    });
    
    await loadSystemStatus();
    setupLiveTerminal();
function setupLiveTerminal() {
    const terminalOutput = document.getElementById('terminalOutput');
    if (!terminalOutput) return;
    // Set up the live terminal with socket.io client
    let socket;
    if (typeof io !== 'undefined') {
        socket = io({
            secure: true,
            transports: ['websocket'],
            withCredentials: true
        });
        window.socket = socket;
    } else {
        console.error('Socket.IO client library not loaded.');
        return;
    }
    socket.emit('request-terminal-logs', { limit: 50 });
    socket.on('terminal-logs', logs => {
        if (Array.isArray(logs)) {
            terminalOutput.innerHTML = logs.map(line => `<div>${line}</div>`).join('');
            terminalOutput.scrollTop = terminalOutput.scrollHeight;
        }
    });
    // Listen for new log lines
    socket.on('terminal-log-line', line => {
        if (line) {
            const div = document.createElement('div');
            div.textContent = line;
            terminalOutput.appendChild(div);
            terminalOutput.scrollTop = terminalOutput.scrollHeight;
        }
    });
}
});

async function checkOwnerAccess() {
    try {
        const data = await api.getAccountInfo();
        if (!data) {
            window.location.href = '/login';
            return null;
        }
        if (data.role !== 'owner') {
            window.location.href = '/admin';
            return null;
        }

        // Update user display
        const username = data.username || 'Owner';
        ui?.setText('userDisplay', username);
        ui?.setText('dropdownUsername', username);
        ui?.setText('roleDisplay', 'OWNER');
        ui?.setText('dropdownRole', 'OWNER');
        return data;
    } catch (error) {
        window.location.href = '/login';
        return null;
    }
}

function switchTab(e, tabName) {
    e.preventDefault();
    
    // Hide everything first
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    
    // Deactivate all tab buttons
    document.querySelectorAll('.tab').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Show selected tab
    document.getElementById(tabName).classList.add('active');
    e.target.classList.add('active');
}

async function loadSystemStatus() {
    try {
        const response = await fetch('/api/admin/guild-stats');
        if (response.ok) {
            const data = await response.json();
            const systemStats = document.getElementById('systemStats');
            if (systemStats) {
                systemStats.innerHTML = `
                    <div class="stat-card">
                        <div class="stat-icon blue">👥</div>
                        <div class="stat-content">
                            <div class="stat-value">${data.totalMembers?.toLocaleString() || 0}</div>
                            <div class="stat-label">Total Members</div>
                        </div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon green">📝</div>
                        <div class="stat-content">
                            <div class="stat-value">${data.totalChannels || 0}</div>
                            <div class="stat-label">Total Channels</div>
                        </div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon orange">🎭</div>
                        <div class="stat-content">
                            <div class="stat-value">${data.totalRoles || 0}</div>
                            <div class="stat-label">Total Roles</div>
                        </div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon purple">🤖</div>
                        <div class="stat-content">
                            <div class="stat-value">${data.botMembers || 0}</div>
                            <div class="stat-label">Bot Members</div>
                        </div>
                    </div>
                `;
            }
        }
    } catch (error) {
        console.error('Error loading system status:', error);
    }
}

function toggleUserDropdown() {
    const menu = document.getElementById('userDropdownMenu');
    const trigger = document.querySelector('.user-dropdown-trigger');
    menu.classList.toggle('show');
    trigger.classList.toggle('active');
}
document.addEventListener('click', function(event) {
    const dropdown = document.querySelector('.user-dropdown');
    if (dropdown && !dropdown.contains(event.target)) {
        document.getElementById('userDropdownMenu')?.classList.remove('show');
        document.querySelector('.user-dropdown-trigger')?.classList.remove('active');
    }
});
function syncDropdownInfo() {
    const username = document.getElementById('headerUsername')?.textContent;
    const role = document.getElementById('headerRole')?.textContent;
    if (username) document.getElementById('dropdownUsername').textContent = username;
    if (role) document.getElementById('dropdownRole').textContent = role;
}
setTimeout(syncDropdownInfo, 500);

async function logout() {
    fetch('/api/logout', { method: 'POST' }).then(() => {
        window.location.href = '/login';
    });
}