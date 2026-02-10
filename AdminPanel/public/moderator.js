// This function lets you open and close the user dropdown menu. Makes navigation easier for moderators.
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

// Keep the dropdown username and role in sync with the header so everything matches.
function syncDropdownInfo() {
    const username = document.getElementById('headerUsername')?.textContent;
    const role = document.getElementById('headerRole')?.textContent;
    if (username) document.getElementById('dropdownUsername').textContent = username;
    if (role) document.getElementById('dropdownRole').textContent = role;
}
setTimeout(syncDropdownInfo, 500);

// Search and filter moderation actions in the History Lookup tab. Makes finding actions quick and easy.
function searchActions() {
    const query = document.getElementById('actionSearchInput')?.value?.trim() || '';
    // TODO: Add search/filter logic for moderation actions so mods can find what they need.
    // console.log removed for production
    // You can add AJAX/fetch logic here to update the actions table
}
// This is the main script for the moderator panel. It handles tickets, bans, warnings, and member info.
// TODO: Add bulk action support for warnings so mods can handle lots of cases at once.

// Set up all tabs and load data when the page loads
document.addEventListener('DOMContentLoaded', async () => {
    let accountInfo;
    try {
        accountInfo = await checkModeratorAccess();
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
            console.error('Moderator account info missing or invalid:', accountInfo);
            window.location.href = '/unauthorized';
            return;
        }
    } catch (error) {
        console.error('Failed to load moderator account info:', error);
        window.location.href = '/unauthorized';
        return;
    }
    await loadOverviewStats();
    await loadRecentActions();
    
    // Attach tab event listeners
    document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabName = e.target.dataset.tab;
            if (tabName) {
                switchTab(e, tabName);
            }
        });
    });
    // Load bans and timeouts on page load
    await loadBannedUsers();
    await loadTimeouts();
});

async function checkModeratorAccess() {
    try {
        const response = await fetch('/api/account/info');
        if (response.ok) {
            const data = await response.json();
            if (!data.username || !data.role || (data.role !== 'moderator' && data.role !== 'admin' && data.role !== 'owner')) {
                window.location.href = '/unauthorized';
                return null;
            }
            // Update user display
            const userDisplay = document.getElementById('userDisplay');
            const roleBadge = document.getElementById('roleBadge');
            const username = data.username;
            const role = data.role.toUpperCase();
            if (userDisplay) userDisplay.textContent = username;
            if (roleBadge) roleBadge.textContent = role;
            // console.log removed for production
            // Update navigation based on role
            const moderatorLink = document.getElementById('moderatorLink');
            const adminLink = document.getElementById('adminLink');
            const ownerNavLink = document.getElementById('ownerNavLink');
            if (moderatorLink) {
                moderatorLink.style.display = (data.role === 'moderator' || data.role === 'admin' || data.role === 'owner') ? 'block' : 'none';
            }
            if (adminLink) {
                adminLink.style.display = (data.role === 'admin' || data.role === 'owner') ? 'block' : 'none';
            }
            if (ownerNavLink) {
                ownerNavLink.style.display = (data.role === 'owner') ? 'block' : 'none';
            }
            return data;
        } else {
            window.location.href = '/unauthorized';
            return null;
        }
    } catch (error) {
        console.error('Access check failed:', error);
        window.location.href = '/login';
    }
}

function switchTab(e, tabName) {
    e.preventDefault();
    
    // Hide everything first
    document.querySelectorAll('.tab-content').forEach(tab => {
        if (tab && tab.classList) {
            tab.classList.remove('active');
        }
    });
    
    // Deactivate all tab buttons
    document.querySelectorAll('.tab').forEach(btn => {
        if (btn && btn.classList) {
            btn.classList.remove('active');
        }
    });
    
    // Show the one they clicked on
    const selectedTab = document.getElementById(tabName);
    if (selectedTab && selectedTab.classList) {
        selectedTab.classList.add('active');
    }
    if (e.target && e.target.classList) {
        e.target.classList.add('active');
    }
    
    // Load data for whichever tab they're viewing
    if (tabName === 'bansTab') {
        loadBannedUsers();
        loadTimeouts();
    } else if (tabName === 'ticketsTab') {
        // No filterTickets, just show tickets if needed
    } else if (tabName === 'warningsTab') {
        // Warning search happens when user types
    } else if (tabName === 'membersTab') {
        // Same with member search
    }
}

//  OVERVIEW TAB 

async function loadOverviewStats() {
    try {
        const response = await fetch('/api/moderation/overview');
        if (response.ok) {
            const data = await response.json();

            document.getElementById('todayWarns').textContent = data.warnsToday ?? '0';
            document.getElementById('todayBans').textContent = data.bansToday ?? '0';
            document.getElementById('activeTimeouts').textContent = data.activeTimeouts ?? '0';
            document.getElementById('openTickets').textContent = data.openTickets ?? '0';
        }
    } catch (error) {
        console.error('Error loading overview stats:', error);
    }
}

async function loadRecentActions() {
    try {
        const response = await fetch('/api/moderation/recent-actions?limit=10');
        if (response.ok) {
            const actions = await response.json();
            const tbody = document.getElementById('recentActionsTable');
            
            if (!Array.isArray(actions) || actions.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No recent actions</td></tr>';
                return;
            }
            
            tbody.innerHTML = actions.map(action => {
                const username = action.username || 'Unknown';
                const userId = action.userId || '';
                const isSameAsId = userId && username && username.trim() === userId.toString().trim();
                const userLabel = userId ? (isSameAsId ? `${userId}` : `${username} (${userId})`) : username;
                
                // Parse timestamp safely
                let dateStr = 'Invalid Date';
                if (action.timestamp) {
                    try {
                        const date = new Date(action.timestamp);
                        if (!isNaN(date.getTime())) {
                            dateStr = date.toLocaleString();
                        }
                    } catch (e) {
                        dateStr = 'Invalid Date';
                    }
                }
                
                return `
                <tr>
                    <td>${dateStr}</td>
                    <td><strong>${escapeHtml(action.action)}</strong></td>
                    <td>${escapeHtml(userLabel) || '-'}</td>
                    <td>${escapeHtml(action.reason) || '-'}</td>
                </tr>
            `;
            }).join('');
        }
    } catch (error) {
        console.error('Error loading recent actions:', error);
    }
}

// TICKETS TAB 

if (!window.currentTickets) {
    window.currentTickets = [];
}

function renderTickets(tickets) {
    const tbody = document.getElementById('ticketsTable');
    
    if (!Array.isArray(tickets) || tickets.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No tickets are currently open</td></tr>';
        return;
    }
    
    tbody.innerHTML = tickets.map(ticket => `
        <tr>
            <td>#${escapeHtml(ticket.id)}</td>
            <td>${escapeHtml(ticket.username)}</td>
            <td><span class="badge badge-${escapeHtml(ticket.status)}">${escapeHtml(ticket.status.toUpperCase())}</span></td>
            <td>${new Date(ticket.created_at).toLocaleDateString()}</td>
            <td>
                <button class="btn btn-sm btn-primary" onclick="viewTicket('${escapeHtml(ticket.id)}')">View</button>
            </td>
        </tr>
    `).join('');
}

async function viewTicket(ticketId) {
    const ticket = currentTickets.find(t => String(t.id) === String(ticketId));
    if (!ticket) {
        return showError('Ticket not found');
    }
    const created = ticket.created_at ? new Date(ticket.created_at).toLocaleString() : 'N/A';

    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    setText('ticketDetailId', ticket.id || 'N/A');
    setText('ticketDetailUser', ticket.username || 'Unknown');
    setText('ticketDetailStatus', ticket.status || 'open');
    setText('ticketDetailPriority', ticket.priority || 'medium');
    setText('ticketDetailCreated', created);
    setText('ticketDetailReason', ticket.reason || 'N/A');

    const modal = document.getElementById('ticketDetailsModal');
    if (modal) {
        modal.style.display = 'flex';
    }
}

function closeTicketDetails() {
    const modal = document.getElementById('ticketDetailsModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

async function claimTicket(ticketId) {
    try {
        const response = await fetch(`/api/tickets/${ticketId}/claim`, { method: 'POST' });
        if (response.ok) {
            showSuccess('Ticket claimed successfully');
            // Optionally reload tickets here if needed
        } else {
            showError('Failed to claim ticket');
        }
    } catch (error) {
        showError('Error claiming ticket');
    }
}

//  Bans/timeout tab

async function loadBannedUsers() {
    try {
        const response = await fetch('/api/moderation/bans');
        if (response.ok) {
            const json = await response.json();
            // Handle both data / raw array responses
            const bans = json.data || (Array.isArray(json) ? json : []);
            renderBannedUsers(bans);
        } else {
            renderBannedUsers([]);
        }
    } catch (error) {
        console.error('Error loading banned users:', error);
        renderBannedUsers([]);
    }
}

function renderBannedUsers(bans) {
    const tbody = document.getElementById('bannedUsersTable');
    
    if (!Array.isArray(bans) || bans.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No banned users</td></tr>';
        return;
    }
    
    tbody.innerHTML = bans.map((ban, idx) => {
        const bannedByDisplay = ban.banned_by_username ? `${ban.banned_by_username}` : ban.banned_by || 'Unknown';
        return `
        <tr>
            <td><code>${escapeHtml(ban.user_id)}</code></td>
            <td>${escapeHtml(ban.username)}</td>
            <td>${escapeHtml(ban.ban_reason) || 'No reason provided'}</td>
            <td>${escapeHtml(bannedByDisplay)}</td>
            <td>${new Date(ban.banned_at).toLocaleDateString()}</td>
            <td>
                <button class="btn btn-sm btn-primary" onclick="window.viewBanDetails_${idx}()">View</button>
                <button class="btn btn-sm btn-success" onclick="unbanUser('${escapeHtml(ban.user_id)}')">Unban</button>
            </td>
        </tr>
    `;
    }).join('');
    
    // Store ban data globally and attach click handlers
    bans.forEach((ban, idx) => {
        window[`viewBanDetails_${idx}`] = () => viewBanDetails(ban);
    });
}

async function loadTimeouts() {
    try {
        const response = await fetch('/api/moderation/timeouts');
        if (response.ok) {
            const json = await response.json();
            // Handle both data / raw array responses
            const timeouts = json.data || (Array.isArray(json) ? json : []);
            renderTimeouts(timeouts);
        } else {
            renderTimeouts([]);
        }
    } catch (error) {
        console.error('Error loading timeouts:', error);
        renderTimeouts([]);
    }
}

function renderTimeouts(timeouts) {
    const tbody = document.getElementById('timeoutsTable');
    
    if (!Array.isArray(timeouts) || timeouts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No active timeouts</td></tr>';
        return;
    }
    
    // Remove duplicate timeouts for same user, reason, and issued_by
    const uniqueTimeouts = [];
    const seen = new Set();
    for (const timeout of timeouts) {
        const key = `${timeout.user_id}|${timeout.reason}|${timeout.issued_by}`;
        if (!seen.has(key)) {
            uniqueTimeouts.push(timeout);
            seen.add(key);
        }
    }
    tbody.innerHTML = uniqueTimeouts.map(timeout => {
        const issuedByDisplay = timeout.issued_by_username ? `${timeout.issued_by_username}` : timeout.issued_by || 'Unknown';
        // Fix expiration date formatting if invalid
        let expiresDate = 'N/A';
        if (timeout.expires_at) {
            const expires = new Date(timeout.expires_at);
            expiresDate = isNaN(expires.getTime()) ? 'N/A' : expires.toLocaleString();
        }
        return `
        <tr>
            <td><code>${escapeHtml(timeout.user_id)}</code></td>
            <td>${escapeHtml(timeout.username)}</td>
            <td>${escapeHtml(timeout.reason) || 'No reason provided'}</td>
            <td>${escapeHtml(issuedByDisplay)}</td>
            <td>${expiresDate}</td>
            <td>
                <button class="btn btn-sm btn-primary" onclick='viewTimeoutDetails(${JSON.stringify(timeout)})'>View</button>
                <button class="btn btn-sm btn-success" onclick="removeTimeout('${escapeHtml(timeout.user_id)}')">Remove</button>
            </td>
        </tr>
    `;
    }).join('');
}

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
            console.error('Error unbanning user:', error);
        }
    } catch (error) {
        showError('Error unbanning user');
    }
}

async function removeTimeout(userId) {
    try {
        const response = await fetch(`/api/moderation/timeouts/${userId}`, { method: 'DELETE' });
        if (response.ok) {
            showSuccess('Timeout removed successfully');
            await loadTimeouts();
        } else {
            showError('Failed to remove timeout');
        }
    } catch (error) {
        showError('Error removing timeout');
    }
}

//  Warnings tab

async function searchWarnings() {
    const query = document.getElementById('warningSearchInput').value;
    if (!query) {
        return;
    }
    
    try {
        const response = await fetch(`/api/moderation/warnings/search?q=${encodeURIComponent(query)}`);
        if (response.ok) {
            const warnings = await response.json();
            renderWarnings(warnings);
        }
    } catch (error) {
        console.error('Error searching warnings:', error);
    }
}

function renderWarnings(warnings) {
    const tbody = document.getElementById('warningsTable');
    
    if (!Array.isArray(warnings) || warnings.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No warnings found</td></tr>';
        return;
    }
    
    tbody.innerHTML = warnings.map((warn, idx) => `
        <tr>
            <td><code>${escapeHtml(warn.userId)}</code></td>
            <td>${escapeHtml(warn.username || 'Unknown')}</td>
            <td><strong>${escapeHtml(warn.warnCount || 0)}</strong></td>
            <td><code>${escapeHtml(warn.warns && warn.warns[0] ? warn.warns[0].moderator_id : 'N/A')}</code></td>
            <td>${warn.warns && warn.warns[0] && warn.warns[0].created_at ? new Date(warn.warns[0].created_at).toLocaleDateString() : 'Never'}</td>
            <td><code>${escapeHtml(warn.warns && warn.warns[0] && warn.warns[0].case_id ? warn.warns[0].case_id : 'N/A')}</code></td>
            <td>
                <button class="btn btn-sm btn-primary" onclick="window.viewWarnings_${idx}()">Details</button>
                <button class="btn btn-sm btn-danger" onclick="clearWarnings('${escapeHtml(warn.userId)}')">Clear</button>
            </td>
        </tr>
    `).join('');
    
    // Store warning data globally and attach click handlers
    warnings.forEach((warn, idx) => {
        window[`viewWarnings_${idx}`] = () => viewWarningDetails(warn);
    });
}

async function clearWarnings(userId) {
    if (!confirm('Are you sure you want to clear all warnings for this user?')) return;
    
    try {
        const response = await fetch(`/api/moderation/warnings/${userId}`, { method: 'DELETE' });
        if (response.ok) {
            showSuccess('Warnings cleared successfully');
            await searchWarnings();
        } else {
            showError('Failed to clear warnings');
        }
    } catch (error) {
        showError('Error clearing warnings');
    }
}

function viewWarningDetails(warn) {
    const userDisplay = warn.username ? `${warn.username} (${warn.userId})` : warn.userId || 'N/A';
    document.getElementById('warningDetailUser').textContent = userDisplay;
    document.getElementById('warningDetailCount').textContent = warn.warnCount || 0;
    
    // Create detailed warning list
    if (warn.warns && Array.isArray(warn.warns) && warn.warns.length > 0) {
        const warningsList = warn.warns.map(w => {
            const actionType = (w.type || 'WARN').toUpperCase();
            return `
            <div style="padding: 0.5rem; border-bottom: 1px solid rgba(75, 85, 99, 0.2); margin-bottom: 0.5rem;">
                <div style="font-weight: 600; color: var(--text-primary);">${actionType}: ${escapeHtml(w.reason || 'No reason provided')}</div>
                <div style="font-size: 0.875rem; color: var(--text-secondary); margin-top: 0.25rem;">
                    <span>Case: ${escapeHtml(w.case_id || 'N/A')}</span> | 
                    <span>By: ${escapeHtml(w.moderator_id || 'Unknown')}</span> | 
                    <span>Date: ${w.created_at ? new Date(w.created_at).toLocaleDateString() : 'N/A'}</span>
                </div>
            </div>
        `;
        }).join('');
        const warningsList_elem = document.getElementById('warningDetailsList');
        if (warningsList_elem) warningsList_elem.innerHTML = warningsList;
    } else {
        const warningsList_elem = document.getElementById('warningDetailsList');
        if (warningsList_elem) warningsList_elem.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">No warnings found</p>';
    }
    
    const modal = document.getElementById('warningsDetailsModal');
    if (modal) modal.style.display = 'flex';
}

function closeWarningsDetails() {
    const modal = document.getElementById('warningsDetailsModal');
    if (modal) modal.style.display = 'none';
}

// Member info tab

async function searchMembers() {
    const query = document.getElementById('memberSearchInput').value;
    if (!query) {
        return;
    }
    
    try {
        const response = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`);
        if (response.ok) {
            const members = await response.json();
            renderMembers(members);
        }
    } catch (error) {
        console.error('Error searching members:', error);
    }
}

function renderMembers(members) {
    const tbody = document.getElementById('membersTable');
    
    if (!Array.isArray(members) || members.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No members found</td></tr>';
        return;
    }
    
    tbody.innerHTML = members.map(member => `
        <tr>
            <td><code>${escapeHtml(member.user_id)}</code></td>
            <td>${escapeHtml(member.username)}</td>
            <td>${member.joined_at ? new Date(member.joined_at).toLocaleDateString() : '-'}</td>
            <td>${escapeHtml(member.level || '1')}</td>
            <td><strong>${escapeHtml(member.warn_count || 0)}</strong></td>
            <td>${member.notes ? '✏️' : '-'}</td>
            <td>
                <button class="btn btn-sm btn-primary" onclick="openNotesModal('${escapeHtml(member.user_id)}', '${escapeHtml(member.username)}')">Notes</button>
            </td>
        </tr>
    `).join('');
}

function openNotesModal(userId, username) {
    document.getElementById('notesMemberId').textContent = `${username} (${userId})`;
    document.getElementById('notesModal').style.display = 'flex';
    loadMemberNotes(userId);
}

function closeNotesModal() {
    document.getElementById('notesModal').style.display = 'none';
}

async function loadMemberNotes(userId) {
    try {
        const response = await fetch(`/api/members/${userId}/notes`);
        if (response.ok) {
            const data = await response.json();
            document.getElementById('notesTextarea').value = data.notes || '';
        }
    } catch (error) {
        console.error('Error loading member notes:', error);
    }
}

async function saveNotes() {
    const userId = document.getElementById('notesMemberId').textContent.match(/\((\d+)\)/)[1];
    const notes = document.getElementById('notesTextarea').value;
    
    try {
        const response = await fetch(`/api/members/${userId}/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes })
        });
        
        if (response.ok) {
            showSuccess('Notes saved successfully');
            closeNotesModal();
        } else {
            showError('Failed to save notes');
        }
    } catch (error) {
        showError('Error saving notes');
    }
}

//  Utility functions

function showError(msg) {
    if (typeof showToast === 'function') {
        return showToast('error', 'Error', msg);
    }
    const notification = document.createElement('div');
    notification.className = 'notification error';
    notification.textContent = '❌ ' + msg;
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 5000);
}

function showSuccess(msg) {
    if (typeof showToast === 'function') {
        return showToast('success', 'Success', msg);
    }
    const notification = document.createElement('div');
    notification.className = 'notification success';
    notification.textContent = '✅ ' + msg;
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 5000);
}

function logout() {
    if (confirm('Are you sure you want to logout?')) {
        fetch('/api/logout', { method: 'POST' }).then(() => {
            window.location.href = '/login';
        });
    }
}


function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

//  Ban/timeout detail modals

function viewBanDetails(ban) {
    const userDisplay = ban.username ? `${ban.username} (${ban.user_id})` : ban.user_id || 'N/A';
    const bannedByDisplay = ban.banned_by_username ? `${ban.banned_by_username} (${ban.banned_by})` : ban.banned_by || 'Unknown';
    document.getElementById('banDetailUser').textContent = userDisplay;
    document.getElementById('banDetailReason').textContent = ban.ban_reason || ban.reason || 'No reason provided';
    document.getElementById('banDetailBannedBy').textContent = bannedByDisplay;
    document.getElementById('banDetailBannedAt').textContent = ban.banned_at ? new Date(ban.banned_at).toLocaleString() : 'N/A';
    document.getElementById('banDetailCaseId').textContent = ban.ban_case_id || 'N/A';
    document.getElementById('banDetailsModal').style.display = 'flex';
}

function closeBanDetails() {
    document.getElementById('banDetailsModal').style.display = 'none';
}

function viewTimeoutDetails(timeout) {
    const userDisplay = timeout.username ? `${timeout.username} (${timeout.user_id})` : timeout.user_id || 'N/A';
    const issuedByDisplay = timeout.issued_by_username ? `${timeout.issued_by_username} (${timeout.issued_by})` : timeout.issued_by || 'Unknown';
    document.getElementById('timeoutDetailUser').textContent = userDisplay;
    document.getElementById('timeoutDetailReason').textContent = timeout.reason || 'No reason provided';
    document.getElementById('timeoutDetailIssuedBy').textContent = issuedByDisplay;
    document.getElementById('timeoutDetailIssuedAt').textContent = timeout.issued_at ? new Date(timeout.issued_at).toLocaleString() : 'N/A';
    document.getElementById('timeoutDetailExpiresAt').textContent = timeout.expires_at ? new Date(timeout.expires_at).toLocaleString() : 'N/A';
    
    // Calculate remaining time
    const now = Date.now();
    const expires = timeout.expires_at ? new Date(timeout.expires_at).getTime() : null;
    let remaining = 'N/A';
    if (expires && expires > now) {
        const diff = expires - now;
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        remaining = `${hours}h ${minutes}m`;
    } else if (expires) {
        remaining = 'Expired';
    }
    document.getElementById('timeoutDetailRemaining').textContent = remaining;
    
    document.getElementById('timeoutDetailsModal').style.display = 'flex';
}

function closeTimeoutDetails() {
    document.getElementById('timeoutDetailsModal').style.display = 'none';
}