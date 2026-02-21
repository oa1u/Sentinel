// This function lets you open and close the user dropdown menu. Super handy for switching accounts or settings.
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

// This is the main dashboard script. It loads stats and keeps everything updated in real time using WebSocket.
// Note to self: Would be cool to add more charts here later!

// Here's where we keep all the dashboard data—levels, warnings, bans, reminders, giveaways, etc.
let currentData = {
    levels: [],
    warns: [],
    banned: [],
    reminders: [],
    giveaways: []
};

// Grab the CSRF token from the meta tag so we can keep things secure.
let csrfToken = '';

// Set up the WebSocket connection so the dashboard updates live without needing a refresh.
let socket = null;
if (!window.api || !window.ui) {
    const { api, ui } = window.AdminPanel || {};
    window.api = api;
    window.ui = ui;
}
const logout = window.logout;

function unwrapList(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
}

function toNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

// Initialize everything when the page loads
document.addEventListener('DOMContentLoaded', () => {
    // Grab CSRF token if it's available
    const csrfElement = document.querySelector('meta[name="csrf-token"]');
    if (csrfElement) {
        csrfToken = csrfElement.getAttribute('content');
    }
    
    checkAdminAccess().then(accountInfo => {
        if (typeof io !== 'undefined' && accountInfo && accountInfo.username && accountInfo.role) {
            try {
                window.socket = io({
                    auth: {
                        username: accountInfo.username,
                        role: accountInfo.role
                    }
                });
                loadStats();
                loadAllData();
                setupEventListeners();
                initWebSocket();
            } catch (err) {
                console.error('Socket.IO connection failed:', err);
                showWarning('Live updates unavailable', 'WebSocket connection failed', 3000);
            }
        } else {
            let errorDiv = document.getElementById('dashboardError');
            if (!errorDiv) {
                errorDiv = document.createElement('div');
                errorDiv.id = 'dashboardError';
                errorDiv.style = 'color: red; background: #fff3f3; border: 1px solid #ffcccc; padding: 1rem; margin: 2rem auto; max-width: 600px; text-align: center; font-size: 1.2rem;';
                errorDiv.textContent = 'Failed to load account info. Please check your login and cookies.';
                document.body.prepend(errorDiv);
            }
            console.error('[dashboard] Account info missing or invalid:', accountInfo);
            setTimeout(() => {
                window.location.href = '/unauthorized';
            }, 2000);
        }
    });
});

// Make sure user is actually an admin and load their info
async function checkAdminAccess() {
    try {
        let data = await api.getAccountInfo();
        if (!data || typeof data !== 'object') {
            data = {};
        }
        // ...existing code...
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
        if (!data.username || !data.role) {
            let errorDiv = document.getElementById('dashboardError');
            if (!errorDiv) {
                errorDiv = document.createElement('div');
                errorDiv.id = 'dashboardError';
                errorDiv.style = 'color: red; background: #fff3f3; border: 1px solid #ffcccc; padding: 1rem; margin: 2rem auto; max-width: 600px; text-align: center; font-size: 1.2rem;';
                errorDiv.textContent = 'Failed to load account info. Please check your login and cookies.';
                document.body.prepend(errorDiv);
            }
            console.error('[dashboard] Account info missing or invalid:', data);
            setTimeout(() => {
                window.location.href = '/unauthorized';
            }, 2000);
            return data;
        }
        const username = data.username || 'User';
        const role = (data.role || 'user').toUpperCase();
        ui?.setText('headerUsername', username);
        ui?.setText('headerRole', role);
        ui?.setText('dropdownUsername', username);
        ui?.setText('dropdownRole', role);
        api?.applyRoleVisibility(data, { moderatorLinkId: 'moderatorLink', adminLinkId: 'adminLink', ownerLinkId: 'ownerLink', ownerNavLinkId: null });
        return data;
    } catch (error) {
        let errorDiv = document.getElementById('dashboardError');
        if (!errorDiv) {
            errorDiv = document.createElement('div');
            errorDiv.id = 'dashboardError';
            errorDiv.style = 'color: red; background: #fff3f3; border: 1px solid #ffcccc; padding: 1rem; margin: 2rem auto; max-width: 600px; text-align: center; font-size: 1.2rem;';
            errorDiv.textContent = 'Error checking admin access. Please try again.';
            document.body.prepend(errorDiv);
        }
        console.error('Error checking admin access:', error);
        setTimeout(() => {
            window.location.href = '/unauthorized';
        }, 2000);
        return {};
    }
}

// Wire up all the button clicks and such
function setupEventListeners() {
    // Logout button
    const logoutBtn = document.querySelector('.logout-btn');
    if (logoutBtn && !logoutBtn.hasAttribute('onclick')) {
        logoutBtn.addEventListener('click', logout);
    }
    
    // Tab switching for different sections
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            switchTab(e.target.dataset.tab);
        });
    });
    
    // Search bars - need to check if they exist first
    const searchLevels = document.getElementById('searchLevels');
    if (searchLevels) {
        searchLevels.addEventListener('input', (e) => {
            filterTable('levels', e.target.value);
        });
    }
    
    const searchWarns = document.getElementById('searchWarns');
    if (searchWarns) {
        searchWarns.addEventListener('input', (e) => {
            filterTable('warns', e.target.value);
        });
    }
    
    const searchBanned = document.getElementById('searchBanned');
    if (searchBanned) {
        searchBanned.addEventListener('input', (e) => {
            filterTable('banned', e.target.value);
        });
    }
    
    const searchReminders = document.getElementById('searchReminders');
    if (searchReminders) {
        searchReminders.addEventListener('input', (e) => {
            filterTable('reminders', e.target.value);
        });
    }
    
    const searchGiveaways = document.getElementById('searchGiveaways');
    if (searchGiveaways) {
        searchGiveaways.addEventListener('input', (e) => {
            filterTable('giveaways', e.target.value);
        });
    }
    
    // Modal close
    const modal = document.getElementById('warnModal');
    const closeBtn = modal ? modal.querySelector('.close') : null;
    
    if (closeBtn && modal) {
        closeBtn.addEventListener('click', () => {
            modal.classList.remove('active');
            modal.style.display = 'none';
        });
        
        window.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
                modal.style.display = 'none';
            }
        });
    }
}

// Switch tab
function switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(tabName).classList.add('active');
}

// Logout
// Load stats
async function loadStats() {
    try {
        const response = await fetch('/api/stats');
        
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        const data = await response.json();
        const stats = data?.stats || data || {};
        const totalUsers = toNumber(stats.totalUsers);
        const totalWarns = toNumber(stats.totalWarns ?? stats.totalWarnings);
        const totalReminders = toNumber(stats.totalReminders ?? stats.activeReminders);
        const totalGiveaways = toNumber(stats.totalGiveaways ?? stats.giveaways ?? stats.activeGiveaways);
        const totalBanned = toNumber(stats.totalBanned ?? stats.bannedUsers);
        const avgLevel = toNumber(stats.avgLevel);
        const totalXP = toNumber(stats.totalXP);
        const avgWarns = toNumber(stats.avgWarns);
        const banRate = toNumber(stats.banRate);
        
        // Update stat cards
        const setTextContent = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };
        
        setTextContent('statTotalUsers', totalUsers);
        setTextContent('statTotalWarns', totalWarns);
        setTextContent('statActiveReminders', totalReminders);
        setTextContent('statTotalGiveaways', totalGiveaways);
        setTextContent('statTotalBanned', totalBanned);
        
        // Active tickets
        setTextContent('statActiveTickets', toNumber(stats.activeTickets));
        
        // Summary statistics
        setTextContent('avgLevel', avgLevel.toFixed(1));
        setTextContent('totalXP', totalXP.toLocaleString());
        setTextContent('avgWarns', avgWarns.toFixed(1));
        setTextContent('banRate', banRate.toFixed(1) + '%');
        setTextContent('summaryActiveReminders', totalReminders);
        
        // Load quick stats for today
        await loadQuickStatsToday();
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// Load quick stats for today
async function loadQuickStatsToday() {
    try {
        const response = await fetch('/api/stats/today');
        if (response.ok) {
            const data = await response.json();
            
            const setTextContent = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.textContent = value || '0';
            };
            
            setTextContent('warnsToday', data.warnsToday || 0);
            setTextContent('commandsToday', data.commandsToday || 0);
        }
    } catch (error) {
        console.error('Error loading quick stats:', error);
    }
}

// Load all data
async function loadAllData() {
    await Promise.all([
        loadLevels(),
        loadWarns(),
        loadBannedUsers(),
        loadReminders(),
        loadGiveaways(),
        loadActivity()
    ]);
}

// Load levels
async function loadLevels() {
    try {
        const response = await fetch('/api/levels');
        
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        const payload = await response.json();
        currentData.levels = unwrapList(payload);
        if (Array.isArray(currentData.levels)) {
            renderLevels(currentData.levels);
        }
    } catch (error) {
        console.error('Error loading levels:', error);
    }
}

// Render levels table
function renderLevels(data) {
    try {
        const tbody = document.querySelector('#levelsTable tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        if (!Array.isArray(data) || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">No data available</td></tr>';
            return;
        }
        
        data.forEach((user, index) => {
            const lastActive = user.lastActive ? new Date(user.lastActive).toLocaleDateString() : 'Never';
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${index + 1}</td>
                <td><code>${user.userId}</code></td>
                <td>${user.level || 1}</td>
                <td>${user.xp || 0}</td>
                <td>${user.messages || 0}</td>
                <td>${lastActive}</td>
            `;
            tbody.appendChild(row);
        });
    } catch (error) {
        console.error('Error rendering levels:', error);
    }
}

// Load warns
async function loadWarns() {
    try {
        const response = await fetch('/api/warns');
        
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        const payload = await response.json();
        const warns = unwrapList(payload);
        if (Array.isArray(warns)) {
            currentData.warns = warns;
            renderWarns(warns);
        }
    } catch (error) {
        console.error('Error loading warns:', error);
    }
}

// Render warns table
function renderWarns(data) {
    try {
        const tbody = document.querySelector('#warnsTable tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        if (!Array.isArray(data) || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">No warnings found</td></tr>';
            return;
        }
        
        data.forEach(user => {
            const row = document.createElement('tr');
            const lastWarned = user.lastWarned ? new Date(user.lastWarned).toLocaleString() : 'N/A';
            const bannedBadge = user.banned ? '<span class="badge badge-danger">Banned</span>' : '<span class="badge badge-success">Active</span>';
            const reason = user.lastReason || 'N/A';
            
            // Escape userId for onclick to prevent XSS
            const escapedUserId = user.userId.replace(/'/g, "\\'");
            
            row.innerHTML = `
                <td><code>${escapeHtml(user.userId)}</code></td>
            <td><span class="badge badge-warning">${user.warnCount}</span></td>
            <td>${escapeHtml(reason).substring(0, 30)}${escapeHtml(reason).length > 30 ? '...' : ''}</td>
            <td>${bannedBadge}</td>
            <td>${lastWarned}</td>
            <td>
                <button class="btn-small" onclick="viewWarnings('${escapedUserId}')">View Details</button>
            </td>
        `;
        tbody.appendChild(row);
    });
    } catch (error) {
        console.error('Error rendering warns:', error);
    }
}

// View warnings modal
async function viewWarnings(userId) {
    try {
        const response = await fetch(`/api/warns/${userId}`);
        const data = await response.json();
        
        const modalBody = document.getElementById('warnModalBody');
        modalBody.innerHTML = '<h3 style="margin-bottom: 16px;">User ID: ' + userId + '</h3>';
        
        const warns = data.warns || {};
        const warnEntries = Object.entries(warns);
        
        if (warnEntries.length === 0) {
            modalBody.innerHTML += '<p style="color: var(--text-secondary);">No warnings found.</p>';
        } else {
            warnEntries.forEach(([caseId, warnData]) => {
                const warnItem = document.createElement('div');
                warnItem.className = 'warn-item';
                
                const timestamp = warnData.timestamp ? new Date(warnData.timestamp).toLocaleString() : 'Unknown';
                
                warnItem.innerHTML = `
                    <h3>Case ID: ${caseId}</h3>
                    <p><strong>Reason:</strong> ${warnData.reason || 'No reason provided'}</p>
                    <p><strong>Moderator:</strong> <code>${warnData.moderatorId || 'Unknown'}</code></p>
                    <p><strong>Date:</strong> ${timestamp}</p>
                    ${warnData.type ? `<p><strong>Type:</strong> ${warnData.type}</p>` : ''}
                    <button class="btn-small btn-danger" onclick="deleteWarning('${userId}', '${caseId}')">Delete Warning</button>
                `;
                modalBody.appendChild(warnItem);
            });
        }
        
        const modal = document.getElementById('warnModal');
        modal.style.display = 'flex';
        modal.classList.add('active');
    } catch (error) {
        console.error('Error loading warnings:', error);
    }
}

// Delete warning
async function deleteWarning(userId, caseId) {
    if (!confirm('Are you sure you want to delete this warning?')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/warns/${userId}/${caseId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            if (typeof showSuccess === 'function') showSuccess('Success', 'Warning deleted successfully');
            else alert('Warning deleted successfully');
            const modal = document.getElementById('warnModal');
            modal.style.display = 'none';
            modal.classList.remove('active');
            await loadWarns();
            await loadStats();
        } else {
            if (typeof showError === 'function') showError('Error', 'Failed to delete warning');
            else alert('Failed to delete warning');
        }
    } catch (error) {
        console.error('Error deleting warning:', error);
        if (typeof showError === 'function') showError('Error', 'Error deleting warning');
        else alert('Error deleting warning');
    }
}

// Load banned users
async function loadBannedUsers() {
    try {
        const response = await fetch('/api/banned');
        
        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }
        
        const payload = await response.json();
        const banned = unwrapList(payload);
        if (Array.isArray(banned)) {
            currentData.banned = banned;
            renderBannedUsers(banned);
        }
    } catch (error) {
        console.error('Error loading banned users:', error);
    }
}

// Render banned users table
function renderBannedUsers(data) {
    try {
        const tbody = document.querySelector('#bannedTable tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        if (!Array.isArray(data) || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">No banned users</td></tr>';
            return;
        }
        
        data.forEach(user => {
            const row = document.createElement('tr');
            const bannedAtRaw = user.bannedAt ?? user.banned_at;
            const bannedAt = bannedAtRaw ? new Date(bannedAtRaw).toLocaleString() : 'N/A';
            const bannedBy = user.bannedBy || user.banned_by || 'Unknown';
            const reason = user.banReason || user.ban_reason || 'No reason provided';
            const userId = user.userId || user.user_id || 'Unknown';
            
            row.innerHTML = `
                <td><code>${escapeHtml(userId)}</code></td>
                <td>${bannedAt}</td>
                <td><code>${escapeHtml(bannedBy)}</code></td>
            <td>${escapeHtml(reason)}</td>
            <td><span class="badge badge-warning">${user.warnCount || user.warn_count || 0}</span></td>
            <td>
                <button class="btn-small btn-danger" onclick="unbanUser('${String(userId).replace(/'/g, "\\'")}')">Unban</button>
            </td>
        `;
        tbody.appendChild(row);
    });
    } catch (error) {
        console.error('Error rendering banned users:', error);
    }
}

// Unban user
async function unbanUser(userId) {
    if (!confirm(`Are you sure you want to unban user ${userId}?`)) {
        return;
    }
    
    try {
        const response = await fetch(`/api/banned/${userId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (response.ok) {
            if (typeof showSuccess === 'function') showSuccess('Success', 'User unbanned successfully');
            else alert('User unbanned successfully');
            await loadBannedUsers();
            await loadWarns();
            await loadStats();
        } else {
            if (typeof showError === 'function') showError('Error', data.error || 'Failed to unban user');
            else alert(data.error || 'Failed to unban user');
        }
    } catch (error) {
        console.error('Error unbanning user:', error);
        if (typeof showError === 'function') showError('Error', 'Error unbanning user');
        else alert('Error unbanning user');
    }
}

// Load reminders
async function loadReminders() {
    try {
        const response = await fetch('/api/reminders');
        if (response.ok) {
            const payload = await response.json();
            const reminders = unwrapList(payload);
            if (Array.isArray(reminders)) {
                currentData.reminders = reminders;
                renderReminders(reminders);
            }
        }
    } catch (error) {
        console.error('Error loading reminders:', error);
    }
}

// Render reminders table
function renderReminders(data) {
    try {
        const tbody = document.querySelector('#remindersTable tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        if (!Array.isArray(data) || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-secondary);">No active reminders</td></tr>';
            return;
        }
        
        data.forEach(reminder => {
        const row = document.createElement('tr');
        const triggerTime = reminder.trigger_at ? new Date(reminder.trigger_at).toLocaleString() : (reminder.timestamp ? new Date(reminder.timestamp).toLocaleString() : 'Unknown');
        const channel = reminder.channel_id ? `<code>#${reminder.channel_id}</code>` : 'Unknown';
        const isPast = (reminder.trigger_at || reminder.timestamp) && (reminder.trigger_at || reminder.timestamp) < Date.now();
        const status = reminder.completed ? '<span class="badge badge-success">Delivered</span>' : (isPast ? '<span class="badge badge-danger">Expired</span>' : '<span class="badge badge-info">Active</span>');
        
        row.innerHTML = `
            <td><code>${reminder.userId || reminder.user_id || 'Unknown'}</code></td>
            <td>${reminder.message || reminder.text || 'No message'}</td>
            <td>${triggerTime}</td>
            <td>${channel}</td>
            <td>${status}</td>
        `;
        tbody.appendChild(row);
    });
    } catch (error) {
        console.error('Error rendering reminders:', error);
    }
}

// Load giveaways
async function loadGiveaways() {
    try {
        const response = await fetch('/api/giveaways');
        if (response.ok) {
            const payload = await response.json();
            const giveaways = unwrapList(payload);
            if (Array.isArray(giveaways)) {
                currentData.giveaways = giveaways;
                renderGiveaways(giveaways);
            }
        }
    } catch (error) {
        console.error('Error loading giveaways:', error);
    }
}

// Render giveaways table
function renderGiveaways(data) {
    try {
        const tbody = document.querySelector('#giveawaysTable tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        if (!Array.isArray(data) || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">No giveaways found</td></tr>';
            return;
        }
        
        data.forEach(giveaway => {
        const row = document.createElement('tr');
        const endTime = giveaway.endTime ? new Date(giveaway.endTime).toLocaleString() : 'Unknown';
        const isEnded = giveaway.endTime && giveaway.endTime < Date.now();
        const status = isEnded ? '<span class="badge badge-danger">Ended</span>' : '<span class="badge badge-success">Active</span>';
        const entries = giveaway.entries ? giveaway.entries.length : 0;
        
        row.innerHTML = `
            <td><code>${giveaway.id}</code></td>
            <td>${giveaway.prize || giveaway.title || 'Unknown'}</td>
            <td><code>${giveaway.channelId || 'Unknown'}</code></td>
            <td>${entries}</td>
            <td>${endTime}</td>
            <td>${status}</td>
        `;
        tbody.appendChild(row);
    });
    } catch (error) {
        console.error('Error rendering giveaways:', error);
    }
}

// Filter table
function filterTable(type, searchTerm) {
    if (!currentData[type] || !Array.isArray(currentData[type])) {
        return;
    }
    
    const filtered = currentData[type].filter(item => {
        if (!item) return false;
        
        const searchLower = searchTerm.toLowerCase();
        
        if (type === 'levels') {
            return item.userId && item.userId.toLowerCase().includes(searchLower);
        } else if (type === 'warns') {
            return item.userId && item.userId.toLowerCase().includes(searchLower);
        } else if (type === 'banned') {
            return (item.userId && item.userId.toLowerCase().includes(searchLower)) ||
                   (item.banReason && item.banReason.toLowerCase().includes(searchLower)) ||
                   (item.bannedBy && item.bannedBy.toLowerCase().includes(searchLower));
        } else if (type === 'reminders') {
            return (item.userId && item.userId.toLowerCase().includes(searchLower)) ||
                   (item.message && item.message.toLowerCase().includes(searchLower));
        } else if (type === 'giveaways') {
            return (item.id && item.id.toLowerCase().includes(searchLower)) ||
                   (item.prize && item.prize.toLowerCase().includes(searchLower));
        }
        
        return false;
    });
    
    // Render filtered data
    if (type === 'levels') renderLevels(filtered);
    else if (type === 'warns') renderWarns(filtered);
    else if (type === 'banned') renderBannedUsers(filtered);
    else if (type === 'reminders') renderReminders(filtered);
    else if (type === 'giveaways') renderGiveaways(filtered);
}

// Load activity
async function loadActivity() {
    try {
        const response = await fetch('/api/activity');
        if (!response.ok) return;
        
        const data = await response.json();
        renderActivity(data.activity || []);
    } catch (error) {
        console.error('Error loading activity:', error);
    }
}

// Render activity table
function renderActivity(data) {
    try {
        const tbody = document.querySelector('#activityTable tbody');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        
        if (!Array.isArray(data) || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary);">No recent activity</td></tr>';
            return;
        }
        
        data.slice(0, 20).forEach(activity => {
            const row = document.createElement('tr');
            const time = activity.createdAt ? new Date(activity.createdAt).toLocaleString() : 'Unknown';
            const action = activity.action || 'Unknown';
            const userId = activity.userId || activity.targetUserId || 'N/A';
            const details = activity.details || 'N/A';
            
            row.innerHTML = `
                <td>${time}</td>
                <td><strong>${escapeHtml(action)}</strong></td>
                <td><code>${escapeHtml(userId)}</code></td>
                <td>${escapeHtml(String(details)).substring(0, 50)}${escapeHtml(String(details)).length > 50 ? '...' : ''}</td>
            `;
            tbody.appendChild(row);
        });
    } catch (error) {
        console.error('Error rendering activity:', error);
    }
}

// Make functions globally available
window.viewWarnings = viewWarnings;
window.deleteWarning = deleteWarning;
window.unbanUser = unbanUser;

// Helper function to escape HTML and prevent XSS
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

// Refresh stats every 30 seconds
setInterval(() => {
    loadStats();
    loadActivity();
}, 30000);

// Format numbers with commas
function formatNumber(num) {
    return num.toLocaleString();
}

// Format time to readable format
function formatTime(ms) {
    if (!ms || ms < 0) return '0s';
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

// ========== PUNISHMENT HISTORY ==========

async function viewPunishmentHistory(userId, username) {
    document.getElementById('historyUsername').textContent = username || userId;
    document.getElementById('punishmentHistoryModal').classList.add('active');
    
    try {
        const response = await fetch(`/api/punishment-history/${userId}`);
        if (response.ok) {
            const history = await response.json();
            renderPunishmentHistory(history);
        } else {
            document.getElementById('punishmentTimeline').innerHTML = '<div class="text-center text-muted">No punishment history found</div>';
        }
    } catch (error) {
        console.error('Error loading punishment history:', error);
        document.getElementById('punishmentTimeline').innerHTML = '<div class="text-center text-muted">Failed to load history</div>';
    }
}

function renderPunishmentHistory(history) {
    const timeline = document.getElementById('punishmentTimeline');
    
    if (!Array.isArray(history) || history.length === 0) {
        timeline.innerHTML = '<div class="text-center text-muted">No punishment history found</div>';
        return;
    }
    
    timeline.innerHTML = history.map(item => `
        <div class="timeline-item ${item.type}">
            <div class="timeline-header">
                <div class="timeline-title">${getActionTitle(item.type)}</div>
                <div class="timeline-date">${new Date(item.timestamp).toLocaleString()}</div>
            </div>
            <div class="timeline-content">
                <div><strong>Reason:</strong> ${item.reason || 'No reason provided'}</div>
                ${item.duration ? `<div><strong>Duration:</strong> ${item.duration}</div>` : ''}
                ${item.moderator ? `<div class="timeline-moderator">By ${item.moderator}</div>` : ''}
            </div>
        </div>
    `).join('');
}

function getActionTitle(type) {
    const titles = {
        warn: '⚠️ Warning Issued',
        ban: '🚫 Banned',
        unban: '✅ Unbanned',
        kick: '👢 Kicked',
        timeout: '⏱️ Timed Out',
        untimeout: '✅ Timeout Removed'
    };
    return titles[type] || type;
}

function closePunishmentHistory() {
    document.getElementById('punishmentHistoryModal').classList.remove('active');
}

// Make function globally available
window.viewPunishmentHistory = viewPunishmentHistory;
window.closePunishmentHistory = closePunishmentHistory;

// ========== WEBSOCKET LIVE UPDATES ==========

function initWebSocket() {
    if (typeof io === 'undefined') {
        console.warn('Socket.io not loaded, live updates disabled');
        return;
    }
    
    try {
        socket = io();
        
        socket.on('connect', () => {
                // WebSocket connected
            showInfo('Live Updates', 'Real-time statistics are now active', 3000);
        });
        
        socket.on('disconnect', () => {
                // WebSocket disconnected
            showWarning('Connection Lost', 'Live updates temporarily unavailable', 3000);
        });
        
        socket.on('stats-update', (data) => {
            updateStatsFromWebSocket(data);
        });
        
        socket.on('error', (error) => {
            console.error('WebSocket error:', error);
        });
    } catch (error) {
        console.error('Failed to initialize WebSocket:', error);
    }
}

function updateStatsFromWebSocket(data) {
    const setTextContent = (id, value) => {
        const el = document.getElementById(id);
        if (el) {
            // Add animation class
            el.style.transition = 'all 0.3s ease';
            el.style.transform = 'scale(1.1)';
            el.textContent = value;
            setTimeout(() => {
                el.style.transform = 'scale(1)';
            }, 300);
        }
    };
    
    if (data.totalUsers !== undefined) {
        setTextContent('statTotalUsers', data.totalUsers);
    }
    if (data.totalWarns !== undefined) {
        setTextContent('statTotalWarns', data.totalWarns);
    }
    if (data.totalReminders !== undefined) {
        setTextContent('statActiveReminders', data.totalReminders);
    }
    if (data.totalGiveaways !== undefined) {
        setTextContent('statTotalGiveaways', data.totalGiveaways);
    }
    if (data.totalBanned !== undefined) {
        setTextContent('statTotalBanned', data.totalBanned);
    }
}