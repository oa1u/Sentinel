// This just opens or closes the user dropdown menu when you click the trigger.
function toggleUserDropdown() {
    const menu = document.getElementById('userDropdownMenu');
    const trigger = document.querySelector('.user-dropdown-trigger');
    if (menu && trigger) {
        menu.classList.toggle('show');
        trigger.classList.toggle('active');
    }
}
document.addEventListener('click', function(event) {
    const dropdown = document.querySelector('.user-dropdown');
    if (dropdown && !dropdown.contains(event.target)) {
        const menu = document.getElementById('userDropdownMenu');
        const trigger = document.querySelector('.user-dropdown-trigger');
        if (menu) menu.classList.remove('show');
        if (trigger) trigger.classList.remove('active');
    }
});
function syncDropdownInfo() {
    const username = document.getElementById('headerUsername')?.textContent;
    const role = document.getElementById('headerRole')?.textContent;
    if (username && document.getElementById('dropdownUsername')) {
        document.getElementById('dropdownUsername').textContent = username;
    }
    if (role && document.getElementById('dropdownRole')) {
        document.getElementById('dropdownRole').textContent = role;
    }
}
setTimeout(syncDropdownInfo, 500);

// Robust admin panel tab system

document.addEventListener('DOMContentLoaded', async () => {
    // User info sync
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
    } catch (err) {}

    // Tab system
    const tabButtons = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');
    function activateTab(tabName) {
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabContents.forEach(tc => {
            tc.classList.remove('active');
            tc.style.display = 'none';
        });
        const btn = document.querySelector('.tab[data-tab="' + tabName + '"]');
        const content = document.getElementById(tabName);
        if (btn) btn.classList.add('active');
        if (content) {
            content.classList.add('active');
            content.style.display = '';
        }
        // Load tab-specific data
        if (tabName === 'banned-users' && typeof loadBannedUsers === 'function') {
            loadBannedUsers();
        } else if (tabName === 'appeals' && typeof loadAppeals === 'function') {
            loadAppeals();
        }
    }
    tabButtons.forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            let tabName = btn.dataset.tab;
            if (!tabName && e.target) tabName = e.target.dataset.tab;
            if (tabName) activateTab(tabName);
        });
    });
    // Activate first tab on load
    if (tabButtons.length > 0) activateTab(tabButtons[0].dataset.tab);
});

// Dropdown logic
function toggleUserDropdown() {
    const menu = document.getElementById('userDropdownMenu');
    const trigger = document.querySelector('.user-dropdown-trigger');
    if (menu && trigger) {
        menu.classList.toggle('show');
        trigger.classList.toggle('active');
    }
}
document.addEventListener('click', function(event) {
    const dropdown = document.querySelector('.user-dropdown');
    if (dropdown && !dropdown.contains(event.target)) {
        const menu = document.getElementById('userDropdownMenu');
        const trigger = document.querySelector('.user-dropdown-trigger');
        if (menu) menu.classList.remove('show');
        if (trigger) trigger.classList.remove('active');
    }
});
function syncDropdownInfo() {
    const username = document.getElementById('headerUsername')?.textContent;
    const role = document.getElementById('headerRole')?.textContent;
    if (username && document.getElementById('dropdownUsername')) {
        document.getElementById('dropdownUsername').textContent = username;
    }
    if (role && document.getElementById('dropdownRole')) {
        document.getElementById('dropdownRole').textContent = role;
    }
}
setTimeout(syncDropdownInfo, 500);

// This unbanUser function is only for the banned users tab
// This function is just for unbanning people from the banned users list. If you click "Unban," this is what runs.
async function unbanUser(userId) {
    if (!confirm('Are you sure you want to unban this user?')) return;
    try {
        const response = await fetch(`/api/moderation/bans/${userId}`, { method: 'DELETE' });
        const data = await response.json();
        if (response.ok && data.success) {
            const caseIdMsg = data.caseId ? ` (Case ID: ${data.caseId})` : '';
            showSuccess(`User unbanned successfully${caseIdMsg}`);
            await loadBannedUsers();
        } else {
            showError(data.error || 'Failed to unban user');
            console.error('Error unbanning user:', data.error);
        }
    } catch (error) {
        showError('Error unbanning user');
    }
}

function viewBanDetails(ban) {
    let modal = document.getElementById('banDetailsModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'banDetailsModal';
        modal.className = 'modal';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="modal-content">
                <h3>Ban Details</h3>
                <button class="modal-close" onclick="closeBanDetails()">&times;</button>
                <div><label>User:</label> <div id="banDetailUser" class="form-input" style="background: var(--bg-secondary);"></div></div>
                <div><label>Ban Reason</label> <div id="banDetailReason" class="form-input" style="background: var(--bg-secondary);"></div></div>
                <div><label>Banned By</label> <div id="banDetailBannedBy" class="form-input" style="background: var(--bg-secondary);"></div></div>
                <div><label>Banned At</label> <div id="banDetailBannedAt" class="form-input" style="background: var(--bg-secondary);"></div></div>
                <div><label>Case ID</label> <div id="banDetailCaseId" class="form-input" style="background: var(--bg-secondary);"></div></div>
                <button class="btn btn-secondary" onclick="closeBanDetails()">Close</button>
            </div>
        `;
        document.body.appendChild(modal);
    }
    const userDisplay = ban.username ? `${ban.username} (${ban.user_id})` : ban.user_id || 'N/A';
    const bannedByDisplay = ban.banned_by_username ? `${ban.banned_by_username} (${ban.banned_by})` : ban.banned_by || 'Unknown';
    document.getElementById('banDetailUser').textContent = userDisplay;
    document.getElementById('banDetailReason').textContent = ban.ban_reason || ban.reason || 'No reason provided';
    document.getElementById('banDetailBannedBy').textContent = bannedByDisplay;
    document.getElementById('banDetailBannedAt').textContent = ban.banned_at ? new Date(ban.banned_at).toLocaleString() : 'N/A';
    document.getElementById('banDetailCaseId').textContent = ban.ban_case_id || 'N/A';
    modal.style.display = 'flex';
}

function closeBanDetails() {
    const modal = document.getElementById('banDetailsModal');
    if (modal) modal.style.display = 'none';
}
// This just opens or closes the user dropdown menu when you click the trigger.
function toggleUserDropdown() {
    const menu = document.getElementById('userDropdownMenu');
    const trigger = document.querySelector('.user-dropdown-trigger');
    if (menu && trigger) {
        menu.classList.toggle('show');
        trigger.classList.toggle('active');
    }
}
document.addEventListener('click', function(event) {
    const dropdown = document.querySelector('.user-dropdown');
    if (dropdown && !dropdown.contains(event.target)) {
        const menu = document.getElementById('userDropdownMenu');
        const trigger = document.querySelector('.user-dropdown-trigger');
        if (menu) menu.classList.remove('show');
        if (trigger) trigger.classList.remove('active');
    }
});
function syncDropdownInfo() {
    const username = document.getElementById('headerUsername')?.textContent;
    const role = document.getElementById('headerRole')?.textContent;
    if (username && document.getElementById('dropdownUsername')) {
        document.getElementById('dropdownUsername').textContent = username;
    }
    if (role && document.getElementById('dropdownRole')) {
        document.getElementById('dropdownRole').textContent = role;
    }
}
setTimeout(syncDropdownInfo, 500);

// Handles the dark theme for the admin panel. Because who doesn't love dark mode?
// All the main stuff for the admin dashboard lives here.
// Note to self: This file is getting big. Should break it up into smaller pieces someday.

if (!window.api || !window.ui) {
    const { api, ui } = window.AdminPanel || {};
    window.api = api;
    window.ui = ui;
}
document.addEventListener('DOMContentLoaded', async () => {
    // If we're on the login page, just run the login handler and skip the rest.
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value;
            const errorDiv = document.getElementById('error-message');

            // Clear out any old error messages so we don't confuse people.
            errorDiv.style.display = 'none';
            errorDiv.textContent = '';

            // Double check that the user actually typed in both fields.
            if (!username || !password) {
                errorDiv.textContent = 'Please enter both username and password.';
                errorDiv.style.display = 'block';
                return;
            }

            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });

                if (response.ok) {
                    // Login worked! Go to the dashboard
                    window.location.href = '/admin';
                } else {
                    const data = await response.json().catch(() => ({}));
                    errorDiv.textContent = data.error || data.message || 'Login failed. Please try again.';
                    errorDiv.style.display = 'block';
                }
            } catch (err) {
                errorDiv.textContent = 'Network error. Please try again.';
                errorDiv.style.display = 'block';
            }
        });
    }

    // Grab all the info about the admin's account so we can show their details on the dashboard.
    if (window.api && typeof window.api.getAccountInfo === 'function') {
        try {
            const accountInfo = await window.api.getAccountInfo();
            if (accountInfo && typeof accountInfo === 'object') {
                // For example, update the header, show their role, username, etc. Make it feel personal!
                if (document.getElementById('headerUsername')) document.getElementById('headerUsername').textContent = accountInfo.username || 'User';
                if (document.getElementById('headerRole')) document.getElementById('headerRole').textContent = (accountInfo.role || 'User').toUpperCase();
                if (document.getElementById('userDisplay')) document.getElementById('userDisplay').textContent = accountInfo.username || 'User';
                if (document.getElementById('roleBadge')) document.getElementById('roleBadge').textContent = (accountInfo.role || 'User').toUpperCase();
                if (document.getElementById('dropdownUsername')) document.getElementById('dropdownUsername').textContent = accountInfo.username || 'User';
                if (document.getElementById('dropdownRole')) document.getElementById('dropdownRole').textContent = (accountInfo.role || 'User').toUpperCase();
                window.api.applyRoleVisibility && window.api.applyRoleVisibility(accountInfo);
            } else {
                console.error('Account info missing or invalid:', accountInfo);
            }
        } catch (error) {
            console.error('Failed to load account info:', error);
        }
        return; // If we're on the login page, skip the admin panel stuff.
    }
    // Now for the real admin panel logic—only runs if you're logged in.
    runAdminPanel();
});

async function runAdminPanel() {
    const accountInfo = await checkAdminAccess();
    // Only connect to socket.io if we know who you are and you have the right role.
    if (typeof io !== 'undefined' && accountInfo && accountInfo.username && accountInfo.role) {
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
    } else {
        window.location.href = '/unauthorized';
        return;
    }
    // Attach tab event listeners
    document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', function(e) {
            // Always use the button itself for tabName, not the child span or icon
            let tabName = btn.dataset.tab;
            // If the click target is a child element, fallback to the button's dataset
            if (!tabName && e.target) {
                tabName = e.target.dataset.tab;
            }
            if (tabName) {
                switchTab(e, tabName, btn);
            }
        });
    });
    await loadServerStats();
    await loadLevelDistribution();
    await loadRecentModerationActions();
}

async function checkAdminAccess() {
    try {
        const data = await api.getAccountInfo();
        if (!data) {
            window.location.href = '/login';
            return;
        }
        if (data.role !== 'admin' && data.role !== 'owner') {
            window.location.href = '/dashboard';
            return;
        }

        const username = data.username || 'Admin';
        const role = (data.role || 'admin').toUpperCase();
        ui?.setText('userDisplay', username);
        ui?.setText('roleBadge', role);

        document.addEventListener('click', function(event) {
            const dropdown = document.querySelector('.user-dropdown');
            if (dropdown && !dropdown.contains(event.target)) {
                const menu = document.getElementById('userDropdownMenu');
                const trigger = document.querySelector('.user-dropdown-trigger');
                if (menu) menu.classList.remove('show');
                if (trigger) trigger.classList.remove('active');
            }
        });

        function syncDropdownInfo() {
            const username = document.getElementById('headerUsername')?.textContent;
            const role = document.getElementById('headerRole')?.textContent;
            if (username && document.getElementById('dropdownUsername')) {
                document.getElementById('dropdownUsername').textContent = username;
            }
            if (role && document.getElementById('dropdownRole')) {
                document.getElementById('dropdownRole').textContent = role;
            }
        }
        setTimeout(syncDropdownInfo, 500);
        api?.applyRoleVisibility(data, { moderatorLinkId: 'moderatorLink', ownerNavLinkId: 'ownerNavLink', adminLinkId: null, ownerLinkId: null });
    } catch (error) {
        window.location.href = '/login';
    }
}


function switchTab(e, tabName, tabButton) {
    e.preventDefault();

    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });

    // Remove active from all tab buttons
    document.querySelectorAll('.tab').forEach(btn => {
        btn.classList.remove('active');
    });

    // Show the selected tab content
    const selectedTab = document.getElementById(tabName);
    if (selectedTab) {
        selectedTab.classList.add('active');
    }

    // Activate the clicked tab button
    // Always activate the button, not the child element
    if (tabButton) {
        tabButton.classList.add('active');
    }

    // Load up the info for whichever tab is open
    if (tabName === 'banned-users' && typeof loadBannedUsers === 'function') {
        loadBannedUsers();
    } else if (tabName === 'appeals' && typeof loadAppeals === 'function') {
        loadAppeals();
    }
    // For member-management, no data load by default
}





async function loadLevelDistribution() {
    const tableBody = document.getElementById('levelDistributionTable');
    if (!tableBody) return;

    try {
        const response = await fetch('/api/server/level-distribution');
        if (!response.ok) return;

        const data = await response.json();
        const ranges = Array.isArray(data.ranges) ? data.ranges : [];

        if (ranges.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">No level data available</td></tr>';
            return;
        }

        tableBody.innerHTML = ranges.map(range => {
            const percentage = (range.percentage || 0).toFixed(1);
            return `
                <tr>
                    <td>${escapeHtml(`Level ${range.label}`)}</td>
                    <td>${(range.count || 0).toLocaleString()}</td>
                    <td>${percentage}%</td>
                </tr>
            `;
        }).join('');

        levelDistributionData = {
            labels: ranges.map(r => `Level ${r.label}`),
            values: ranges.map(r => r.count || 0)
        };

        if (levelChart) {
            levelChart.data.labels = levelDistributionData.labels;
            levelChart.data.datasets[0].data = levelDistributionData.values;
            levelChart.update();
        }
    } catch (error) {
        console.error('Error loading level distribution:', error);
    }
}

async function loadInvites() {
    try {
        const response = await fetch('/api/invites/list');
        if (response.ok) {
            const data = await response.json();
            let html = '<table><thead><tr><th>Code</th><th>Role</th><th>Expires At</th><th>Used By</th><th>Action</th></tr></thead><tbody>';
            
            if (data.invites && data.invites.length > 0) {
                data.invites.forEach(invite => {
                    const escapeHtml = (text) => {
                        if (text === null || text === undefined) return '';
                        const map = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'};
                        return String(text).replace(/[&<>"']/g, m => map[m]);
                    };
                    const expiryDate = new Date(invite.expiresAt).toLocaleDateString();
                    const roleColor = invite.role === 'admin' ? 'var(--color-red)' : 'var(--color-blue)';
                    html += `<tr>
                        <td><code style="background: var(--bg-secondary); padding: 0.25rem 0.5rem; border-radius: 4px;">${escapeHtml(invite.code)}</code></td>
                        <td><span style="color: ${roleColor}; font-weight: 600;">${escapeHtml(invite.role)}</span></td>
                        <td>${expiryDate}</td>
                        <td>${invite.usedBy ? `@${escapeHtml(invite.usedBy)}` : '<span class="text-muted">Not used</span>'}</td>
                        <td><button class="btn btn-danger" onclick="revokeInvite('${escapeHtml(invite.code)}')" style="padding: 0.5rem 1rem; font-size: 0.875rem;">Revoke</button></td>
                    </tr>`;
                });
            } else {
                html += '<tr><td colspan="5" class="text-center text-muted">No active invites</td></tr>';
            }
            
            html += '</tbody></table>';
            document.getElementById('invitesContainer').innerHTML = html;
        }
    } catch (error) {
        console.error('Error loading invites:', error);
    }
}

async function loadInviteStats() {
    try {
        const response = await fetch('/api/invites/stats');
        if (!response.ok) return;

        const payload = await response.json();
        const stats = Array.isArray(payload) ? payload : (payload.data || []);
        const table = document.getElementById('inviteStatsTable');
        if (!table) return;

        if (!Array.isArray(stats) || stats.length === 0) {
            table.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No invite stats available</td></tr>';
            return;
        }

        table.innerHTML = stats.map(stat => {
            const created = stat.created_at ? new Date(stat.created_at).toLocaleDateString() : 'N/A';
            const expires = stat.expires_at ? new Date(stat.expires_at).toLocaleDateString() : 'N/A';
            return `
                <tr>
                    <td><code>${escapeHtml(stat.code || '')}</code></td>
                    <td>${escapeHtml(stat.created_by || 'System')}</td>
                    <td>${escapeHtml(stat.role || 'moderator')}</td>
                    <td>${stat.used_by ? `@${escapeHtml(stat.used_by)}` : '<span class="text-muted">Not used</span>'}</td>
                    <td>${created}</td>
                    <td>${expires}</td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('Error loading invite stats:', error);
    }
}

async function loadServerStats() {
    try {
        const response = await fetch('/api/server/stats');
        if (!response.ok) {
            console.error('Server stats response not OK:', response.status);
            return;
        }

        const data = await response.json();
        
        const totalMembers = Number(data.totalMembers ?? data.totalUsers ?? 0) || 0;
        const membersThisMonth = Number(data.membersThisMonth ?? 0) || 0;
        const totalWarns = Number(data.totalWarns ?? data.totalWarnings ?? 0) || 0;
        const activeBans = Number(data.activeBans ?? data.bannedUsers ?? 0) || 0;
        const activeTimeouts = Number(data.activeTimeouts ?? 0) || 0;
        const activeGiveaways = Number(data.activeGiveaways ?? 0) || 0;

        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = value;
            }
        };

        setText('serverTotalMembers', totalMembers.toLocaleString());
        setText('serverMembersThisMonth', membersThisMonth.toLocaleString());
        setText('serverTotalWarns', totalWarns.toLocaleString());
        setText('serverActiveBans', activeBans.toLocaleString());
        setText('serverActiveTimeouts', activeTimeouts.toLocaleString());
        setText('serverActiveGiveaways', activeGiveaways.toLocaleString());
    } catch (error) {
        console.error('Error loading server stats:', error);
    }
}

async function generateInvite() {
    const role = document.getElementById('inviteRole').value;
    const expiresInDays = parseInt(document.getElementById('inviteExpiry').value) || 7;
    
    try {
        const response = await fetch('/api/invites/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role, expiresInDays })
        });
        
        if (response.ok) {
            const data = await response.json();
            document.getElementById('inviteResult').innerHTML = `
                <div class="message success" style="margin-top: 1.5rem;">
                    <div>
                        <strong>Invite Code Generated!</strong><br>
                        Code: <code style="background: var(--bg-secondary); padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 1.1rem;">${data.code}</code><br>
                        Role: <strong>${data.role}</strong><br>
                        Expires: ${new Date(data.expiresAt).toLocaleDateString()}
                    </div>
                </div>
            `;
            await loadInvites();
        } else {
            showError('Failed to generate invite code');
        }
    } catch (error) {
        console.error('Error generating invite:', error);
        showError('Error generating invite code');
    }
}

async function revokeInvite(code) {
    if (!confirm('Are you sure you want to revoke this invite code?')) return;
    
    try {
        const response = await fetch(`/api/invites/revoke/${code}`, { method: 'POST' });
        if (response.ok) {
            showSuccess('Invite code revoked');
            await loadInvites();
        }
    } catch (error) {
        console.error('Error revoking invite:', error);
        showError('Error revoking invite code');
    }
}

async function loadRecentModerationActions() {
    try {
        const response = await fetch('/api/moderation/recent-actions');
        if (response.ok) {
            const data = await response.json();
            const tbody = document.getElementById('recentActionsTable');
            if (!tbody) return;
            
            // API returns an array directly
            const actions = Array.isArray(data) ? data : [];
            
            if (actions.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No recent actions</td></tr>';
                return;
            }
            
            tbody.innerHTML = actions.map(action => {
                const timestamp = new Date(action.timestamp).toLocaleString();
                const actionEmoji = action.action === 'WARN' ? '⚠️' : action.action === 'BAN' ? '🚫' : action.action === 'TIMEOUT' ? '⏱️' : '📋';
                const userId = action.userId || '';
                const username = action.username || 'Unknown';
                const userDisplay = userId ? `${username} (${userId})` : username;

                const moderatorId = action.moderatorId || '';
                const moderatorName = action.moderatorName || 'System';
                const moderatorSource = action.moderatorSource || 'discord';
                // Always show username (id) if both are present
                const moderatorDisplay = moderatorName && moderatorId
                    ? `${moderatorName} (${moderatorId})`
                    : moderatorName || moderatorId;
                const reason = action.reason || 'No reason provided';
                
                return `
                    <tr>
                        <td>${timestamp}</td>
                        <td><strong>${actionEmoji} ${action.action}</strong></td>
                        <td>${userDisplay}</td>
                        <td>${moderatorDisplay}</td>
                        <td>${reason}</td>
                    </tr>
                `;
            }).join('');
        }
    } catch (error) {
        console.error('Error loading recent moderation actions:', error);
    }
}

// Load appeals and render table
async function loadAppeals() {
    try {
        const response = await fetch('/api/appeals/pending');
        if (!response.ok) throw new Error('Failed to load appeals');
        const appeals = await response.json();
        const table = document.getElementById('appealsTable');
        if (!table) return;
        if (!Array.isArray(appeals) || appeals.length === 0) {
            table.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No appeals found</td></tr>';
            return;
        }
        table.innerHTML = appeals.map(appeal => {
            const status = typeof appeal.status === 'string' && appeal.status.length > 0 ? appeal.status : 'pending';
            let statusColor;
            if (status === 'pending') statusColor = 'var(--color-yellow)';
            else if (status === 'accepted') statusColor = 'var(--color-green)';
            else if (status === 'denied') statusColor = 'var(--color-red)';
            else statusColor = 'gray';
            const statusText = status.charAt(0).toUpperCase() + status.slice(1);
            return `
                <tr>
                    <td><strong>${appeal.user_tag || appeal.user_id}</strong></td>
                    <td><code>${appeal.ban_case_id || 'N/A'}</code></td>
                    <td>${appeal.reason || 'No reason provided'}</td>
                    <td>${new Date(appeal.created_at).toLocaleDateString()}</td>
                    <td><span style="background: ${statusColor}; color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem; font-weight: 600;">${statusText}</span></td>
                    <td style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
                        <button class="btn btn-sm btn-success" onclick="acceptAppeal(${appeal.id}, '${appeal.user_tag}')">✅ Accept</button>
                        <button class="btn btn-sm btn-danger" onclick="denyAppeal(${appeal.id}, '${appeal.user_tag}')">❌ Deny</button>
                        <button class="btn btn-sm btn-primary" onclick="viewAppealDetails(${appeal.id}, '${appeal.user_tag}', '${appeal.ban_case_id || 'N/A'}')">👁️ View</button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('Error loading appeals:', error);
        const table = document.getElementById('appealsTable');
        if (table) table.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Failed to load appeals</td></tr>';
    }
}

// Load appeals when tab is activated


async function loadAppealStats() {
    try {
        const response = await fetch('/api/appeals/stats');
        if (!response.ok) return;
        const stats = await response.json();
        document.getElementById('adminPendingAppealsCount').textContent = stats.pending || 0;
        document.getElementById('adminAcceptedAppealsCount').textContent = stats.accepted || 0;
        document.getElementById('adminDeniedAppealsCount').textContent = stats.denied || 0;
    } catch (error) {
        console.error('Error loading appeal stats:', error);
    }
}

async function acceptAppeal(appealId, username) {
    const response = await modalManager?.showConfirm(
        'Accept Appeal',
        `Accept the appeal from ${username}?`,
        'Accept',
        'Cancel'
    ) || confirm(`Accept the appeal from ${username}?`);
    
    if (!response) return;

    try {
        const result = await fetch(`/api/appeals/${appealId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'accepted' })
        });

        if (result.ok) {
            modalManager?.showDetails('Success', 'Appeal accepted!') || alert('Appeal accepted!');
            await loadAppeals();
        } else {
            modalManager?.toast('Failed to accept appeal', 'error') || alert('Failed to accept appeal');
        }
    } catch (error) {
        console.error('Error accepting appeal:', error);
        modalManager?.toast('Error accepting appeal', 'error') || alert('Error accepting appeal');
    }
}

async function denyAppeal(appealId, username) {
    const reasonInput = prompt(`Deny appeal from ${username}? Enter denial reason (optional):`);
    if (reasonInput === null) return; // User cancelled

    try {
        const result = await fetch(`/api/appeals/${appealId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                status: 'denied',
                owner_response: reasonInput || 'Appeal denied'
            })
        });

        if (result.ok) {
            modalManager?.showDetails('Success', 'Appeal denied!') || alert('Appeal denied!');
            await loadAppeals();
        } else {
            modalManager?.toast('Failed to deny appeal', 'error') || alert('Failed to deny appeal');
        }
    } catch (error) {
        console.error('Error denying appeal:', error);
        modalManager?.toast('Error denying appeal', 'error') || alert('Error denying appeal');
    }
}

async function lookupUserDetails() {
    const userId = document.getElementById('userLookupInput').value.trim();
    if (!userId) {
        showError('Please enter a Discord User ID');
        return;
    }
    
    try {
        const response = await fetch(`/api/users/${encodeURIComponent(userId)}`);
        if (!response.ok) {
            showError('User not found');
            return;
        }
        
        const user = await response.json();
        const panel = document.getElementById('userDetailsPanel');
        const isBanned = !!user.is_banned;
        const isTimedOut = !!user.is_timed_out;
        const banButton = document.getElementById('banButton');
        const unbanButton = document.getElementById('unbanButton');
        const timeoutButton = document.getElementById('timeoutButton');
        const untimeoutButton = document.getElementById('untimeoutButton');

        // Ban/Unban button logic
        banButton.style.display = isBanned ? 'none' : '';
        unbanButton.style.display = isBanned ? '' : 'none';
        // Timeout/Untimeout button logic
        timeoutButton.style.display = isTimedOut ? 'none' : '';
        untimeoutButton.style.display = isTimedOut ? '' : 'none';

        // Calculate account age
        let ageText = 'Unknown';
        if (user.joined_at) {
            const joinedDate = new Date(user.joined_at);
            const now = new Date();
            const ageMs = now - joinedDate;
            const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
            ageText = ageDays > 0 ? `${ageDays} days` : 'Less than 1 day';
        }

        // Update all detail fields safely using API response
        const setText = (id, value, html = false) => {
            const el = document.getElementById(id);
            if (el) {
                if (html) el.innerHTML = value;
                else el.textContent = value;
            }
        };
        setText('detailUsername', user.username ?? 'Unknown');
        setText('detailNickname', user.nickname ?? 'N/A');
        setText('detailUserId', user.user_id ?? 'N/A');
        function formatDate(dateStr) {
            if (!dateStr) return 'Unknown';
            const date = new Date(dateStr);
            return isNaN(date.getTime()) ? 'Unknown' : date.toLocaleDateString();
        }
        setText('detailJoinedAt', formatDate(user.joined_at));
        setText('detailCreatedAt', formatDate(user.created_at));
        setText('detailAccountAge', ageText);
        setText('detailBio', user.bio ?? 'N/A');

        setText('detailLevel', `<span style="background: var(--accent-primary); color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem; font-size: 1rem; margin-left:0;">${user.level ?? 0}</span>`, true);
        setText('detailXP', (user.xp ?? 0).toLocaleString());
        setText('detailWarnings', `<span style="background: #4CAF50; color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem; font-weight: 600;">${user.warnings ?? 0} Warnings</span>`, true);
        setText('detailBanStatus', `<span style="background: ${isBanned ? '#ff6b6b' : '#4CAF50'}; color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem;">${isBanned ? '🔴 Banned' : '✅ Not Banned'}</span>`, true);
        setText('detailBanReason', user.ban_reason ?? (isBanned ? 'No reason provided' : 'N/A'));
        setText('detailBanDate', user.ban_date ? new Date(user.ban_date).toLocaleDateString() : (isBanned ? 'Unknown' : 'N/A'));
        setText('detailTimedOut', isTimedOut ? 'Yes' : 'No');
        setText('detailTimeoutReason', isTimedOut ? (user.timeout_reason ?? 'N/A') : 'N/A');
        setText('detailTimeoutExpires', isTimedOut ? (user.timeout_expires ? new Date(user.timeout_expires).toLocaleString() : 'N/A') : 'N/A');
        if (document.getElementById('detailTimeoutStatus')) {
            setText('detailTimeoutStatus', isTimedOut ? `<span style="background: #FF9800; color: white; padding: 0.25rem 0.75rem; border-radius: 0.25rem;">⏳ Timed Out</span>` : 'N/A', true);
        }

        setText('detailStatus', user.status ?? 'N/A');
        setText('detailFlags', user.flags ?? 'N/A');
        setText('detailMessages', (user.messages ?? 0).toLocaleString() + ' messages');

        // Store current user ID for actions
        window.currentUserLookup = user.user_id;
        window.currentUserIsBanned = isBanned;

        // Show the panel
        panel.style.display = 'block';
    } catch (error) {
        console.error('Error looking up user:', error);
        showError('Error looking up user');
    }
}

function promptBanUser() {
    if (!window.currentUserLookup) {
        showError('Please lookup a user first');
        return;
    }
    
    const reason = prompt('Ban reason:');
    if (reason !== null) {
        banUser(window.currentUserLookup, reason);
    }
}

function promptUnbanUser() {
    if (!window.currentUserLookup) {
        showError('Please lookup a user first');
        return;
    }
    
    if (confirm('Are you sure you want to unban this user?')) {
        unbanUser(window.currentUserLookup);
    }
}

function promptWarnUser() {
    if (!window.currentUserLookup) {
        showError('Please lookup a user first');
        return;
    }
    
    const reason = prompt('Warning reason:');
    if (reason !== null) {
        warnUser(window.currentUserLookup, reason);
    }
}

async function banUser(userId, reason) {
    try {
        const response = await fetch('/api/warn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, reason: `(ban) ${reason}` })
        });
        
        if (response.ok) {
            showSuccess('User banned successfully');
            // Refresh the lookup
            await lookupUserDetails();
        } else {
            showError('Failed to ban user');
        }
    } catch (error) {
        console.error('Error banning user:', error);
        showError('Error banning user');
    }
}

// (Removed duplicate unbanUser for user lookup)

async function warnUser(userId, reason) {
    try {
        const response = await fetch('/api/warn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, reason })
        });
        
        if (response.ok) {
            showSuccess('User warned successfully');
            // Refresh the lookup
            await lookupUserDetails();
        } else {
            showError('Failed to warn user');
        }
    } catch (error) {
        console.error('Error warning user:', error);
        showError('Error warning user');
    }
}

function viewAppealDetails(appealId, username, banCaseId) {
    if (modalManager) {
        modalManager.showDetails('Appeal Details', `
            <div style="text-align: left;">
                <p><strong>Username:</strong> ${username}</p>
                <p><strong>Ban Case ID:</strong> <code>${banCaseId}</code></p>
                <p><strong>Appeal ID:</strong> ${appealId}</p>
            </div>
        `);
    } else {
        alert(`Appeal Details:\nUsername: ${username}\nBan Case ID: ${banCaseId}\nAppeal ID: ${appealId}`);
    }
}

// Warn user from search results
async function warnUserFromSearch(userId, username) {
    const reason = prompt(`Enter warning reason for ${username}:`);
    if (!reason) return;

    try {
        const response = await fetch('/api/admin/warn-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, reason })
        });

        const data = await response.json();
        // ...existing code...
        if (response.ok) {
            showSuccess(`User warned successfully. Case ID: ${data.caseId}`);
            await searchUsers(); // Refresh the search results
        } else {
            showError(data.error || 'Failed to warn user');
        }
    } catch (error) {
        showError('Error warning user');
        console.error('Warn error:', error);
    }
}

// Ban user from search results
async function banUserFromSearch(userId, username) {
    const reason = prompt(`Enter ban reason for ${username}:`);
    if (!reason) return;

    if (!confirm(`Are you sure you want to ban ${username}?`)) return;

    try {
        const response = await fetch('/api/admin/ban-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, reason })
        });

        const data = await response.json();
        if (response.ok) {
            showSuccess(`User banned successfully. Case ID: ${data.caseId}`);
            await searchUsers(); // Refresh the search results
        } else {
            showError(data.error || 'Failed to ban user');
        }
    } catch (error) {
        showError('Error banning user');
        console.error(error);
    }
}

// Timeout user from search results
async function timeoutUserFromSearch(userId, username) {
    const durationStr = prompt(`Enter timeout duration for ${username} (e.g., "10m", "1h", "7d"):`);
    if (!durationStr) return;

    const reason = prompt(`Enter timeout reason for ${username}:`);
    if (!reason) return;

    if (!confirm(`Are you sure you want to timeout ${username}?`)) return;

    try {
        const response = await fetch('/api/admin/timeout-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, duration: durationStr, reason })
        });

        const data = await response.json();
        if (response.ok) {
            showSuccess(`User timed out successfully. Case ID: ${data.caseId}`);
            await searchUsers(); // Refresh the search results
        } else {
            showError(data.error || 'Failed to timeout user');
        }
    } catch (error) {
        showError('Error timing out user');
        console.error(error);
    }
}

// Remove timeout from user in search results
async function removeTimeoutFromSearch(userId, username) {
    if (!confirm(`Are you sure you want to remove the timeout for ${username}?`)) return;

    try {
        const response = await fetch('/api/admin/remove-timeout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId })
        });

        const data = await response.json();
        if (response.ok) {
            showSuccess(`Timeout removed from ${username}`);
            await searchUsers(); // Refresh the search results
        } else {
            showError(data.error || 'Failed to remove timeout');
        }
    } catch (error) {
        showError('Error removing timeout');
        console.error(error);
    }
}

function promptTimeoutUser() {
    if (!window.currentUserLookup) {
        showError('Please lookup a user first');
        return;
    }
    const durationStr = prompt('Enter timeout duration (e.g., "10m", "1h", "7d")');
    if (!durationStr) return;
    const reason = prompt('Timeout reason:');
    if (reason !== null) {
        timeoutUser(window.currentUserLookup, durationStr, reason);
    }
}

function promptUntimeoutUser() {
    if (!window.currentUserLookup) {
        showError('Please lookup a user first');
        return;
    }
    if (confirm('Remove timeout for this user?')) {
        removeTimeout(window.currentUserLookup);
    }
}

async function timeoutUser(userId, duration, reason) {
    try {
        const response = await fetch('/api/admin/timeout-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, duration, reason })
        });
        const data = await response.json();
        if (response.ok) {
            showSuccess('User timed out successfully');
            await lookupUserDetails();
        } else {
            showError(data.error || 'Failed to timeout user');
        }
    } catch (error) {
        showError('Error timing out user');
        console.error(error);
    }
}

async function removeTimeout(userId) {
    try {
        const response = await fetch('/api/admin/remove-timeout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId })
        });
        const data = await response.json();
        if (response.ok) {
            showSuccess('Timeout removed');
            await lookupUserDetails();
        } else {
            showError(data.error || 'Failed to remove timeout');
        }
    } catch (error) {
        showError('Error removing timeout');
        console.error(error);
    }
}