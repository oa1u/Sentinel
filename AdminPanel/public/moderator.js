/* Moderator panel helpers — UI utilities and moderation actions for the moderator interface. */
// This function lets you open and close the user dropdown menu. Makes navigation easier for moderators.
function toggleUserDropdown() {
    const menu = document.getElementById('userDropdownMenu');
    const trigger = document.querySelector('.user-dropdown-trigger');
    menu.classList.toggle('show');
    trigger.classList.toggle('active');
}
document.addEventListener('click', function (event) {
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

function renderTableSkeleton(tbodyId, columnCount = 5, rowCount = 4) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    const rows = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const cells = [];
        for (let colIndex = 0; colIndex < columnCount; colIndex++) {
            cells.push('<td><span class="skeleton-line"></span></td>');
        }
        rows.push(`<tr class="skeleton-row">${cells.join('')}</tr>`);
    }
    tbody.innerHTML = rows.join('');
}

function setOverviewLoading(isLoading) {
    const ids = ['todayWarns', 'todayBans', 'activeTimeouts', 'openTickets'];
    ids.forEach(id => {
        const elem = document.getElementById(id);
        if (!elem) return;
        if (isLoading) {
            elem.classList.add('skeleton-pill');
            elem.textContent = ' ';
        } else {
            elem.classList.remove('skeleton-pill');
        }
    });
}

function calculateMemberRisk(member) {
    if (!member) return 0;
    const warnCount = Number(member.warn_count || member.warnings || 0);
    const timeoutCount = Number(member.timeout_count || 0);
    const banCount = Number(member.ban_count || 0);
    const kickCount = Number(member.kick_count || 0);

    return Math.max(0, Math.min(100,
        (warnCount * 4)
        + (timeoutCount * 7)
        + (banCount * 12)
        + (kickCount * 6)
        + (member.is_banned ? 10 : 0)
        + (member.is_timed_out ? 5 : 0)
    ));
}

function getRiskLabel(riskScore) {
    if (riskScore >= 75) return 'Critical';
    if (riskScore >= 50) return 'High';
    if (riskScore >= 25) return 'Medium';
    return 'Low';
}

function showMemberProfileSkeleton() {
    const panel = document.getElementById('memberDeepProfile');
    if (panel) panel.style.display = 'block';

    const title = document.getElementById('memberDeepTitle');
    const subtitle = document.getElementById('memberDeepSubtitle');
    const fields = document.getElementById('memberProfileFields');
    const timeline = document.getElementById('memberTimelineTable');
    const identityBadges = document.getElementById('memberIdentityBadges');
    const riskStrip = document.getElementById('memberRiskIndicator');
    const deepAvatar = document.getElementById('memberDeepAvatar');

    if (title) title.textContent = 'Loading member profile...';
    if (subtitle) subtitle.textContent = 'Fetching data from multiple sources';
    if (deepAvatar) {
        deepAvatar.className = 'member-avatar member-avatar-lg';
        deepAvatar.innerHTML = '<span class="skeleton-pill" style="width: 28px; height: 28px;"></span>';
    }
    if (identityBadges) identityBadges.innerHTML = '<span class="skeleton-pill" style="width:120px;"></span><span class="skeleton-pill" style="width:100px;"></span>';
    if (riskStrip) riskStrip.innerHTML = '<span class="skeleton-line"></span>';

    if (fields) {
        fields.innerHTML = '<div class="skeleton-block"></div><div class="skeleton-block"></div><div class="skeleton-block"></div><div class="skeleton-block"></div>';
    }

    const metricIds = ['memberMetricWarnings', 'memberMetricTimeouts', 'memberMetricBans', 'memberMetricKicks', 'memberMetricRisk', 'memberMetricFlags'];
    metricIds.forEach(id => {
        const elem = document.getElementById(id);
        if (!elem) return;
        elem.classList.add('skeleton-pill');
        elem.textContent = ' ';
    });

    if (timeline) {
        timeline.innerHTML = `
            <tr class="skeleton-row"><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td></tr>
            <tr class="skeleton-row"><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td></tr>
            <tr class="skeleton-row"><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td><td><span class="skeleton-line"></span></td></tr>
        `;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    let accountInfo;
    try {
        accountInfo = await checkModeratorAccess();
        if (accountInfo && typeof accountInfo === 'object' && accountInfo.username && accountInfo.role) {
            if (typeof io !== 'undefined') {
                try {
                    window.socket = createSocketConnection();
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
    await loadTickets();

    const ticketStatusFilter = document.getElementById('ticketStatusFilter');
    const ticketsRefreshBtn = document.getElementById('ticketsRefreshBtn');
    const transcriptCopyBtn = document.getElementById('ticketTranscriptCopyBtn');
    const transcriptDownloadBtn = document.getElementById('ticketTranscriptDownloadBtn');

    ticketStatusFilter?.addEventListener('change', () => {
        loadTickets(ticketStatusFilter.value);
    });
    ticketsRefreshBtn?.addEventListener('click', () => {
        loadTickets(ticketStatusFilter?.value || 'all');
    });
    transcriptCopyBtn?.addEventListener('click', () => copyTicketTranscript());
    transcriptDownloadBtn?.addEventListener('click', () => downloadTicketTranscript());

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

function refreshModeratorVisibleData() {
    const activeTab = document.querySelector('.tab.active')?.dataset?.tab || 'overview';
    if (activeTab === 'tickets') {
        const ticketStatusFilter = document.getElementById('ticketStatusFilter');
        loadTickets(ticketStatusFilter?.value || 'all');
        return;
    }
    if (activeTab === 'bans') {
        loadBannedUsers();
        loadTimeouts();
        return;
    }
    if (activeTab === 'members') {
        if (typeof refreshCurrentMemberLookup === 'function') {
            refreshCurrentMemberLookup();
        }
        return;
    }

    loadOverviewStats();
    loadRecentActions();
}

if (window.AdminPanel) {
    window.AdminPanel.refreshVisibleData = refreshModeratorVisibleData;
}

document.addEventListener('adminpanel:refresh-visible-data', refreshModeratorVisibleData);

function createSocketConnection(options = {}) {
    if (typeof io === 'undefined') return null;
    if (window.socket) return window.socket;

    const socket = io({
        withCredentials: true,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 20,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        randomizationFactor: 0.5,
        timeout: 10000,
        ...options
    });

    window.socket = socket;
    return socket;
}

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

            if (window.AdminPanel?.api?.applyRoleVisibility) {
                window.AdminPanel.api.applyRoleVisibility(data || {});
            }

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
    if (tabName === 'bans') {
        loadBannedUsers();
        loadTimeouts();
    } else if (tabName === 'tickets') {
        const ticketStatusFilter = document.getElementById('ticketStatusFilter');
        loadTickets(ticketStatusFilter?.value || 'all');
    } else if (tabName === 'warnings') {
        // Warning search happens when user types
    } else if (tabName === 'members') {
        // Member lookup is manually triggered or refreshed
    }
}

//  OVERVIEW TAB 

async function loadOverviewStats() {
    try {
        setOverviewLoading(true);
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
    } finally {
        setOverviewLoading(false);
    }
}

async function loadRecentActions() {
    renderTableSkeleton('recentActionsTable', 4, 6);
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

let activeTicketTranscript = '';
let activeTicketId = null;

async function loadTickets(status = 'all') {
    renderTableSkeleton('ticketsTable', 5, 4);
    try {
        const query = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : '';
        const response = await fetch(`/api/tickets${query}`);
        if (!response.ok) {
            renderTickets([]);
            return;
        }
        const data = await response.json();
        const list = Array.isArray(data) ? data : [];
        window.currentTickets = list;
        renderTickets(list);
    } catch (error) {
        console.error('Error loading tickets:', error);
        renderTickets([]);
    }
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
    activeTicketId = ticket.id || ticketId;
    await loadTicketTranscript(activeTicketId);

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
    activeTicketTranscript = '';
    activeTicketId = null;
    const body = document.getElementById('ticketTranscriptBody');
    const meta = document.getElementById('ticketTranscriptMeta');
    if (body) body.textContent = 'Select a ticket to load the transcript.';
    if (meta) meta.textContent = 'No transcript loaded.';
}

async function loadTicketTranscript(ticketId) {
    const body = document.getElementById('ticketTranscriptBody');
    const meta = document.getElementById('ticketTranscriptMeta');
    if (body) body.textContent = 'Loading transcript...';
    if (meta) meta.textContent = 'Fetching transcript from logs...';

    try {
        const response = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/transcript`);
        if (!response.ok) {
            activeTicketTranscript = '';
            if (body) body.textContent = 'Transcript unavailable for this ticket.';
            if (meta) meta.textContent = `Failed to load transcript (${response.status}).`;
            return;
        }

        const data = await response.json();
        if (!data?.hasTranscript || !data?.transcript) {
            activeTicketTranscript = '';
            if (body) body.textContent = 'No transcript is available yet for this ticket.';
            if (meta) meta.textContent = 'Transcript not stored.';
            return;
        }

        activeTicketTranscript = String(data.transcript || '');
        if (body) body.textContent = activeTicketTranscript;
        if (meta) {
            const createdAt = data.createdAt ? new Date(Number(data.createdAt)).toLocaleString() : 'Unknown time';
            meta.textContent = `Saved ${createdAt}`;
        }
    } catch (error) {
        console.error('Error loading transcript:', error);
        activeTicketTranscript = '';
        if (body) body.textContent = 'Transcript unavailable due to an error.';
        if (meta) meta.textContent = 'Failed to load transcript.';
    }
}

async function copyTicketTranscript() {
    if (!activeTicketTranscript) {
        showError('No transcript to copy');
        return;
    }

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(activeTicketTranscript);
        } else {
            const temp = document.createElement('textarea');
            temp.value = activeTicketTranscript;
            document.body.appendChild(temp);
            temp.select();
            document.execCommand('copy');
            temp.remove();
        }
        showSuccess('Transcript copied to clipboard');
    } catch (error) {
        console.error('Failed to copy transcript:', error);
        showError('Could not copy transcript');
    }
}

function downloadTicketTranscript() {
    if (!activeTicketTranscript) {
        showError('No transcript to download');
        return;
    }

    const safeId = String(activeTicketId || 'ticket').replace(/[^a-zA-Z0-9_-]/g, '');
    const blob = new Blob([activeTicketTranscript], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ticket-transcript-${safeId || 'export'}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
}

async function claimTicket(ticketId) {
    try {
        const { response, data } = await AdminPanel.api.postJson(`/api/tickets/${ticketId}/claim`, {});
        if (response && response.ok) {
            showSuccess('Ticket claimed successfully');
        } else {
            showError((data && data.error) || 'Failed to claim ticket');
        }
    } catch (error) {
        showError('Error claiming ticket');
    }
}

//  Bans/timeout tab

async function loadBannedUsers() {
    renderTableSkeleton('bannedUsersTable', 6, 5);
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
        const username = ban.username || 'Unknown';
        const reason = (ban.ban_reason && String(ban.ban_reason).trim()) ? ban.ban_reason : 'No reason provided';
        const bannedDate = ban.banned_at ? new Date(ban.banned_at).toLocaleString() : 'Unknown';
        return `
        <tr class="moderation-list-row">
            <td><code class="list-id">${escapeHtml(ban.user_id)}</code></td>
            <td>${escapeHtml(username)}</td>
            <td><div class="list-reason">${escapeHtml(reason)}</div></td>
            <td>${escapeHtml(bannedByDisplay)}</td>
            <td>${escapeHtml(bannedDate)}</td>
            <td>
                <div class="list-actions">
                    <button class="btn btn-sm btn-primary" onclick="window.viewBanDetails_${idx}()">View</button>
                    <button class="btn btn-sm btn-success" onclick="unbanUser('${escapeHtml(ban.user_id)}')">Unban</button>
                </div>
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
    renderTableSkeleton('timeoutsTable', 6, 5);
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
        const username = timeout.username || 'Unknown';
        const reason = (timeout.reason && String(timeout.reason).trim()) ? timeout.reason : 'No reason provided';
        // Fix expiration date formatting if invalid
        let expiresDate = 'N/A';
        if (timeout.expires_at) {
            const expires = new Date(timeout.expires_at);
            expiresDate = isNaN(expires.getTime()) ? 'N/A' : expires.toLocaleString();
        }
        return `
        <tr class="moderation-list-row">
            <td><code class="list-id">${escapeHtml(timeout.user_id)}</code></td>
            <td>${escapeHtml(username)}</td>
            <td><div class="list-reason">${escapeHtml(reason)}</div></td>
            <td>${escapeHtml(issuedByDisplay)}</td>
            <td>${expiresDate}</td>
            <td>
                <div class="list-actions">
                    <button class="btn btn-sm btn-primary" onclick='viewTimeoutDetails(${JSON.stringify(timeout)})'>View</button>
                    <button class="btn btn-sm btn-success" onclick="removeTimeout('${escapeHtml(timeout.user_id)}')">Remove</button>
                </div>
            </td>
        </tr>
    `;
    }).join('');
}

async function unbanUser(userId) {
    try {
        let confirmed = true;
        if (typeof modalManager !== 'undefined' && modalManager && typeof modalManager.showConfirm === 'function') {
            confirmed = await modalManager.showConfirm({
                title: 'Confirm Unban',
                message: 'Are you sure you want to unban this user?',
                confirmText: 'Unban',
                cancelText: 'Cancel',
                type: 'danger'
            });
        } else {
            confirmed = confirm('Are you sure you want to unban this user?');
        }
        if (!confirmed) return;
    } catch (err) {
        console.error('Confirmation failed', err);
        return;
    }

    try {
        const { response, data } = await AdminPanel.api.requestJson(`/api/moderation/bans/${userId}`, { method: 'DELETE' });
        if (response && response.ok && data && data.success) {
            const caseIdMsg = data.caseId ? ` (Case ID: ${data.caseId})` : '';
            showSuccess(`User unbanned successfully${caseIdMsg}`);
            await loadBannedUsers();
        } else {
            showError((data && data.error) || 'Failed to unban user');
            console.error('Error unbanning user:', data || response);
        }
    } catch (error) {
        showError('Error unbanning user');
    }
}

async function removeTimeout(userId) {
    try {
        const { response, data } = await AdminPanel.api.requestJson(`/api/moderation/timeouts/${userId}`, { method: 'DELETE' });
        if (response && response.ok) {
            showSuccess('Timeout removed successfully');
            await loadTimeouts();
        } else {
            showError((data && data.error) || 'Failed to remove timeout');
        }
    } catch (error) {
        showError('Error removing timeout');
    }
}

//  Warnings tab

const warningCaseHandlers = [];
window.__warningCaseHandlers = warningCaseHandlers;

function resetWarningCaseHandlers() {
    warningCaseHandlers.length = 0;
}

function registerWarningCaseHandler(handler) {
    warningCaseHandlers.push(handler);
    return warningCaseHandlers.length - 1;
}

function getWarningLookupMode() {
    return document.getElementById('warningLookupMode')?.value === 'case' ? 'case' : 'user';
}

function setWarningLookupMode(mode) {
    const modeSelect = document.getElementById('warningLookupMode');
    const input = document.getElementById('warningSearchInput');
    if (!input || !modeSelect) return;

    modeSelect.value = mode === 'case' ? 'case' : 'user';

    if (mode === 'case') {
        input.placeholder = 'Search by Case ID (e.g. WARN-0001)...';
        input.value = '';
        renderWarningLookupEmpty('Enter a Case ID and click Search.');
        return;
    }

    input.placeholder = 'Search by User ID (17-19 digits)...';
    input.value = '';
    renderWarningLookupEmpty('Enter a Discord User ID and click Search.');
}

window.setWarningLookupMode = setWarningLookupMode;

function clearWarningsLookupState() {
    setWarningLookupMode('user');
    renderWarningLookupEmpty('Search by User ID or Case ID.');
    closeWarningsDetails();
}

window.clearWarningsLookupState = clearWarningsLookupState;

function renderWarningLookupEmpty(message) {
    const tbody = document.getElementById('warningsTable');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">${escapeHtml(message)}</td></tr>`;
    resetWarningCaseHandlers();
}

function normalizeCaseRecord(record) {
    const caseId = record?.case_id || record?.ban_case_id || 'N/A';
    const type = String(
        record?.type
        || (record?.ban_case_id ? 'BAN' : '')
        || (record?.expires_at ? 'TIMEOUT' : '')
        || 'WARN'
    ).toUpperCase();

    const timestamp = record?.timestamp || record?.created_at || record?.banned_at || record?.issued_at || null;
    const moderator = record?.moderator_name
        || record?.moderator_id
        || record?.banned_by_name
        || record?.banned_by
        || record?.issued_by_name
        || record?.issued_by
        || 'Unknown';

    const reason = record?.reason || record?.ban_reason || 'No reason provided';

    return {
        user_id: record?.user_id || 'N/A',
        username: record?.username || '',
        case_id: caseId,
        type,
        timestamp,
        moderator,
        reason,
        expires_at: record?.expires_at || null,
        related_case_id: record?.related_case_id || null
    };
}

async function searchWarnings() {
    const input = document.getElementById('warningSearchInput');
    const mode = getWarningLookupMode();
    const query = input ? input.value.trim() : '';

    if (!query) {
        renderWarningLookupEmpty(mode === 'case'
            ? 'Enter a Case ID to search.'
            : 'Enter a Discord User ID to search.');
        return;
    }

    if (mode === 'user' && !/^\d{17,19}$/.test(query)) {
        renderWarningLookupEmpty('User lookup requires a valid Discord User ID (17-19 digits).');
        return;
    }

    renderTableSkeleton('warningsTable', 6, 4);

    try {
        if (mode === 'case') {
            const { response, data } = await AdminPanel.api.requestJson(`/api/moderation/case/${encodeURIComponent(query)}`);
            if (response && response.ok && data) {
                const normalizedCase = normalizeCaseRecord(data);
                renderWarningsCaseLookup(normalizedCase);
                viewWarningDetails({
                    user_id: normalizedCase.user_id,
                    username: normalizedCase.username,
                    warn_count: 1,
                    warns: [normalizedCase]
                });
                return;
            }

            renderWarningLookupEmpty('No case found with that Case ID.');
            return;
        }

        const { response, data } = await AdminPanel.api.requestJson(`/api/moderation/user/${encodeURIComponent(query)}/history`);
        if (response && response.ok) {
            const history = Array.isArray(data) ? data.map(normalizeCaseRecord).filter(entry => entry.case_id && entry.case_id !== 'N/A') : [];
            renderWarningsUserLookup(query, history);
            return;
        }

        renderWarningLookupEmpty('Failed to load moderation history for that user.');
    } catch (error) {
        console.error('Error searching warnings:', error);
        renderWarningLookupEmpty('Error searching moderation history. Please try again.');
    }
}

// Expose function to global scope for inline onclick handlers
window.searchWarnings = searchWarnings;

function renderWarningsUserLookup(userId, history) {
    const tbody = document.getElementById('warningsTable');
    if (!tbody) return;
    resetWarningCaseHandlers();

    if (!Array.isArray(history) || history.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No cases found for this user</td></tr>';
        return;
    }

    const sortedHistory = [...history].sort((a, b) => {
        const aTime = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const bTime = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return bTime - aTime;
    });

    const latest = sortedHistory[0];

    const caseButtons = sortedHistory.map((entry) => {
        const handlerIndex = registerWarningCaseHandler(() => viewCaseDetailsById(entry.case_id));
        return `<button class="btn btn-sm btn-secondary" style="margin: 0.2rem 0.2rem 0 0;" onclick="window.__warningCaseHandlers[${handlerIndex}]()">${escapeHtml(entry.case_id)}</button>`;
    }).join('');

    const allDetailsIndex = registerWarningCaseHandler(() => {
        viewWarningDetails({
            user_id: userId,
            username: '',
            warn_count: sortedHistory.length,
            warns: sortedHistory
        });
    });

    tbody.innerHTML = `
        <tr>
            <td><code>${escapeHtml(userId)}</code></td>
            <td><strong>${escapeHtml(sortedHistory.length)}</strong></td>
            <td>${caseButtons}</td>
            <td>${escapeHtml(latest.type || 'N/A')}</td>
            <td>${latest.timestamp ? new Date(latest.timestamp).toLocaleString() : 'N/A'}</td>
            <td><button class="btn btn-sm btn-primary" onclick="window.__warningCaseHandlers[${allDetailsIndex}]()">View All</button></td>
        </tr>
    `;
}

function renderWarningsCaseLookup(caseRecord) {
    const tbody = document.getElementById('warningsTable');
    if (!tbody) return;
    resetWarningCaseHandlers();

    if (!caseRecord) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No case found</td></tr>';
        return;
    }

    const viewIndex = registerWarningCaseHandler(() => {
        viewWarningDetails({
            user_id: caseRecord.user_id,
            username: caseRecord.username,
            warn_count: 1,
            warns: [caseRecord]
        });
    });

    tbody.innerHTML = `
        <tr>
            <td><code>${escapeHtml(caseRecord.user_id || 'N/A')}</code></td>
            <td><strong>1</strong></td>
            <td><code>${escapeHtml(caseRecord.case_id || 'N/A')}</code></td>
            <td>${escapeHtml(caseRecord.type || 'N/A')}</td>
            <td>${caseRecord.timestamp ? new Date(caseRecord.timestamp).toLocaleString() : 'N/A'}</td>
            <td><button class="btn btn-sm btn-primary" onclick="window.__warningCaseHandlers[${viewIndex}]()">View</button></td>
        </tr>
    `;
}

async function viewCaseDetailsById(caseId) {
    if (!caseId || caseId === 'N/A') {
        showError('No valid Case ID available.');
        return;
    }

    try {
        const { response, data } = await AdminPanel.api.requestJson(`/api/moderation/case/${encodeURIComponent(caseId)}`);
        if (response && response.ok && data) {
            const normalizedCase = normalizeCaseRecord(data);
            viewWarningDetails({
                user_id: normalizedCase.user_id,
                username: normalizedCase.username,
                warn_count: 1,
                warns: [normalizedCase]
            });
            return;
        }
        showError('Case details not found.');
    } catch (error) {
        console.error('Error loading case details:', error);
        showError('Failed to load case details.');
    }
}

async function clearWarnings(userId) {
    try {
        let confirmed = true;
        if (typeof modalManager !== 'undefined' && modalManager && typeof modalManager.showConfirm === 'function') {
            confirmed = await modalManager.showConfirm({
                title: 'Clear Warnings',
                message: 'Are you sure you want to clear all warnings for this user?',
                confirmText: 'Clear',
                cancelText: 'Cancel',
                type: 'danger'
            });
        } else {
            confirmed = confirm('Are you sure you want to clear all warnings for this user?');
        }
        if (!confirmed) return;
    } catch (err) {
        console.error('Confirmation failed', err);
        return;
    }

    try {
        const { response, data } = await AdminPanel.api.requestJson(`/api/moderation/warnings/${userId}`, { method: 'DELETE' });
        if (response && response.ok) {
            showSuccess('Warnings cleared successfully');
            await searchWarnings();
        } else {
            showError((data && data.error) || 'Failed to clear warnings');
        }
    } catch (error) {
        showError('Error clearing warnings');
    }
}

function viewWarningDetails(warn) {
    const userDisplay = warn.username ? `${warn.username} (${warn.user_id})` : warn.user_id || 'N/A';
    document.getElementById('warningDetailUser').textContent = userDisplay;
    document.getElementById('warningDetailCount').textContent = warn.warn_count || 0;

    // Create detailed warning list
    if (warn.warns && Array.isArray(warn.warns) && warn.warns.length > 0) {
        const warningsList = warn.warns.map(w => {
            const actionType = (w.type || 'WARN').toUpperCase();
            return `
            <div style="padding: 0.5rem; border-bottom: 1px solid rgba(75, 85, 99, 0.2); margin-bottom: 0.5rem;">
                <div style="font-weight: 600; color: var(--text-primary);">${actionType}: ${escapeHtml(w.reason || 'No reason provided')}</div>
                <div style="font-size: 0.875rem; color: var(--text-secondary); margin-top: 0.25rem;">
                    <span>Case: ${escapeHtml(w.case_id || 'N/A')}</span> | 
                    <span>By: ${escapeHtml(w.moderator || w.moderator_id || 'Unknown')}</span> | 
                    <span>Date: ${(w.timestamp || w.created_at) ? new Date(w.timestamp || w.created_at).toLocaleString() : 'N/A'}</span>
                </div>
                ${(w.expires_at || w.related_case_id) ? `
                <div style="font-size: 0.82rem; color: var(--text-secondary); margin-top: 0.25rem;">
                    ${w.expires_at ? `<span>Expires: ${new Date(w.expires_at).toLocaleString()}</span>` : ''}
                    ${w.expires_at && w.related_case_id ? ' | ' : ''}
                    ${w.related_case_id ? `<span>Related Case: ${escapeHtml(w.related_case_id)}</span>` : ''}
                </div>
                ` : ''}
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

let currentMemberLookup = null;
let memberLookupTrendState = {
    activeUserId: null,
    risk: null,
    pressure: null,
    riskUpdatedAt: null,
    pressureUpdatedAt: null
};

function resetMemberLookupTrendState() {
    memberLookupTrendState = {
        activeUserId: null,
        risk: null,
        pressure: null,
        riskUpdatedAt: null,
        pressureUpdatedAt: null
    };
}

function ensureMemberLookupTrendContext(userId) {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
        resetMemberLookupTrendState();
        return;
    }
    if (memberLookupTrendState.activeUserId !== normalizedUserId) {
        memberLookupTrendState = {
            activeUserId: normalizedUserId,
            risk: null,
            pressure: null,
            riskUpdatedAt: null,
            pressureUpdatedAt: null
        };
    }
}

function buildTrendBadge(currentValue, previousValue) {
    if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue)) return '';
    const delta = currentValue - previousValue;
    if (delta === 0) {
        return '<span class="member-trend-badge member-trend-flat">→ no change</span>';
    }
    if (delta > 0) {
        return `<span class="member-trend-badge member-trend-up">↑ +${delta}</span>`;
    }
    return `<span class="member-trend-badge member-trend-down">↓ ${delta}</span>`;
}

function buildTrendTimestamp(updatedAt) {
    if (!Number.isFinite(updatedAt)) return '';
    const dt = new Date(updatedAt);
    if (Number.isNaN(dt.getTime())) return '';
    return `<span class="member-trend-time">updated ${escapeHtml(dt.toLocaleTimeString())}</span>`;
}

function setMemberLookupOverview({ count = 0, activeMember = 'None', riskPosture = 'No Data' } = {}) {
    const countEl = document.getElementById('memberLookupResultCount');
    const activeEl = document.getElementById('memberLookupActiveMember');
    const riskEl = document.getElementById('memberLookupRiskPosture');
    if (countEl) countEl.textContent = String(count);
    if (activeEl) activeEl.textContent = String(activeMember || 'None');

    const riskNumberMatch = String(riskPosture || '').match(/\((\d+)\)/);
    const currentRisk = riskNumberMatch ? Number(riskNumberMatch[1]) : NaN;
    const previousRisk = Number(memberLookupTrendState.risk);
    const riskTrendHtml = buildTrendBadge(currentRisk, previousRisk);
    let riskTimeHtml = '';

    if (Number.isFinite(currentRisk)) {
        memberLookupTrendState.risk = currentRisk;
        memberLookupTrendState.riskUpdatedAt = Date.now();
        riskTimeHtml = buildTrendTimestamp(memberLookupTrendState.riskUpdatedAt);
    }

    if (riskEl) {
        riskEl.innerHTML = `${escapeHtml(String(riskPosture || 'No Data'))} ${riskTrendHtml} ${riskTimeHtml}`.trim();
    }
}

function setMemberIntelligence(member) {
    const accountAgeEl = document.getElementById('memberIntelAccountAge');
    const recentActionEl = document.getElementById('memberIntelRecentAction');
    const pressureEl = document.getElementById('memberIntelEnforcementPressure');
    const signalEl = document.getElementById('memberIntelSignalQuality');
    const recommendationEl = document.getElementById('memberIntelRecommendation');

    if (!member) {
        if (accountAgeEl) accountAgeEl.textContent = 'Unknown';
        if (recentActionEl) recentActionEl.textContent = 'No data';
        if (pressureEl) pressureEl.textContent = 'Low';
        if (signalEl) signalEl.textContent = 'Pending';
        if (recommendationEl) recommendationEl.textContent = 'Run lookup';
        memberLookupTrendState.pressure = null;
        memberLookupTrendState.pressureUpdatedAt = null;
        return;
    }

    const createdAt = member.created_at ? new Date(member.created_at).getTime() : NaN;
    const accountAgeDays = Number.isFinite(createdAt)
        ? Math.max(0, Math.floor((Date.now() - createdAt) / (1000 * 60 * 60 * 24)))
        : null;

    const actions = Array.isArray(member.moderation_actions) ? member.moderation_actions : [];
    const latestAction = actions[0] || null;
    const latestActionLabel = latestAction
        ? `${String(latestAction.action || 'UNKNOWN')} • ${formatMemberDate(latestAction.timestamp, 'Unknown')}`
        : 'No action history';

    const pressureScore = Number(member.warn_count || 0) + Number(member.timeout_count || 0) + (Number(member.ban_count || 0) * 2);
    const pressureLabel = pressureScore >= 10 ? 'Severe' : pressureScore >= 5 ? 'Elevated' : pressureScore >= 2 ? 'Moderate' : 'Low';
    const pressureTrendHtml = buildTrendBadge(pressureScore, Number(memberLookupTrendState.pressure));
    memberLookupTrendState.pressure = pressureScore;
    memberLookupTrendState.pressureUpdatedAt = Date.now();
    const pressureTimeHtml = buildTrendTimestamp(memberLookupTrendState.pressureUpdatedAt);

    const signalQuality = [member.username, member.user_id, member.joined_at, member.created_at]
        .filter(Boolean).length >= 4 ? 'High' : 'Partial';

    const risk = Number(member.risk_score || 0);
    const recommendation = risk >= 75
        ? 'Escalate immediately'
        : risk >= 50
            ? 'Review & monitor closely'
            : risk >= 25
                ? 'Watchlist candidate'
                : 'Normal monitoring';

    if (accountAgeEl) accountAgeEl.textContent = accountAgeDays === null ? 'Unknown' : `${accountAgeDays} days`;
    if (recentActionEl) recentActionEl.textContent = latestActionLabel;
    if (pressureEl) {
        pressureEl.innerHTML = `${escapeHtml(pressureLabel)} ${pressureTrendHtml} ${pressureTimeHtml}`.trim();
    }
    if (signalEl) signalEl.textContent = signalQuality;
    if (recommendationEl) recommendationEl.textContent = recommendation;
}

function renderMemberLookupCardsSkeleton(count = 3) {
    const container = document.getElementById('membersTable');
    if (!container) return;

    container.innerHTML = Array.from({ length: Math.max(1, count) }).map(() => `
        <article class="member-result-card member-result-card-skeleton">
            <div class="member-result-head">
                <span class="skeleton-line" style="max-width: 180px;"></span>
                <span class="skeleton-pill" style="width: 80px;"></span>
            </div>
            <div class="member-result-meta">
                <span class="skeleton-line"></span>
                <span class="skeleton-line"></span>
                <span class="skeleton-line"></span>
            </div>
            <div class="member-result-stats">
                <span class="skeleton-pill"></span>
                <span class="skeleton-pill"></span>
                <span class="skeleton-pill"></span>
            </div>
        </article>
    `).join('');
}

async function searchMembers() {
    const inputElem = document.getElementById('memberSearchInput');
    const statusElem = document.getElementById('memberSearchStatus');
    const userId = inputElem.value.trim();
    if (statusElem) statusElem.textContent = '';

    // Only allow valid Discord user IDs (17-19 digits)
    if (!/^\d{17,19}$/.test(userId)) {
        renderMembers([]);
        renderDeepMemberProfile(null);
        if (statusElem) statusElem.textContent = 'Please enter a valid Discord User ID.';
        return;
    }

    try {
        if (statusElem) statusElem.textContent = 'Loading full member profile...';
        renderMemberLookupCardsSkeleton(3);
        showMemberProfileSkeleton();

        const [coreRes, notesRes, profileRes, actionsRes] = await Promise.all([
            AdminPanel.api.requestJson(`/api/users/${encodeURIComponent(userId)}`),
            AdminPanel.api.requestJson(`/api/members/${encodeURIComponent(userId)}/notes`),
            AdminPanel.api.requestJson(`/api/admin/user-profile/${encodeURIComponent(userId)}`),
            AdminPanel.api.requestJson(`/api/moderation/actions/search?q=${encodeURIComponent(userId)}&type=all&page=1&pageSize=25&sort=recent`)
        ]);

        const coreUser = coreRes?.data?.user;
        if (!coreRes?.response?.ok || !coreUser) {
            renderMembers([]);
            renderDeepMemberProfile(null);
            if (statusElem) statusElem.textContent = (coreRes?.data?.error || 'User not found.');
            return;
        }

        const actionsRaw = Array.isArray(actionsRes?.data?.results) ? actionsRes.data.results : [];
        const actions = actionsRaw.filter(entry => String(entry?.userId || '') === userId);

        const actionCounts = actions.reduce((acc, entry) => {
            const action = String(entry?.action || '').toUpperCase();
            acc[action] = (acc[action] || 0) + 1;
            return acc;
        }, {});

        const warnCount = Number(coreUser.warn_count || coreUser.warnings || 0);
        const timeoutCount = Number(actionCounts.TIMEOUT || 0);
        const banCount = Number(actionCounts.BAN || 0);
        const kickCount = Number(actionCounts.KICK || 0);
        const riskScore = calculateMemberRisk({
            ...coreUser,
            warn_count: warnCount,
            timeout_count: timeoutCount,
            ban_count: banCount,
            kick_count: kickCount
        });

        const riskLabel = getRiskLabel(riskScore);

        const noteText = notesRes?.response?.ok ? (notesRes?.data?.notes || coreUser.notes || '') : (coreUser.notes || '');
        const profileData = profileRes?.response?.ok ? (profileRes?.data?.data || null) : null;

        const enrichedMember = {
            ...coreUser,
            notes: noteText,
            warn_count: warnCount,
            timeout_count: timeoutCount,
            ban_count: banCount,
            kick_count: kickCount,
            risk_score: riskScore,
            risk_label: riskLabel,
            moderation_actions: actions,
            full_profile: profileData
        };

        currentMemberLookup = enrichedMember;
        renderMembers([enrichedMember]);
        renderDeepMemberProfile(enrichedMember);
        if (statusElem) statusElem.textContent = 'Loaded member profile and moderation history.';
    } catch (error) {
        renderMembers([]);
        renderDeepMemberProfile(null);
        if (statusElem) statusElem.textContent = 'Error searching user.';
        console.error('Error searching user:', error);
    }
}

function clearMemberSearch() {
    const inputElem = document.getElementById('memberSearchInput');
    const statusElem = document.getElementById('memberSearchStatus');
    if (inputElem) inputElem.value = '';
    if (statusElem) statusElem.textContent = '';
    currentMemberLookup = null;
    resetMemberLookupTrendState();
    setMemberLookupOverview();
    setMemberIntelligence(null);
    renderMembers([]);
    renderDeepMemberProfile(null);
}

async function refreshCurrentMemberLookup() {
    if (!currentMemberLookup?.user_id) {
        showError('No member selected to refresh.');
        return;
    }
    const inputElem = document.getElementById('memberSearchInput');
    if (inputElem) inputElem.value = String(currentMemberLookup.user_id);
    await searchMembers();
}

function getRiskBadgeHtml(member) {
    const risk = Number(member?.risk_score || 0);
    const label = String(member?.risk_label || 'Low');
    let toneClass = 'member-risk-low';
    if (risk >= 75) {
        toneClass = 'member-risk-critical';
    } else if (risk >= 50) {
        toneClass = 'member-risk-high';
    } else if (risk >= 25) {
        toneClass = 'member-risk-medium';
    }
    return `<span class="member-risk-badge ${toneClass}">${escapeHtml(label)} (${risk})</span>`;
}

function getMemberStatusBadgeHtml(member) {
    if (member?.is_banned) {
        return '<span class="member-status-badge member-status-banned">Banned</span>';
    }
    if (member?.is_timed_out) {
        return '<span class="member-status-badge member-status-timeout">Timed Out</span>';
    }
    const rawStatus = String(member?.status || 'offline').toLowerCase();
    if (rawStatus === 'online') {
        return '<span class="member-status-badge member-status-online">Online</span>';
    }
    if (rawStatus === 'idle') {
        return '<span class="member-status-badge member-status-idle">Idle</span>';
    }
    if (rawStatus === 'dnd') {
        return '<span class="member-status-badge member-status-dnd">DND</span>';
    }
    return '<span class="member-status-badge member-status-offline">Offline</span>';
}

function formatMemberDate(value, fallback = 'Unknown') {
    if (!value) return fallback;
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? fallback : dt.toLocaleString();
}

function getMemberInitial(member) {
    const raw = String(member?.username || member?.nickname || member?.user_id || '?').trim();
    return escapeHtml(raw.charAt(0).toUpperCase() || '?');
}

function getMemberAvatarUrl(member) {
    return String(member?.avatar || member?.full_profile?.avatar || '').trim();
}

function getMemberAvatarHtml(member, sizeClass = 'member-avatar-sm') {
    const avatarUrl = getMemberAvatarUrl(member);
    const initial = getMemberInitial(member);
    if (avatarUrl) {
        return `<div class="member-avatar ${sizeClass}"><img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(String(member?.username || 'Member'))}"></div>`;
    }
    return `<div class="member-avatar ${sizeClass} member-avatar-fallback">${initial}</div>`;
}

function renderDeepMemberProfile(member) {
    const panel = document.getElementById('memberDeepProfile');
    if (!panel) return;

    if (!member) {
        panel.style.display = 'none';
        const timeline = document.getElementById('memberTimelineTable');
        if (timeline) timeline.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No actions loaded.</td></tr>';
        resetMemberLookupTrendState();
        setMemberIntelligence(null);
        return;
    }

    ensureMemberLookupTrendContext(member.user_id);

    panel.style.display = 'block';
    const title = document.getElementById('memberDeepTitle');
    const subtitle = document.getElementById('memberDeepSubtitle');
    const profileFields = document.getElementById('memberProfileFields');
    const identityBadges = document.getElementById('memberIdentityBadges');
    const riskStrip = document.getElementById('memberRiskIndicator');
    const deepAvatar = document.getElementById('memberDeepAvatar');

    if (title) title.textContent = `${member.username || 'Unknown'} (${member.user_id})`;
    if (subtitle) {
        subtitle.textContent = `${member.status || 'Offline'} • Joined ${formatMemberDate(member.joined_at, 'Unknown date')}`;
    }

    if (deepAvatar) {
        const avatarUrl = getMemberAvatarUrl(member);
        deepAvatar.className = 'member-avatar member-avatar-lg' + (avatarUrl ? '' : ' member-avatar-fallback');
        if (avatarUrl) {
            deepAvatar.innerHTML = `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(String(member?.username || 'Member'))}">`;
        } else {
            deepAvatar.textContent = getMemberInitial(member);
        }
    }

    if (identityBadges) {
        const timeoutUntil = member.timeout_expires ? `Until ${formatMemberDate(member.timeout_expires, 'Unknown')}` : '';
        identityBadges.innerHTML = `
            <span class="member-identity-badge">ID: ${escapeHtml(member.user_id || 'N/A')}</span>
            <span class="member-identity-badge">@${escapeHtml(member.username || 'unknown')}</span>
            ${member.nickname ? `<span class="member-identity-badge">Nick: ${escapeHtml(member.nickname)}</span>` : ''}
            ${member.is_timed_out ? `<span class="member-identity-badge member-identity-warning">${escapeHtml(timeoutUntil || 'Timed Out')}</span>` : ''}
            ${member.is_banned ? '<span class="member-identity-badge member-identity-danger">Banned</span>' : ''}
        `;
    }

    const setMetric = (id, value) => {
        const elem = document.getElementById(id);
        if (elem) {
            elem.classList.remove('skeleton-pill');
            elem.textContent = value;
        }
    };

    setMetric('memberMetricWarnings', member.warn_count || 0);
    setMetric('memberMetricTimeouts', member.timeout_count || 0);
    setMetric('memberMetricBans', member.ban_count || 0);
    setMetric('memberMetricKicks', member.kick_count || 0);
    setMetric('memberMetricRisk', `${member.risk_label || 'Low'} (${member.risk_score || 0})`);
    setMetric('memberMetricFlags', member.flags || 'None');

    if (riskStrip) {
        riskStrip.innerHTML = `<span>Risk Assessment</span>${getRiskBadgeHtml(member)}`;
    }

    setMemberIntelligence(member);

    if (profileFields) {
        const details = [
            { label: 'Username', value: member.username || 'Unknown' },
            { label: 'Nickname', value: member.nickname || 'N/A' },
            { label: 'User ID', value: member.user_id || 'N/A' },
            { label: 'Status', value: member.status || 'Offline' },
            { label: 'Joined Server', value: formatMemberDate(member.joined_at, 'Unknown') },
            { label: 'Account Created', value: formatMemberDate(member.created_at, 'Unknown') },
            { label: 'Level', value: member.level || 0 },
            { label: 'XP', value: member.xp || 0 },
            { label: 'Messages', value: member.messages || 0 },
            { label: 'Banned', value: member.is_banned ? `Yes${member.ban_reason ? ` (${member.ban_reason})` : ''}` : 'No' },
            { label: 'Timed Out', value: member.is_timed_out ? `Yes (until ${formatMemberDate(member.timeout_expires, 'Unknown')})` : 'No' },
            { label: 'Bio', value: member.bio || 'N/A' }
        ];

        profileFields.innerHTML = details.map((entry) => `
            <div class="member-profile-field">
                <span class="member-profile-label">${escapeHtml(entry.label)}</span>
                <span class="member-profile-value">${escapeHtml(entry.value)}</span>
            </div>
        `).join('');
    }

    const timelineTable = document.getElementById('memberTimelineTable');
    if (!timelineTable) return;

    const actions = Array.isArray(member.moderation_actions) ? member.moderation_actions : [];
    if (actions.length === 0) {
        timelineTable.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No moderation actions found for this member.</td></tr>';
        return;
    }

    timelineTable.innerHTML = actions.slice(0, 20).map(action => {
        const ts = action.timestamp ? new Date(action.timestamp).toLocaleString() : 'Unknown';
        return `
            <tr>
                <td><strong>${escapeHtml(action.action || 'UNKNOWN')}</strong></td>
                <td>${escapeHtml(action.caseId || '-')}</td>
                <td style="max-width:360px;">${escapeHtml(action.reason || 'No reason provided')}</td>
                <td>${escapeHtml(action.moderatorName || action.moderatorId || 'Unknown')}</td>
                <td>${escapeHtml(ts)}</td>
            </tr>
        `;
    }).join('');
}

async function quickWarnFromMemberLookup() {
    const userId = currentMemberLookup?.user_id;
    if (!userId) {
        showError('Search a member first.');
        return;
    }
    const reason = window.prompt('Warn reason (3-500 chars):');
    if (!reason || reason.trim().length < 3) return;

    const snapshot = currentMemberLookup ? JSON.parse(JSON.stringify(currentMemberLookup)) : null;
    if (currentMemberLookup) {
        currentMemberLookup.warn_count = Number(currentMemberLookup.warn_count || 0) + 1;
        currentMemberLookup.risk_score = calculateMemberRisk(currentMemberLookup);
        currentMemberLookup.risk_label = getRiskLabel(currentMemberLookup.risk_score);
        currentMemberLookup.moderation_actions = [
            {
                action: 'WARN (PENDING)',
                caseId: 'pending',
                reason: reason.trim(),
                moderatorName: 'You',
                timestamp: new Date().toISOString()
            },
            ...(Array.isArray(currentMemberLookup.moderation_actions) ? currentMemberLookup.moderation_actions : [])
        ];
        renderMembers([currentMemberLookup]);
        renderDeepMemberProfile(currentMemberLookup);
    }

    try {
        const { response, data } = await AdminPanel.api.postJson('/api/moderation/warn', {
            userId,
            reason: reason.trim()
        });
        if (response && response.ok) {
            showSuccess('Warning issued successfully.');
            await refreshCurrentMemberLookup();
        } else {
            if (snapshot) {
                currentMemberLookup = snapshot;
                renderMembers([currentMemberLookup]);
                renderDeepMemberProfile(currentMemberLookup);
            }
            showError((data && data.error) || 'Failed to issue warning.');
        }
    } catch (error) {
        if (snapshot) {
            currentMemberLookup = snapshot;
            renderMembers([currentMemberLookup]);
            renderDeepMemberProfile(currentMemberLookup);
        }
        showError('Error issuing warning.');
    }
}

async function quickTimeoutFromMemberLookup() {
    const userId = currentMemberLookup?.user_id;
    if (!userId) {
        showError('Search a member first.');
        return;
    }
    const minutesRaw = window.prompt('Timeout minutes (1 - 40320):', '60');
    if (minutesRaw === null) return;
    const reason = window.prompt('Timeout reason (3-500 chars):');
    if (!reason || reason.trim().length < 3) return;

    const minutes = parseInt(minutesRaw, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 40320) {
        showError('Duration must be between 1 and 40320 minutes.');
        return;
    }

    const snapshot = currentMemberLookup ? JSON.parse(JSON.stringify(currentMemberLookup)) : null;
    if (currentMemberLookup) {
        currentMemberLookup.timeout_count = Number(currentMemberLookup.timeout_count || 0) + 1;
        currentMemberLookup.is_timed_out = true;
        currentMemberLookup.timeout_expires = new Date(Date.now() + (minutes * 60 * 1000)).toISOString();
        currentMemberLookup.risk_score = calculateMemberRisk(currentMemberLookup);
        currentMemberLookup.risk_label = getRiskLabel(currentMemberLookup.risk_score);
        currentMemberLookup.moderation_actions = [
            {
                action: 'TIMEOUT (PENDING)',
                caseId: 'pending',
                reason: reason.trim(),
                moderatorName: 'You',
                timestamp: new Date().toISOString()
            },
            ...(Array.isArray(currentMemberLookup.moderation_actions) ? currentMemberLookup.moderation_actions : [])
        ];
        renderMembers([currentMemberLookup]);
        renderDeepMemberProfile(currentMemberLookup);
    }

    try {
        const { response, data } = await AdminPanel.api.postJson('/api/moderation/timeout', {
            userId,
            duration: minutes * 60 * 1000,
            reason: reason.trim()
        });
        if (response && response.ok) {
            showSuccess('Timeout issued successfully.');
            await refreshCurrentMemberLookup();
        } else {
            if (snapshot) {
                currentMemberLookup = snapshot;
                renderMembers([currentMemberLookup]);
                renderDeepMemberProfile(currentMemberLookup);
            }
            showError((data && data.error) || 'Failed to issue timeout.');
        }
    } catch (error) {
        if (snapshot) {
            currentMemberLookup = snapshot;
            renderMembers([currentMemberLookup]);
            renderDeepMemberProfile(currentMemberLookup);
        }
        showError('Error issuing timeout.');
    }
}

function renderMembers(members) {
    const container = document.getElementById('membersTable');

    if (!container) return;

    if (!Array.isArray(members) || members.length === 0) {
        resetMemberLookupTrendState();
        setMemberLookupOverview({ count: 0, activeMember: 'None', riskPosture: 'No Data' });
        container.innerHTML = `
            <article class="member-welcome-card member-welcome-empty">
                <div class="member-welcome-title">No member loaded</div>
                <div class="member-welcome-subtitle">Search a valid Discord User ID (17-19 digits) to view profile intelligence.</div>
            </article>
        `;
        return;
    }

    const activeMember = members[0] || {};
    ensureMemberLookupTrendContext(activeMember.user_id);
    setMemberLookupOverview({
        count: members.length,
        activeMember: activeMember.username || activeMember.user_id || 'Unknown',
        riskPosture: `${activeMember.risk_label || 'Low'} (${activeMember.risk_score || 0})`
    });

    container.innerHTML = members.map(member => `
        <article class="member-result-card">
            <div class="member-result-head">
                <div class="member-result-identity-wrap">
                    ${getMemberAvatarHtml(member, 'member-avatar-sm')}
                    <div class="member-row-identity">
                        <span class="member-row-name">${escapeHtml(member.username || 'Unknown')}</span>
                        <span class="member-row-meta">ID: ${escapeHtml(member.user_id || 'N/A')} • ${escapeHtml(member.nickname || 'No nickname')}</span>
                    </div>
                </div>
                <div class="member-result-head-badges">
                    ${getMemberStatusBadgeHtml(member)}
                    ${getRiskBadgeHtml(member)}
                </div>
            </div>

            <div class="member-result-meta">
                <div class="member-result-meta-item"><span>Joined</span><strong>${member.joined_at ? new Date(member.joined_at).toLocaleDateString() : '-'}</strong></div>
                <div class="member-result-meta-item"><span>Level</span><strong>${escapeHtml(member.level || '1')}</strong></div>
                <div class="member-result-meta-item"><span>Messages</span><strong>${escapeHtml(member.messages || 0)}</strong></div>
                <div class="member-result-meta-item"><span>Warnings</span><strong>${escapeHtml(member.warn_count || 0)}</strong></div>
            </div>

            <div class="member-result-foot">
                <div class="member-result-notes ${member.notes ? 'has-notes' : ''}">${member.notes ? 'Notes available' : 'No notes yet'}</div>
                <button class="btn btn-sm btn-primary" onclick="openNotesModal('${escapeHtml(member.user_id)}', '${escapeHtml(member.username || 'Unknown')}')">Open Notes</button>
            </div>
        </article>
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
        const { response, data } = await AdminPanel.api.requestJson(`/api/members/${userId}/notes`);
        if (response && response.ok) {
            document.getElementById('notesTextarea').value = (data && data.notes) || '';
        }
    } catch (error) {
        console.error('Error loading member notes:', error);
    }
}

async function saveNotes() {
    const userId = document.getElementById('notesMemberId').textContent.match(/\((\d+)\)/)[1];
    const notes = document.getElementById('notesTextarea').value;
    const previousNotes = currentMemberLookup?.notes || '';

    if (currentMemberLookup) {
        currentMemberLookup.notes = notes;
        renderMembers([currentMemberLookup]);
    }

    try {
        const { response, data } = await AdminPanel.api.postJson(`/api/members/${userId}/notes`, { notes });
        if (response && response.ok) {
            showSuccess('Notes saved successfully');
            closeNotesModal();
        } else {
            if (currentMemberLookup) {
                currentMemberLookup.notes = previousNotes;
                renderMembers([currentMemberLookup]);
            }
            showError((data && data.error) || 'Failed to save notes');
        }
    } catch (error) {
        if (currentMemberLookup) {
            currentMemberLookup.notes = previousNotes;
            renderMembers([currentMemberLookup]);
        }
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
    (async () => {
        try {
            let confirmed = true;
            if (typeof modalManager !== 'undefined' && modalManager && typeof modalManager.showConfirm === 'function') {
                confirmed = await modalManager.showConfirm({
                    title: 'Logout',
                    message: 'Are you sure you want to logout?',
                    confirmText: 'Logout',
                    cancelText: 'Cancel',
                    type: 'warning'
                });
            } else {
                confirmed = confirm('Are you sure you want to logout?');
            }
            if (!confirmed) return;
            await AdminPanel.api.postJson('/api/logout', {});
            window.location.href = '/login';
        } catch (err) {
            console.error('Logout confirmation failed', err);
        }
    })();
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
    const reason = ban.ban_reason || ban.reason || 'No reason provided';
    const bannedAt = ban.banned_at ? new Date(ban.banned_at).toLocaleString() : 'N/A';
    const caseId = ban.ban_case_id || 'N/A';

    // If modalManager is available, show a polished modal. Otherwise fall back to legacy modal DOM.
    if (typeof modalManager !== 'undefined' && modalManager && typeof modalManager.showDetails === 'function') {
        // Ensure legacy static modal is hidden to avoid duplicate UI
        try { document.getElementById('banDetailsModal').style.display = 'none'; } catch (e) { }
        const modalTimestamp = Date.now();
        const unbanBtnId = `unban-btn-${modalTimestamp}`;
        const copyBtnId = `copy-id-${modalTimestamp}`;

        const html = `
            <div style="display:flex; gap:1rem; align-items:flex-start;">
                <div style="flex:0 0 72px;">
                    <div style="width:72px;height:72px;border-radius:8px;background:linear-gradient(180deg,#222,#111);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700">${escapeHtml((ban.username || 'U').charAt(0).toUpperCase())}</div>
                </div>
                <div style="flex:1;">
                    <h4 style="margin:0 0 0.25rem;color:var(--text-primary);">${escapeHtml(ban.username || 'Unknown')}</h4>
                    <div style="color:var(--text-secondary);font-size:0.95rem;margin-bottom:0.75rem;">ID: <code id="ban-id-${modalTimestamp}">${escapeHtml(ban.user_id || '')}</code> <button id="${copyBtnId}" class="btn btn-sm" style="margin-left:0.5rem;">Copy</button></div>

                    <dl style="display:grid;grid-template-columns:120px 1fr;gap:0.5rem 1rem;color:var(--text-secondary);">
                        <dt style="font-weight:600;color:var(--text-primary);">Reason</dt>
                        <dd>${escapeHtml(reason)}</dd>
                        <dt style="font-weight:600;color:var(--text-primary);">Banned By</dt>
                        <dd>${escapeHtml(bannedByDisplay)}</dd>
                        <dt style="font-weight:600;color:var(--text-primary);">When</dt>
                        <dd>${escapeHtml(bannedAt)}</dd>
                        <dt style="font-weight:600;color:var(--text-primary);">Case ID</dt>
                        <dd>${escapeHtml(caseId)}</dd>
                    </dl>
                </div>
            </div>
        `;

        const modal = modalManager.showDetails('Ban Details', html, null);

        // Attach copy handler
        try {
            const copyBtn = document.getElementById(copyBtnId);
            const idEl = document.getElementById(`ban-id-${modalTimestamp}`);
            if (copyBtn && idEl) {
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(idEl.textContent || '');
                    showSuccess('Copied', 'User ID copied to clipboard', 2000);
                });
            }
        } catch (e) { /* ignore */ }

        // Attach unban handler
        try {
            // Append an Unban button into the existing modal footer so there's only one Close button.
            const footer = modal.querySelector('.modal-footer');
            if (footer) {
                const unbanBtn = document.createElement('button');
                unbanBtn.className = 'btn btn-danger';
                unbanBtn.textContent = 'Unban';
                unbanBtn.style.marginLeft = '0.5rem';
                footer.appendChild(unbanBtn);

                unbanBtn.addEventListener('click', async () => {
                    // close this modal and trigger unban
                    if (modal && modal.id) modalManager.closeModal(modal.id);
                    await unbanUser(String(ban.user_id));
                });
            } else {
                // Fallback: if footer not found, attach to dynamically created button id
                const btn = document.getElementById(unbanBtnId);
                if (btn) {
                    btn.addEventListener('click', async () => {
                        if (modal && modal.id) modalManager.closeModal(modal.id);
                        await unbanUser(String(ban.user_id));
                    });
                }
            }
        } catch (e) { console.error(e); }

        return;
    }

    // Legacy fallback: populate existing static modal
    document.getElementById('banDetailUser').textContent = userDisplay;
    document.getElementById('banDetailReason').textContent = reason;
    document.getElementById('banDetailBannedBy').textContent = bannedByDisplay;
    document.getElementById('banDetailBannedAt').textContent = bannedAt;
    document.getElementById('banDetailCaseId').textContent = caseId;
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