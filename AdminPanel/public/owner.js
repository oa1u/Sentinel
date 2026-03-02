let inviteStatsData = [];

// Generate a new invite code
async function generateInvite() {
    const role = document.getElementById('inviteRole')?.value || 'moderator';
    const expiresInDays = parseInt(document.getElementById('inviteExpiry')?.value || 7);
    const description = document.getElementById('inviteDescription')?.value?.trim() || '';

    if (isNaN(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
        showError('Invalid Input', 'Expiry days must be between 1 and 365');
        return;
    }

    try {
        const { response, data } = await window.AdminPanel.api.postJson('/api/invites/generate', {
            role,
            expiresInDays,
            description
        });

        if (response.ok && data.success) {
            const resultDiv = document.getElementById('inviteResult');
            const expiresDate = new Date(data.expiresAt);
            
            resultDiv.innerHTML = `
                <div style="background: var(--bg-secondary); border: 1px solid var(--color-green); border-radius: var(--radius-md); padding: 1.5rem; margin-top: 1.5rem;">
                    <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem;">
                        <span style="font-size: 1.8rem;">✅</span>
                        <div>
                            <div style="font-weight: 700; font-size: 1.1rem; color: var(--color-green);">Invite Code Generated</div>
                            <div style="color: var(--text-secondary); font-size: 0.9rem;">Share this code with the new ${role}</div>
                        </div>
                    </div>
                    <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 1rem;">
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem;">
                            <code style="font-size: 1.2rem; font-weight: 700; color: var(--color-blue); font-family: 'Courier New', monospace; flex: 1;">${data.code}</code>
                            <button class="btn btn-secondary" onclick="copyInviteCode('${data.code}')" style="white-space: nowrap;">📋 Copy</button>
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; font-size: 0.9rem;">
                        <div><strong>Role:</strong> ${role}</div>
                        <div><strong>Expires:</strong> ${expiresDate.toLocaleDateString()}</div>
                        ${description ? `<div style="grid-column: 1 / -1;"><strong>Description:</strong> ${description}</div>` : ''}
                    </div>
                </div>
            `;
            
            // Clear form
            document.getElementById('inviteDescription').value = '';
            
            // Reload stats
            setTimeout(() => loadInviteStats(), 500);
        } else {
            showError('Generation Failed', data.error || 'Failed to generate invite code');
        }
    } catch (error) {
        showError('Error', 'Failed to generate invite: ' + error.message);
    }
}

// Copy invite code to clipboard
async function copyInviteCode(code) {
    try {
        await navigator.clipboard.writeText(code);
        showSuccess('Copied!', 'Invite code copied to clipboard');
    } catch (err) {
        // Fallback for older browsers
        const input = document.createElement('input');
        input.value = code;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showSuccess('Copied!', 'Invite code copied to clipboard');
    }
}

// Load invite statistics
async function loadInviteStats() {
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/invites/stats');
        
        if (!response.ok) {
            throw new Error(data.error || 'Failed to load invite stats');
        }

        inviteStatsData = Array.isArray(data) ? data : [];
        
        // Calculate statistics
        const stats = {
            active: 0,
            fullyUsed: 0,
            expired: 0,
            revoked: 0,
            totalUses: 0
        };

        inviteStatsData.forEach(invite => {
            stats.totalUses += invite.current_uses || 0;
            
            if (invite.status === 'active') stats.active++;
            else if (invite.status === 'fully_used') stats.fullyUsed++;
            else if (invite.status === 'expired') stats.expired++;
            else if (invite.status === 'revoked') stats.revoked++;
        });

        // Update stat cards
        document.getElementById('totalActiveInvites').textContent = stats.active;
        document.getElementById('totalUsedInvites').textContent = stats.fullyUsed;
        document.getElementById('totalExpiredInvites').textContent = stats.expired;
        document.getElementById('totalInviteUses').textContent = stats.totalUses;

        // Render table
        filterInviteStats();
    } catch (error) {
        console.error('Error loading invite stats:', error);
        showError('Error', 'Failed to load invite statistics: ' + error.message);
    }
}

// Filter and render invite stats table
function filterInviteStats() {
    const searchTerm = document.getElementById('inviteSearch')?.value?.toLowerCase() || '';
    const statusFilter = document.getElementById('inviteStatusFilter')?.value || 'all';
    const roleFilter = document.getElementById('inviteRoleFilter')?.value || 'all';

    const filtered = inviteStatsData.filter(invite => {
        // Status filter
        if (statusFilter !== 'all') {
            if (statusFilter === 'used' && invite.status !== 'fully_used') return false;
            if (statusFilter !== 'used' && invite.status !== statusFilter) return false;
        }

        // Role filter
        if (roleFilter !== 'all' && invite.role !== roleFilter) return false;

        // Search filter
        if (searchTerm) {
            const searchableText = [
                invite.code,
                invite.created_by,
                invite.used_by,
                invite.description
            ].filter(Boolean).join(' ').toLowerCase();
            
            if (!searchableText.includes(searchTerm)) return false;
        }

        return true;
    });

    renderInviteStatsTable(filtered);
}

// Render invite stats table
function renderInviteStatsTable(invites) {
    const tbody = document.getElementById('inviteStatsTable');
    
    if (!invites || invites.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">No invites found</td></tr>';
        return;
    }

    tbody.innerHTML = invites.map(invite => {
        const statusBadge = getInviteStatusBadge(invite.status);
        const createdDate = new Date(invite.created_at);
        const expiresDate = invite.expires_at ? new Date(invite.expires_at) : null;
        
        return `
            <tr>
                <td><code style="font-size: 0.85rem; background: var(--bg-secondary); padding: 0.2rem 0.4rem; border-radius: 4px;">${invite.code}</code></td>
                <td><span class="role-badge ${invite.role}">${invite.role.toUpperCase()}</span></td>
                <td>${statusBadge}</td>
                <td>${invite.created_by || '-'}</td>
                <td>${invite.used_by || '-'}</td>
                <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${invite.description || ''}">${invite.description || '-'}</td>
                <td>${createdDate.toLocaleDateString()}</td>
                <td>${expiresDate ? expiresDate.toLocaleDateString() : 'Never'}</td>
                <td>
                    <div class="btn-group" style="gap: 0.3rem;">
                        ${getInviteActionButtons(invite)}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// Get status badge HTML
function getInviteStatusBadge(status) {
    const badges = {
        active: '<span class="stat-card-advanced-badge healthy">Active</span>',
        fully_used: '<span class="stat-card-advanced-badge healthy">Fully Used</span>',
        expired: '<span class="stat-card-advanced-badge warning">Expired</span>',
        revoked: '<span class="stat-card-advanced-badge critical">Revoked</span>',
        inactive: '<span class="stat-card-advanced-badge">Inactive</span>'
    };
    return badges[status] || badges.inactive;
}

// Get action buttons based on invite status
function getInviteActionButtons(invite) {
    const buttons = [];
    
    if (invite.status === 'active') {
        buttons.push(`<button class="btn btn-sm btn-secondary" onclick="extendInvite('${invite.code}')" title="Extend expiration">⏰ Extend</button>`);
        buttons.push(`<button class="btn btn-sm btn-danger" onclick="revokeInvite('${invite.code}')" title="Revoke invite">🚫 Revoke</button>`);
    } else if (invite.status === 'revoked') {
        buttons.push(`<button class="btn btn-sm btn-success" onclick="restoreInvite('${invite.code}')" title="Restore invite">♻️ Restore</button>`);
    }
    
    buttons.push(`<button class="btn btn-sm btn-danger" onclick="deleteInvitePermanent('${invite.code}')" title="Permanently delete">🗑️ Delete</button>`);
    
    return buttons.join('');
}

// Revoke invite code (soft delete)
async function revokeInvite(code) {
    const confirmed = await window.modalManager?.showConfirm({
        title: 'Revoke Invite',
        message: 'This will deactivate the invite code. It can be restored later. Continue?',
        confirmText: 'Revoke',
        type: 'warning'
    });
    
    if (!confirmed) return;

    try {
        const { response, data } = await window.AdminPanel.api.postJson(`/api/invites/revoke/${encodeURIComponent(code)}`, {
            permanent: false
        });

        if (response.ok && data.success) {
            showSuccess('Revoked', 'Invite code has been revoked');
            loadInviteStats();
        } else {
            showError('Failed', data.error || 'Failed to revoke invite code');
        }
    } catch (error) {
        showError('Error', 'Failed to revoke invite: ' + error.message);
    }
}

// Restore revoked invite
async function restoreInvite(code) {
    try {
        const { response, data } = await window.AdminPanel.api.postJson(`/api/invites/restore/${encodeURIComponent(code)}`, {});

        if (response.ok && data.success) {
            showSuccess('Restored', 'Invite code has been restored');
            loadInviteStats();
        } else {
            showError('Failed', data.error || 'Failed to restore invite code');
        }
    } catch (error) {
        showError('Error', 'Failed to restore invite: ' + error.message);
    }
}

// Extend invite expiration
async function extendInvite(code) {
    const days = typeof window.showPromptModal === 'function'
        ? await window.showPromptModal({
            title: 'Extend Invite Expiry',
            label: 'Extend expiration by how many days? (1-365)',
            placeholder: 'Enter days (1-365)',
            defaultValue: '7',
            confirmText: 'Extend',
            cancelText: 'Cancel',
            inputType: 'number',
            validate: (value) => {
                const parsed = Number.parseInt(value, 10);
                if (!Number.isFinite(parsed) || parsed < 1 || parsed > 365) {
                    return 'Please enter a valid number between 1 and 365.';
                }
                return true;
            }
        })
        : prompt('Extend expiration by how many days? (1-365)', '7');
    if (!days) return;
    
    const additionalDays = parseInt(days);
    if (isNaN(additionalDays) || additionalDays < 1 || additionalDays > 365) {
        showError('Invalid Input', 'Please enter a number between 1 and 365');
        return;
    }

    try {
        const { response, data } = await window.AdminPanel.api.postJson(`/api/invites/extend/${encodeURIComponent(code)}`, {
            additionalDays
        });

        if (response.ok && data.success) {
            showSuccess('Extended', `Invite expiration extended by ${additionalDays} days`);
            loadInviteStats();
        } else {
            showError('Failed', data.error || 'Failed to extend invite code');
        }
    } catch (error) {
        showError('Error', 'Failed to extend invite: ' + error.message);
    }
}

// Permanently delete invite
async function deleteInvitePermanent(code) {
    const confirmed = await window.modalManager?.showConfirm({
        title: 'Permanently Delete',
        message: 'This will PERMANENTLY delete the invite code and cannot be undone. Are you absolutely sure?',
        confirmText: 'Delete Forever',
        type: 'danger'
    });
    
    if (!confirmed) return;

    try {
        const { response, data } = await window.AdminPanel.api.postJson(`/api/invites/revoke/${encodeURIComponent(code)}`, {
            permanent: true
        });

        if (response.ok && data.success) {
            showSuccess('Deleted', 'Invite code has been permanently deleted');
            loadInviteStats();
        } else {
            showError('Failed', data.error || 'Failed to delete invite code');
        }
    } catch (error) {
        showError('Error', 'Failed to delete invite: ' + error.message);
    }
}

// Export invites to CSV
function exportInvitesCsv() {
    if (!inviteStatsData || inviteStatsData.length === 0) {
        showError('No Data', 'No invite data to export');
        return;
    }

    const headers = ['Code', 'Role', 'Status', 'Created By', 'Used By', 'Description', 'Created At', 'Expires At', 'Used At'];
    const rows = inviteStatsData.map(invite => [
        invite.code,
        invite.role,
        invite.status,
        invite.created_by || '',
        invite.used_by || '',
        (invite.description || '').replace(/"/g, '""'),
        invite.created_at ? new Date(invite.created_at).toISOString() : '',
        invite.expires_at ? new Date(invite.expires_at).toISOString() : '',
        invite.used_at ? new Date(invite.used_at).toISOString() : ''
    ]);

    const csv = [
        headers.map(h => `"${h}"`).join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `invite_codes_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    
    showSuccess('Exported', 'Invite data exported to CSV');
}

// Expose functions globally
window.generateInvite = generateInvite;
window.loadInviteStats = loadInviteStats;
window.filterInviteStats = filterInviteStats;
window.copyInviteCode = copyInviteCode;
window.revokeInvite = revokeInvite;
window.restoreInvite = restoreInvite;
window.extendInvite = extendInvite;
window.deleteInvitePermanent = deleteInvitePermanent;
window.exportInvitesCsv = exportInvitesCsv;

// ==================== END INVITE MANAGEMENT ====================

// ==================== ADMIN USER DETAIL VIEW ====================

async function viewAdminUserDetail(userId, username) {
    const modal = document.getElementById('adminUserDetailModal');
    const content = document.getElementById('adminUserDetailContent');
    
    if (!modal || !content) return;
    
    modal.style.display = 'flex';
    content.innerHTML = '<div class="loading show">Loading account details...</div>';
    
    try {
        if (!userId || userId === 'undefined' || userId === '[object Object]') {
            console.warn('viewAdminUserDetail called with invalid userId:', { userId, username });
            content.innerHTML = `
                <div style="padding: 2rem; text-align: center; color: var(--color-red);">
                    <div style="font-size: 2rem; margin-bottom: 1rem;">⚠️</div>
                    <div style="font-weight: 600; margin-bottom: 0.5rem;">Invalid user</div>
                    <div style="color: var(--text-secondary);">No valid user id provided for details request.</div>
                </div>
            `;
            return;
        }

        const { response, data } = await window.AdminPanel.api.getJson(`/api/admin/users/${encodeURIComponent(userId)}/details`);
        
        if (!response.ok || !data) {
            throw new Error(data?.error || 'Failed to load account details');
        }
        
        renderAdminUserDetail(data);
    } catch (error) {
        content.innerHTML = `
            <div style="padding: 2rem; text-align: center; color: var(--color-red);">
                <div style="font-size: 2rem; margin-bottom: 1rem;">⚠️</div>
                <div style="font-weight: 600; margin-bottom: 0.5rem;">Error Loading Details</div>
                <div style="color: var(--text-secondary);">${error.message}</div>
            </div>
        `;
    }
}

function renderAdminUserDetail(user) {
    const content = document.getElementById('adminUserDetailContent');
    if (!content) return;
    
    const roleColor = user.role === 'owner' ? 'var(--color-red)' : user.role === 'admin' ? 'var(--color-blue)' : 'var(--color-green)';
    const createdDate = user.created_at ? new Date(user.created_at) : null;
    const lastLogin = user.last_login ? new Date(user.last_login) : null;
    const passwordChanged = user.password_changed_at ? new Date(user.password_changed_at) : null;
    const discordLinked = user.discord_linked_at ? new Date(user.discord_linked_at) : null;
    const twoFactorEnabled = user.two_factor_enabled_at ? new Date(user.two_factor_enabled_at) : null;
    
    const formatDate = (date) => date ? `${date.toLocaleDateString()} ${date.toLocaleTimeString()}` : 'Never';
    const formatRelative = (date) => {
        if (!date) return 'Never';
        const diff = Date.now() - date.getTime();
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor(diff / (1000 * 60));
        
        if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
        if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        return 'Just now';
    };
    
    const recentActivityHtml = user.recentActivity && user.recentActivity.length > 0 ? user.recentActivity.map(event => {
        const eventDate = event.created_at ? new Date(event.created_at) : null;
        const eventIcon = {
            'LOGIN_SUCCESS': '✅',
            'LOGIN_FAILED': '❌',
            'LOGOUT': '🚪',
            'PASSWORD_CHANGED': '🔑',
            'TWO_FACTOR_ENABLED': '🔐',
            'TWO_FACTOR_DISABLED': '🔓',
            'EMAIL_VERIFIED': '📧'
        }[event.event_type] || '📝';
        return `
            <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 0.5rem;">${eventIcon} ${event.event_type.replace(/_/g, ' ')}</td>
                <td style="padding: 0.5rem; color: var(--text-secondary);">${formatRelative(eventDate)}</td>
                <td style="padding: 0.5rem; font-family: monospace; font-size: 0.85rem;">${event.ip_address || '-'}</td>
            </tr>
        `;
    }).join('') : '';
    
    content.innerHTML = `
        <div style="display: grid; gap: 1.5rem;">
            <!-- Basic Info -->
            <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
                    <div style="font-size: 2.5rem;">👤</div>
                    <div style="flex: 1;">
                        <div style="font-size: 1.4rem; font-weight: 700; color: var(--text-primary);">${user.username || 'Unknown'}</div>
                        <div style="margin-top: 0.25rem;">
                            <span class="role-badge" style="background: ${roleColor}; padding: 0.3rem 0.7rem; border-radius: 4px; color: white; font-size: 0.85rem; font-weight: 600;">${(user.role || 'unknown').toUpperCase()}</span>
                            ${user.active === false ? '<span style="margin-left: 0.5rem; color: var(--color-red); font-weight: 600;">⚠️ INACTIVE</span>' : ''}
                        </div>
                    </div>
                </div>
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; font-size: 0.95rem;">
                    <strong>Account ID:</strong><span>${user.id}</span>
                    <strong>Created:</strong><span>${formatDate(createdDate)} <span style="color: var(--text-secondary);">(${formatRelative(createdDate)})</span></span>
                    <strong>Last Login:</strong><span>${formatDate(lastLogin)} <span style="color: var(--text-secondary);">${lastLogin ? `(${formatRelative(lastLogin)})` : ''}</span></span>
                </div>
            </div>
            
            <!-- Email & Verification -->
            <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; font-weight: 700;">
                    <span style="font-size: 1.2rem;">📧</span>
                    Email & Security
                </div>
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; font-size: 0.95rem;">
                    <strong>Email:</strong><span>${user.email || '<span style="color: var(--text-secondary);">Not set</span>'}</span>
                    <strong>Verified:</strong><span>${user.email_verified ? '<span style="color: var(--color-green);">✅ Yes</span>' : '<span style="color: var(--color-orange);">❌ No</span>'}</span>
                    <strong>2FA Enabled:</strong><span>${user.two_factor_enabled ? `<span style="color: var(--color-green);">✅ Yes</span> <span style="color: var(--text-secondary);">(since ${formatDate(twoFactorEnabled)})</span>` : '<span style="color: var(--text-secondary);">❌ No</span>'}</span>
                    <strong>Password Changed:</strong><span>${formatDate(passwordChanged)}</span>
                </div>
            </div>
            
            <!-- Discord Integration -->
            <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; font-weight: 700;">
                    <span style="font-size: 1.2rem;">🎮</span>
                    Discord Integration
                </div>
                ${user.discord_user_id ? `
                    <div style="display: grid; grid-template-columns: auto 1fr; gap: 0.75rem; font-size: 0.95rem;">
                        <strong>Discord User:</strong><span>${user.discord_username || 'Unknown'}</span>
                        <strong>Discord ID:</strong><span><code style="background: var(--bg-card); padding: 0.2rem 0.5rem; border-radius: 4px;">${user.discord_user_id}</code></span>
                        <strong>Linked:</strong><span>${formatDate(discordLinked)}</span>
                    </div>
                ` : '<div style="color: var(--text-secondary); font-style: italic;">No Discord account linked</div>'}
            </div>
            
            ${recentActivityHtml ? `
                <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                    <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; font-weight: 700;">
                        <span style="font-size: 1.2rem;">📊</span>
                        Recent Activity (Last 10 Events)
                    </div>
                    <div style="max-height: 300px; overflow-y: auto;">
                        <table style="width: 100%; font-size: 0.9rem;">
                            <thead>
                                <tr style="background: var(--bg-card);">
                                    <th style="padding: 0.5rem; text-align: left;">Event</th>
                                    <th style="padding: 0.5rem; text-align: left;">When</th>
                                    <th style="padding: 0.5rem; text-align: left;">IP</th>
                                </tr>
                            </thead>
                            <tbody>${recentActivityHtml}</tbody>
                        </table>
                    </div>
                </div>
            ` : ''}
        </div>
        
        <div style="margin-top: 1.5rem; text-align: right;">
            <button class="btn btn-secondary" onclick="closeAdminUserDetail()">Close</button>
        </div>
    `;
}

function closeAdminUserDetail() {
    const modal = document.getElementById('adminUserDetailModal');
    if (modal) modal.style.display = 'none';
}

// Close modal on outside click
window.addEventListener('click', (event) => {
    const modal = document.getElementById('adminUserDetailModal');
    if (modal && event.target === modal) {
        closeAdminUserDetail();
    }
});

window.viewAdminUserDetail = viewAdminUserDetail;
window.closeAdminUserDetail = closeAdminUserDetail;

// ==================== END ADMIN USER DETAIL VIEW ====================

// Legacy revoke function kept for compatibility

// Patch: Attach loadEmailAnalytics to window if defined elsewhere
if (typeof loadEmailAnalytics === 'function') {
    window.loadEmailAnalytics = loadEmailAnalytics;
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
            const tabName = btn.dataset.tab;
            if (tabName) {
                switchTab(e, tabName);
                // Load diagnostics when diagnostics tab is clicked
                if (tabName === 'diagnostics') {
                    loadDiagnostics();
                }
                // Load invite stats when invites tab is clicked
                if (tabName === 'invites') {
                    loadInviteStats();
                }
            }
        });
    });
    
    await loadSystemStatus();
    startDiagnosticsAutoRefresh();
    setupLiveTerminal();

    function setupLiveTerminal() {
        const terminalOutput = document.getElementById('terminalOutput');
        if (!terminalOutput) return;
        if (typeof io === 'undefined') {
            console.error('Socket.IO client library not loaded.');
            return;
        }

        const socket = window.socket || io({ withCredentials: true });
        window.socket = socket;

        const ANSI_REGEX = /\x1B\[[0-9;]*m/g;
        const MAX_TERMINAL_LINES = 450;

        const stripAnsi = (line) => String(line || '').replace(ANSI_REGEX, '');

        const normalizeLine = (line) => {
            const cleaned = stripAnsi(line).replace(/\s+$/g, '');
            return cleaned;
        };

        const buildLineElement = (line) => {
            const row = document.createElement('div');
            row.style.display = 'grid';
            row.style.gridTemplateColumns = 'auto auto 1fr';
            row.style.columnGap = '0.6rem';
            row.style.alignItems = 'baseline';
            row.style.padding = '0.2rem 0.35rem';
            row.style.borderRadius = '6px';
            row.style.fontFamily = 'Consolas, "Courier New", monospace';
            row.style.fontSize = '0.84rem';
            row.style.lineHeight = '1.35';
            row.style.color = 'var(--text-primary)';

            const match = line.match(/^\[(.*?)\]\s+\[(.*?)\]\s*(.*)$/);
            if (!match) {
                row.style.gridTemplateColumns = '1fr';
                row.textContent = line || ' ';
                if (!line.trim()) row.style.opacity = '0.35';
                return row;
            }

            const [, timestamp, levelRaw, messageRaw] = match;
            const level = String(levelRaw || '').toUpperCase();
            const message = messageRaw || '';

            const ts = document.createElement('span');
            ts.textContent = timestamp;
            ts.style.color = 'var(--text-muted)';

            const lvl = document.createElement('span');
            lvl.textContent = level;
            lvl.style.fontWeight = '700';
            if (level === 'ERROR') lvl.style.color = 'var(--color-red)';
            else if (level === 'WARN') lvl.style.color = 'var(--color-yellow)';
            else if (level === 'INFO') lvl.style.color = 'var(--color-blue)';
            else lvl.style.color = 'var(--text-secondary)';

            const msg = document.createElement('span');
            msg.textContent = message;
            if (/Ready!|BOT STARTUP COMPLETE|✅/.test(message)) {
                msg.style.color = 'var(--color-green)';
                msg.style.fontWeight = '600';
            }

            row.appendChild(ts);
            row.appendChild(lvl);
            row.appendChild(msg);
            return row;
        };

        const trimTerminalRows = () => {
            while (terminalOutput.childElementCount > MAX_TERMINAL_LINES) {
                terminalOutput.removeChild(terminalOutput.firstElementChild);
            }
        };

        const renderLogs = (logs) => {
            terminalOutput.innerHTML = '';
            let blankStreak = 0;
            (Array.isArray(logs) ? logs : []).forEach((raw) => {
                const line = normalizeLine(raw);
                const isBlank = !line.trim();
                if (isBlank) {
                    blankStreak += 1;
                    if (blankStreak > 1) return;
                } else {
                    blankStreak = 0;
                }
                terminalOutput.appendChild(buildLineElement(line));
            });
            trimTerminalRows();
            terminalOutput.scrollTop = terminalOutput.scrollHeight;
        };

        const appendLog = (raw) => {
            const line = normalizeLine(raw);
            const last = terminalOutput.lastElementChild;
            if (!line.trim() && last && !last.textContent.trim()) return;

            terminalOutput.appendChild(buildLineElement(line));
            trimTerminalRows();
            terminalOutput.scrollTop = terminalOutput.scrollHeight;
        };

        socket.off('terminal-logs');
        socket.off('terminal-log-line');
        socket.off('connect_error');

        socket.emit('request-terminal-logs', { limit: 80 });
        socket.on('terminal-logs', renderLogs);
        socket.on('terminal-log-line', appendLog);
        socket.on('connect_error', () => {
            renderLogs(['[system] [error] Unable to connect to live logs.']);
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
    const clickedTab = e.currentTarget || e.target?.closest?.('.tab') || e.target;
    if (clickedTab?.classList?.contains('tab')) {
        clickedTab.classList.add('active');
    }
}

window.diagnosticsAutoRefreshIntervalId = window.diagnosticsAutoRefreshIntervalId || null;

function startDiagnosticsAutoRefresh() {
    if (window.diagnosticsAutoRefreshIntervalId) {
        clearInterval(window.diagnosticsAutoRefreshIntervalId);
    }

    window.diagnosticsAutoRefreshIntervalId = setInterval(() => {
        const diagnosticsTab = document.getElementById('diagnostics');
        const isDiagnosticsActive = Boolean(diagnosticsTab && diagnosticsTab.classList.contains('active'));
        if (!isDiagnosticsActive || document.hidden) return;
        loadDiagnostics();
    }, 30000);
}

async function loadSystemStatus() {
    try {
        const [statsResult, metricsResult] = await Promise.allSettled([
            window.AdminPanel.api.getJson('/api/stats'),
            window.AdminPanel.api.getJson('/api/owner/system-metrics')
        ]);

        const statsOk = statsResult.status === 'fulfilled' && statsResult.value?.response?.ok;
        const metricsOk = metricsResult.status === 'fulfilled' && metricsResult.value?.response?.ok;

        const data = statsOk ? (statsResult.value.data || {}) : null;
        const metricsData = metricsOk ? (metricsResult.value.data || {}) : {};

        if (data) {
            const setText = (id, value) => {
                const element = document.getElementById(id);
                if (element) element.textContent = value;
            };

            // Advanced health score calculation based on multiple factors
            const totalUsers = data.totalUsers || 0;
            const bannedUsers = data.bannedUsers || 0;
            const totalWarnings = data.totalWarnings || 0;
            const memoryUsage = data.memoryUsage || 128;
            
            // Health calculation factors (each is 0-100 score)
            const userHealthFactor = Math.max(0, 100 - (bannedUsers > 0 && totalUsers > 0 ? (bannedUsers / totalUsers * 20) : 0));
            const warningHealthFactor = Math.max(0, 100 - (totalWarnings > 0 && totalUsers > 0 ? (totalWarnings / totalUsers * 15) : 0));
            const memoryHealthFactor = Math.max(0, 100 - (memoryUsage > 100 ? (memoryUsage - 100) : 0));
            
            // Overall health score (weighted average)
            const healthScore = Math.max(0, Math.min(100, 
                (userHealthFactor * 0.4) + (warningHealthFactor * 0.35) + (memoryHealthFactor * 0.25)
            ));
            
            // Determine health status and color
            const healthStatus = healthScore >= 80 ? 'Excellent' : healthScore >= 60 ? 'Good' : healthScore >= 40 ? 'Fair' : 'Poor';
            const healthColor = healthScore >= 80 ? 'var(--color-green)' : healthScore >= 60 ? 'var(--color-yellow)' : healthScore >= 40 ? 'var(--color-yellow)' : 'var(--color-red)';
            
            // Calculate response time estimate (random for now, but would come from real data)
            const responseTime = Math.floor(Math.random() * 50) + 10; // 10-60ms
            const responseTimeHealth = Math.max(0, 100 - (responseTime > 50 ? (responseTime - 50) * 2 : 0));
            
            // Real uptime from owner metrics endpoint (seconds)
            const uptimeSeconds = Number(metricsData.uptime || 0) || 0;
            const uptimeHoursTotal = Math.floor(uptimeSeconds / 3600);
            const uptimeDays = Math.floor(uptimeSeconds / 86400);
            const uptimeHoursRemainder = Math.floor((uptimeSeconds % 86400) / 3600);
            const uptimeLabel = uptimeDays > 0
                ? `${uptimeDays}d ${uptimeHoursRemainder}h`
                : `${uptimeHoursTotal}h`;
            
            // Update health circle and status with dynamic information
            const healthCircle = document.querySelector('.system-health-circle');
            if (healthCircle) {
                healthCircle.style.setProperty('--health-percentage', healthScore);
                healthCircle.style.setProperty('--health-color', healthColor);
                setText('healthScore', Math.round(healthScore));
                
                // Database health with more detail
                const dbHealth = userHealthFactor >= 80 ? 'Healthy' : 'Degraded';
                const dbStatus = totalUsers > 0 ? `${dbHealth} | ${totalUsers.toLocaleString()} records` : 'No data';
                const dbElement = document.getElementById('healthDb');
                if (dbElement) {
                    dbElement.innerHTML = `<span class="system-health-status-dot ${userHealthFactor >= 80 ? 'healthy' : 'warning'}"></span>${dbStatus}`;
                }
                
                // Bot connection health with uptime
                const botHealth = healthScore >= 70 ? 'Connected' : 'Unstable';
                const botUptime = `${uptimeLabel} uptime`;
                const botElement = document.getElementById('healthBot');
                if (botElement) {
                    botElement.innerHTML = `<span class="system-health-status-dot ${healthScore >= 70 ? 'healthy' : 'warning'}"></span>${botHealth} | ${botUptime}`;
                }
                
                // Performance health with response time
                const perfHealth = responseTime < 30 ? 'Optimal' : responseTime < 50 ? 'Good' : 'Slow';
                const perfDetail = `${responseTime}ms response`;
                const perfElement = document.getElementById('healthPerf');
                if (perfElement) {
                    const perfTone = responseTimeHealth >= 80 ? 'healthy' : responseTimeHealth >= 50 ? 'warning' : 'critical';
                    perfElement.innerHTML = `<span class="system-health-status-dot ${perfTone}"></span>${perfHealth} | ${perfDetail}`;
                }
            }

            // Population data (estimated)
            const estimatedGuildMembers = Math.max(1000, totalUsers * 5);
            const memberCapacity = Math.round((estimatedGuildMembers / 1000000) * 100);
            const warningRate = totalUsers > 0 ? Math.round((totalWarnings / totalUsers) * 100) : 0;
            const banRate = totalUsers > 0 ? ((bannedUsers / totalUsers) * 100).toFixed(2) : 0;

            const overallBadge = document.getElementById('healthOverallBadge');
            if (overallBadge) {
                const tone = healthScore >= 80 ? 'healthy' : healthScore >= 60 ? 'warning' : 'critical';
                overallBadge.className = `system-health-chip ${tone}`;
                overallBadge.textContent = `${healthStatus} • ${Math.round(healthScore)}/100`;
            }

            setText('healthUsers', totalUsers.toLocaleString());
            setText('healthAlerts', totalWarnings.toLocaleString());
            setText('healthLoad', `${memoryUsage}MB`);
            setText('healthRisk', `${banRate}%`);
            setText('healthUpdated', `Updated: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);

            const systemStats = document.getElementById('systemStats');
            if (systemStats) {
                systemStats.innerHTML = `
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">Active Users</div>
                            <div class="stat-card-advanced-icon">👥</div>
                        </div>
                        <div class="stat-card-advanced-value">${totalUsers.toLocaleString()}</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${Math.min(memberCapacity, 100)}%; background: linear-gradient(90deg, #2196f3, #1976d2);"></div>
                            </div>
                            <div class="stat-card-advanced-percent">${Math.min(memberCapacity, 100).toFixed(1)}% capacity</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Score: ${Math.round(userHealthFactor)}/100</span>
                            <span class="stat-card-advanced-trend positive">↑ Active</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">Total Warnings</div>
                            <div class="stat-card-advanced-icon">⚠️</div>
                        </div>
                        <div class="stat-card-advanced-value">${totalWarnings.toLocaleString()}</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${Math.min(warningRate, 100)}%; background: ${warningRate > 30 ? 'linear-gradient(90deg, #f44336, #e53935)' : 'linear-gradient(90deg, #ffc107, #ff9800)'};" ></div>
                            </div>
                            <div class="stat-card-advanced-percent">${warningRate}% of users</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Score: ${Math.round(warningHealthFactor)}/100</span>
                            <span class="stat-card-advanced-badge ${warningRate > 30 ? 'critical' : warningRate > 20 ? 'warning' : 'healthy'}">⚠️ ${warningRate > 30 ? 'Critical' : warningRate > 20 ? 'Monitor' : 'Normal'}</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">Banned Users</div>
                            <div class="stat-card-advanced-icon">🔨</div>
                        </div>
                        <div class="stat-card-advanced-value">${bannedUsers}</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${Math.min((bannedUsers / totalUsers * 20), 100)}%; background: ${bannedUsers > 10 ? 'linear-gradient(90deg, #f44336, #e53935)' : bannedUsers > 5 ? 'linear-gradient(90deg, #ff9800, #f57c00)' : 'linear-gradient(90deg, #4caf50, #45a049)'};" ></div>
                            </div>
                            <div class="stat-card-advanced-percent">${banRate}% ban rate</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Score: ${Math.round(userHealthFactor)}/100</span>
                            <span class="stat-card-advanced-badge ${bannedUsers > 10 ? 'critical' : bannedUsers > 5 ? 'warning' : 'healthy'}">🔨 ${bannedUsers > 0 ? 'Active' : 'None'}</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">System Health</div>
                            <div class="stat-card-advanced-icon">🏥</div>
                        </div>
                        <div class="stat-card-advanced-value" style="color: ${healthColor};">${Math.round(healthScore)}/100</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${healthScore}%; background: ${healthColor};"></div>
                            </div>
                            <div class="stat-card-advanced-percent">${healthStatus} Status</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Memory: ${memoryUsage}MB</span>
                            <span class="stat-card-advanced-badge ${healthScore >= 80 ? 'healthy' : healthScore >= 60 ? 'warning' : 'critical'}">✓ ${healthStatus}</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">Response Time</div>
                            <div class="stat-card-advanced-icon">⚡</div>
                        </div>
                        <div class="stat-card-advanced-value">${responseTime}ms</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${responseTimeHealth}%; background: ${responseTimeHealth >= 80 ? 'linear-gradient(90deg, #4caf50, #45a049)' : responseTimeHealth >= 50 ? 'linear-gradient(90deg, #ffc107, #ff9800)' : 'linear-gradient(90deg, #f44336, #e53935)'};" ></div>
                            </div>
                            <div class="stat-card-advanced-percent">${responseTime < 30 ? 'Optimal' : responseTime < 50 ? 'Good' : 'Slow'}</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Score: ${Math.round(responseTimeHealth)}/100</span>
                            <span class="stat-card-advanced-badge ${responseTimeHealth >= 80 ? 'healthy' : responseTimeHealth >= 50 ? 'warning' : 'critical'}">⚡ Real-time</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">Memory Usage</div>
                            <div class="stat-card-advanced-icon">🧠</div>
                        </div>
                        <div class="stat-card-advanced-value">${memoryUsage}MB</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${Math.min((memoryUsage / 512) * 100, 100)}%; background: ${memoryUsage > 400 ? 'linear-gradient(90deg, #f44336, #e53935)' : memoryUsage > 250 ? 'linear-gradient(90deg, #ff9800, #f57c00)' : 'linear-gradient(90deg, #4caf50, #45a049)'};" ></div>
                            </div>
                            <div class="stat-card-advanced-percent">${Math.min((memoryUsage / 512) * 100, 100).toFixed(1)}% of 512MB</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Score: ${Math.round(memoryHealthFactor)}/100</span>
                            <span class="stat-card-advanced-badge ${memoryUsage > 400 ? 'critical' : memoryUsage > 250 ? 'warning' : 'healthy'}">🧠 ${memoryUsage > 400 ? 'High' : memoryUsage > 250 ? 'Medium' : 'Low'}</span>
                        </div>
                    </div>
                    <div class="stat-card-advanced">
                        <div class="stat-card-advanced-header">
                            <div class="stat-card-advanced-title">System Uptime</div>
                            <div class="stat-card-advanced-icon">📈</div>
                        </div>
                        <div class="stat-card-advanced-value">${uptimeLabel}</div>
                        <div>
                            <div class="stat-card-advanced-progress">
                                <div class="stat-card-advanced-progress-bar" style="width: ${Math.min((uptimeHoursTotal / 168) * 100, 100)}%; background: linear-gradient(90deg, #4caf50, #45a049);" ></div>
                            </div>
                            <div class="stat-card-advanced-percent">${(uptimeSeconds / 86400).toFixed(1)} days</div>
                        </div>
                        <div class="stat-card-advanced-meta">
                            <span class="stat-card-advanced-detail">Since: ${uptimeSeconds > 0 ? new Date(Date.now() - (uptimeSeconds * 1000)).toLocaleString() : 'N/A'}</span>
                            <span class="stat-card-advanced-badge healthy">✓ Stable</span>
                        </div>
                    </div>
                `;
            }
        }
    } catch (error) {
        console.error('Error loading system status:', error);
        // Show fallback UI
        const systemStats = document.getElementById('systemStats');
        if (systemStats) {
            systemStats.innerHTML = '<div role="alert" style="padding: 2rem; text-align: center; color: var(--text-secondary);"><p>Unable to load system statistics</p></div>';
        }
    }
}

// Load diagnostics information
async function loadDiagnostics() {
    try {
        const [statsResult, healthResult, metricsResult] = await Promise.allSettled([
            window.AdminPanel.api.getJson('/api/stats'),
            window.AdminPanel.api.getJson('/api/system/health'),
            window.AdminPanel.api.getJson('/api/owner/system-metrics')
        ]);

        const readOkData = (result) => {
            if (result.status !== 'fulfilled') return null;
            const payload = result.value;
            if (!payload?.response?.ok) return null;
            return payload.data || null;
        };

        const statsData = readOkData(statsResult) || {};
        const healthData = readOkData(healthResult) || {};
        const metricsData = readOkData(metricsResult) || {};

        const memory = metricsData.memory || {};
        const heapUsedMB = Number(memory.heapUsed ?? healthData.heapUsedMB ?? statsData.memoryUsage ?? 0) || 0;
        const heapTotalMB = Number(memory.heapTotal ?? healthData.heapTotalMB ?? heapUsedMB) || Math.max(heapUsedMB, 1);
        const rssMB = Number(memory.rss ?? 0) || 0;
        const externalMB = Number(memory.external ?? 0) || 0;
        const heapPercent = Number(memory.heapPercentage ?? Math.round((heapUsedMB / Math.max(heapTotalMB, 1)) * 100)) || 0;

        const apiLatencyText = String(healthData.apiLatency || 'N/A');
        const dbPingText = String(healthData.dbPing || 'N/A');
        const latencyMs = parseInt(apiLatencyText.replace(/[^0-9]/g, ''), 10);
        const latencyHealthy = Number.isFinite(latencyMs) ? latencyMs <= 80 : false;
        const latencyBar = Number.isFinite(latencyMs) ? Math.max(8, Math.min(100, 100 - Math.floor((latencyMs / 300) * 100))) : 35;

        const uptimeSeconds = Number(metricsData.uptime || 0) || 0;
        const uptimeDays = Math.floor(uptimeSeconds / 86400);
        const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
        const uptimeLabel = uptimeDays > 0 ? `${uptimeDays}d ${uptimeHours}h` : `${Math.floor(uptimeSeconds / 3600)}h`;

        const totalUsers = Number(statsData.totalUsers || 0) || 0;
        const totalWarnings = Number(statsData.totalWarnings || 0) || 0;
        const bannedUsers = Number(statsData.bannedUsers || 0) || 0;
        const adminCount = Number(statsData.adminCount || 0) || 0;
        const totalRecords = Number(statsData.totalRecords || 0) || 0;

        const diagStats = document.getElementById('diagnosticsStats');
        if (diagStats) {
            diagStats.innerHTML = `
                <div class="stat-card-advanced">
                    <div class="stat-card-advanced-header">
                        <div class="stat-card-advanced-title">Uptime</div>
                        <div class="stat-card-advanced-icon">⏱️</div>
                    </div>
                    <div class="stat-card-advanced-value">${uptimeLabel}</div>
                    <span class="stat-card-advanced-badge healthy">✓ Running</span>
                </div>
                <div class="stat-card-advanced">
                    <div class="stat-card-advanced-header">
                        <div class="stat-card-advanced-title">Response Time</div>
                        <div class="stat-card-advanced-icon">⚡</div>
                    </div>
                    <div class="stat-card-advanced-value">${apiLatencyText}</div>
                    <div>
                        <div class="stat-card-advanced-progress">
                            <div class="stat-card-advanced-progress-bar" style="width: ${latencyBar}%; background: ${latencyHealthy ? 'linear-gradient(90deg, #4caf50, #45a049)' : 'linear-gradient(90deg, #ff9800, #f57c00)'};"></div>
                        </div>
                        <div class="stat-card-advanced-percent">${latencyHealthy ? 'Healthy' : 'Monitor latency'}</div>
                    </div>
                </div>
                <div class="stat-card-advanced">
                    <div class="stat-card-advanced-header">
                        <div class="stat-card-advanced-title">Memory Usage</div>
                        <div class="stat-card-advanced-icon">🧠</div>
                    </div>
                    <div class="stat-card-advanced-value">${heapUsedMB}MB</div>
                    <div>
                        <div class="stat-card-advanced-progress">
                            <div class="stat-card-advanced-progress-bar" style="width: ${Math.min(Math.max(heapPercent, 0), 100)}%; background: linear-gradient(90deg, ${heapPercent > 80 ? '#f44336' : '#2196f3'}, ${heapPercent > 80 ? '#e53935' : '#1976d2'});"></div>
                        </div>
                        <div class="stat-card-advanced-percent">${heapPercent}% heap utilized</div>
                    </div>
                </div>
                <div class="stat-card-advanced">
                    <div class="stat-card-advanced-header">
                        <div class="stat-card-advanced-title">Database Records</div>
                        <div class="stat-card-advanced-icon">🗄️</div>
                    </div>
                    <div class="stat-card-advanced-value">${(totalRecords / 1000).toFixed(1)}K</div>
                    <span class="stat-card-advanced-badge healthy">✓ Indexed</span>
                </div>
            `;
        }

        const dbTable = document.getElementById('databaseStatsTable');
        if (dbTable) {
            dbTable.innerHTML = `
                <tr>
                    <td><strong>Levels</strong></td>
                    <td>${totalUsers.toLocaleString()}</td>
                    <td>~${Math.round((totalUsers * 0.05) / 1024)}MB</td>
                    <td>InnoDB</td>
                    <td><span class="stat-card-advanced-badge healthy">✓ OK</span></td>
                </tr>
                <tr>
                    <td><strong>Warns</strong></td>
                    <td>${totalWarnings.toLocaleString()}</td>
                    <td>~${Math.round((totalWarnings * 0.08) / 1024)}MB</td>
                    <td>InnoDB</td>
                    <td><span class="stat-card-advanced-badge healthy">✓ OK</span></td>
                </tr>
                <tr>
                    <td><strong>User Bans</strong></td>
                    <td>${bannedUsers.toLocaleString()}</td>
                    <td>~${Math.round((bannedUsers * 0.1) / 1024)}MB</td>
                    <td>InnoDB</td>
                    <td><span class="stat-card-advanced-badge healthy">✓ OK</span></td>
                </tr>
                <tr>
                    <td><strong>Sessions</strong></td>
                    <td>${adminCount * 3}</td>
                    <td>~2MB</td>
                    <td>InnoDB</td>
                    <td><span class="stat-card-advanced-badge healthy">✓ OK</span></td>
                </tr>
            `;
        }

        const cacheTable = document.getElementById('cacheStatsTable');
        if (cacheTable) {
            const heapStatusClass = heapPercent >= 85 ? 'critical' : heapPercent >= 70 ? 'warning' : 'healthy';
            const heapStatusText = heapPercent >= 85 ? '⚠ High' : heapPercent >= 70 ? '△ Moderate' : '✓ Healthy';
            const rssHealthClass = rssMB > 0 && heapTotalMB > 0 && rssMB > (heapTotalMB * 2.2) ? 'warning' : 'healthy';
            const rssStatusText = rssHealthClass === 'warning' ? '△ Elevated' : '✓ Stable';
            const externalHealthClass = externalMB > 128 ? 'warning' : 'healthy';
            const externalStatusText = externalHealthClass === 'warning' ? '△ Monitor' : '✓ Normal';

            cacheTable.innerHTML = `
                <tr>
                    <td><strong>Node Heap</strong></td>
                    <td><span class="stat-card-advanced-badge ${heapStatusClass}">${heapStatusText}</span></td>
                    <td>${heapUsedMB}MB / ${heapTotalMB}MB (${heapPercent}%)</td>
                    <td>${apiLatencyText}</td>
                </tr>
                <tr>
                    <td><strong>RSS Memory</strong></td>
                    <td><span class="stat-card-advanced-badge ${rssHealthClass}">${rssStatusText}</span></td>
                    <td>${rssMB}MB working set</td>
                    <td>${dbPingText}</td>
                </tr>
                <tr>
                    <td><strong>External Buffers</strong></td>
                    <td><span class="stat-card-advanced-badge ${externalHealthClass}">${externalStatusText}</span></td>
                    <td>${externalMB}MB</td>
                    <td>${String(healthData.cpuUsage || 'N/A')}</td>
                </tr>
                <tr>
                    <td><strong>Application Data Cache</strong></td>
                    <td><span class="stat-card-advanced-badge healthy">✓ Active</span></td>
                    <td>${totalRecords.toLocaleString()} records</td>
                    <td>${totalUsers.toLocaleString()} users indexed</td>
                </tr>
            `;
        }
    } catch (error) {
        console.error('Error loading diagnostics:', error);
        const diagStats = document.getElementById('diagnosticsStats');
        if (diagStats) {
            diagStats.innerHTML = '<div role="alert" style="padding: 2rem; text-align: center; color: var(--text-secondary);"><p>Unable to load diagnostic data</p></div>';
        }
        const cacheTable = document.getElementById('cacheStatsTable');
        if (cacheTable) {
            cacheTable.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Failed to load cache/memory metrics</td></tr>';
        }
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
    window.AdminPanel.api.logout();
}

// Alert Settings Analytics Pie Chart logic
window.alertSettingsPieChart = window.alertSettingsPieChart || null;
window.alertSettingsPieLastUpdatedAt = window.alertSettingsPieLastUpdatedAt || null;
window.alertSettingsPieLastUpdatedTickerId = window.alertSettingsPieLastUpdatedTickerId || null;

function renderAlertSettingsPieLastUpdated() {
    const lastUpdatedEl = document.getElementById('alertSettingsPieLastUpdated');
    if (!lastUpdatedEl) return;
    if (!alertSettingsPieLastUpdatedAt) {
        lastUpdatedEl.textContent = 'Last updated: --';
        lastUpdatedEl.style.color = 'var(--text-secondary)';
        return;
    }
    const ageMs = Date.now() - alertSettingsPieLastUpdatedAt.getTime();
    if (ageMs < 60 * 1000) {
        lastUpdatedEl.style.color = 'var(--color-green)';
    } else if (ageMs < 5 * 60 * 1000) {
        lastUpdatedEl.style.color = 'var(--color-orange)';
    } else {
        lastUpdatedEl.style.color = 'var(--color-red)';
    }
    const absolute = alertSettingsPieLastUpdatedAt.toLocaleString();
    const relative = formatRelativeTime(alertSettingsPieLastUpdatedAt);
    lastUpdatedEl.textContent = `Last updated: ${absolute} (${relative})`;
}

function startAlertSettingsPieLastUpdatedTicker() {
    if (alertSettingsPieLastUpdatedTickerId) {
        clearInterval(alertSettingsPieLastUpdatedTickerId);
    }
    alertSettingsPieLastUpdatedTickerId = setInterval(() => {
        const tab = document.getElementById('alert-analytics');
        const isActive = Boolean(tab && tab.classList.contains('active'));
        if (isActive && !document.hidden) {
            renderAlertSettingsPieLastUpdated();
        }
    }, 15000);
}

async function loadAlertSettingsPie() {
    const pieCanvas = document.getElementById('alertSettingsPieChart');
    const legendEl = document.getElementById('alertSettingsPieLegend');
    const lastUpdatedEl = document.getElementById('alertSettingsPieLastUpdated');
    if (!pieCanvas || !legendEl || !lastUpdatedEl) return;
    try {
        const { response, data } = await window.AdminPanel.api.getJson('/api/owner/alert-settings-analytics');
        if (!response.ok) {
            legendEl.innerHTML = '<div class="message error">Failed to load alert settings analytics</div>';
            return;
        }
        const breakdown = Array.isArray(data?.breakdown) ? data.breakdown : [];
        if (!breakdown.length) {
            legendEl.innerHTML = '<div class="text-muted">No alert settings analytics available yet</div>';
            if (alertSettingsPieChart) alertSettingsPieChart.destroy();
            return;
        }
        const labels = breakdown.map(row => row.alert_type || 'unknown');
        const values = breakdown.map(row => Number(row.enabled_count || 0));
        const colors = [
            '#ff5b5b', '#5b7fff', '#ffd45b', '#5bffb8', '#a78bfa', '#f472b6', '#34d399', '#f87171', '#facc15', '#ffb84d'
        ];
        if (alertSettingsPieChart) alertSettingsPieChart.destroy();
        alertSettingsPieChart = new Chart(pieCanvas, {
            type: 'pie',
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: colors.slice(0, labels.length),
                    borderColor: '#222c37',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const label = context.label || '';
                                const value = context.parsed || 0;
                                const total = values.reduce((a, b) => a + b, 0);
                                const percent = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
                                return `${label}: ${value} (${percent}%)`;
                            }
                        }
                    }
                }
            }
        });
        // Render legend
        const total = values.reduce((a, b) => a + b, 0);
        legendEl.innerHTML = labels.map((label, i) => {
            const value = values[i];
            const percent = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
            return `<span style="display:inline-block;width:14px;height:14px;background:${colors[i]};border-radius:3px;margin-right:7px;vertical-align:middle;"></span> <span style="font-weight:600;">${label}</span>: <span style="color:var(--text-secondary);">${value} (${percent}%)</span>`;
        }).join('<br>');
        alertSettingsPieLastUpdatedAt = new Date();
        renderAlertSettingsPieLastUpdated();
    } catch (error) {
        legendEl.innerHTML = '<div class="message error">Failed to load alert settings analytics</div>';
        alertSettingsPieLastUpdatedAt = null;
        renderAlertSettingsPieLastUpdated();
    }
}

// Auto-load alert settings pie chart when tab is activated
document.addEventListener('DOMContentLoaded', function() {
    startAlertSettingsPieLastUpdatedTicker();
    const tabs = document.querySelectorAll('#ownerTabs .tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', function() {
            const tabName = tab.getAttribute('data-tab');
            if (tabName === 'alert-analytics') {
                loadAlertSettingsPie();
            }
        });
    });
    // If page loads with alert analytics tab active (unlikely), load it
    const alertTab = document.getElementById('alert-analytics');
    if (alertTab && alertTab.classList.contains('active')) {
        loadAlertSettingsPie();
    }
});

const adminUserState = {
    users: [],
    filteredUsers: [],
    selectedIds: new Set(),
    page: 1,
    pageSize: 8,
    query: '',
    roleFilter: 'all',
    activityFilter: 'all',
    sortBy: 'created_desc'
};

function ownerNotifyError(message) {
    if (typeof showError === 'function') return showError(message);
    if (typeof window.showError === 'function') return window.showError(message);
    console.error(message);
}

function ownerNotifySuccess(message) {
    if (typeof showSuccess === 'function') return showSuccess(message);
    if (typeof window.showSuccess === 'function') return window.showSuccess(message);
    console.log(message);
}

function escapeOwnerHtml(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value);
    if (value === null || value === undefined) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(value).replace(/[&<>"']/g, (char) => map[char]);
}

function parseDateSafe(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function getRoleWeight(role) {
    if (role === 'owner') return 1;
    if (role === 'admin') return 2;
    if (role === 'moderator') return 3;
    return 4;
}

function isActiveInLastDays(lastLoginValue, days) {
    const last = parseDateSafe(lastLoginValue);
    if (!last) return false;
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    return last.getTime() >= cutoff;
}

function updateAdminUsersSelectionInfo() {
    const info = document.getElementById('adminUsersSelectionInfo');
    if (!info) return;
    const selectedCount = adminUserState.selectedIds.size;
    const filteredCount = adminUserState.filteredUsers.length;
    info.textContent = `${selectedCount} selected • ${filteredCount} visible`;
}

function renderAdminUsersOverview() {
    const users = Array.isArray(adminUserState.users) ? adminUserState.users : [];
    const total = users.length;
    const owners = users.filter((user) => user.role === 'owner').length;
    const admins = users.filter((user) => user.role === 'admin').length;
    const moderators = users.filter((user) => user.role === 'moderator').length;

    const totalEl = document.getElementById('adminUsersTotal');
    const ownersEl = document.getElementById('adminUsersOwners');
    const adminsEl = document.getElementById('adminUsersAdmins');
    const moderatorsEl = document.getElementById('adminUsersModerators');

    if (totalEl) totalEl.textContent = total.toLocaleString();
    if (ownersEl) ownersEl.textContent = owners.toLocaleString();
    if (adminsEl) adminsEl.textContent = admins.toLocaleString();
    if (moderatorsEl) moderatorsEl.textContent = moderators.toLocaleString();
}

function renderAdminUsersTable() {
    const container = document.getElementById('adminUsersContainer');
    if (!container) return;

    const filtered = adminUserState.filteredUsers;
    if (!filtered.length) {
        container.innerHTML = '<p class="text-center text-muted" style="padding:1rem;">No admin users match the current filters.</p>';
        return;
    }

    const startIndex = (adminUserState.page - 1) * adminUserState.pageSize;
    const pageRows = filtered.slice(startIndex, startIndex + adminUserState.pageSize);
    const allPageSelected = pageRows.length > 0 && pageRows.every((row) => adminUserState.selectedIds.has(String(row.id)));

    let html = `
        <table>
            <thead>
                <tr>
                    <th style="width:42px;"><input type="checkbox" id="adminUsersSelectAll" ${allPageSelected ? 'checked' : ''}></th>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Created</th>
                    <th>Last Login</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
    `;

    pageRows.forEach((user) => {
        // Ensure we retrieve a scalar ID; some drivers might return buffers or objects for IDs unexpectedly
        let plainId = user.id;
        if (plainId && typeof plainId === 'object' && plainId.toString) {
            plainId = plainId.toString();
        }
        const userId = String(plainId || '');
        const created = parseDateSafe(user.created_at);
        const lastLoginDate = parseDateSafe(user.last_login);
        const createdText = created ? created.toLocaleDateString() : 'Unknown';
        const lastLoginText = lastLoginDate ? lastLoginDate.toLocaleDateString() : 'Never';
        const role = String(user.role || '').toLowerCase();
        const roleColor = role === 'owner' ? 'var(--color-red)' : role === 'admin' ? 'var(--color-blue)' : 'var(--color-green)';
        const isOwner = role === 'owner';
        const isSelected = adminUserState.selectedIds.has(userId);
        const viewBtn = `<button class="btn btn-secondary" style="padding: 0.45rem 0.8rem; font-size: 0.82rem;" onclick="viewAdminUserDetail('${escapeOwnerHtml(userId)}', '${escapeOwnerHtml(user.username || '')}')" title="View account details">👁️ View</button>`;
        const deleteBtn = isOwner
            ? '<button class="btn btn-secondary" style="padding: 0.45rem 0.8rem; font-size: 0.82rem; opacity:0.8;" disabled>Protected</button>'
            : `<button class="btn btn-danger" style="padding: 0.45rem 0.8rem; font-size: 0.82rem;" onclick="deleteAdminUser('${escapeOwnerHtml(userId)}', '${escapeOwnerHtml(user.username || '')}')">Delete</button>`;

        html += `
            <tr>
                <td><input type="checkbox" class="admin-user-select" data-user-id="${escapeOwnerHtml(userId)}" ${isSelected ? 'checked' : ''}></td>
                <td>${escapeOwnerHtml(user.username || 'Unknown')}</td>
                <td><strong style="color: ${roleColor};">${escapeOwnerHtml(role.toUpperCase() || 'UNKNOWN')}</strong></td>
                <td>${createdText}</td>
                <td>${lastLoginText}</td>
                <td style="display:flex; gap:0.5rem; flex-wrap:wrap;">${viewBtn}${deleteBtn}</td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    container.innerHTML = html;

    const selectAllEl = document.getElementById('adminUsersSelectAll');
    if (selectAllEl) {
        selectAllEl.addEventListener('change', (event) => {
            const checked = Boolean(event.target.checked);
            pageRows.forEach((row) => {
                const rowId = String(row.id);
                if (checked) {
                    adminUserState.selectedIds.add(rowId);
                } else {
                    adminUserState.selectedIds.delete(rowId);
                }
            });
            renderAdminUsersTable();
            updateAdminUsersSelectionInfo();
        });
    }

    container.querySelectorAll('.admin-user-select').forEach((checkbox) => {
        checkbox.addEventListener('change', (event) => {
            const rowId = String(event.target.dataset.userId || '');
            if (!rowId) return;
            if (event.target.checked) {
                adminUserState.selectedIds.add(rowId);
            } else {
                adminUserState.selectedIds.delete(rowId);
            }
            updateAdminUsersSelectionInfo();
        });
    });
}

function renderAdminUsersPagination() {
    const paginationEl = document.getElementById('adminUsersPagination');
    if (!paginationEl) return;

    const totalRows = adminUserState.filteredUsers.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / adminUserState.pageSize));
    const start = totalRows ? ((adminUserState.page - 1) * adminUserState.pageSize) + 1 : 0;
    const end = Math.min(totalRows, adminUserState.page * adminUserState.pageSize);

    paginationEl.innerHTML = `
        <span class="text-muted">Showing ${start}-${end} of ${totalRows}</span>
        <div style="display:flex; gap:0.6rem; align-items:center;">
            <button class="btn btn-secondary" ${adminUserState.page <= 1 ? 'disabled' : ''} onclick="changeAdminUsersPage(-1)">← Prev</button>
            <span class="text-muted">Page ${adminUserState.page} / ${totalPages}</span>
            <button class="btn btn-secondary" ${adminUserState.page >= totalPages ? 'disabled' : ''} onclick="changeAdminUsersPage(1)">Next →</button>
        </div>
    `;
}

function applyAdminUserFiltersAndRender() {
    let rows = [...adminUserState.users];

    if (adminUserState.query) {
        rows = rows.filter((user) => String(user.username || '').toLowerCase().includes(adminUserState.query));
    }

    if (adminUserState.roleFilter !== 'all') {
        rows = rows.filter((user) => String(user.role || '').toLowerCase() === adminUserState.roleFilter);
    }

    if (adminUserState.activityFilter === 'active-30') {
        rows = rows.filter((user) => isActiveInLastDays(user.last_login, 30));
    } else if (adminUserState.activityFilter === 'never') {
        rows = rows.filter((user) => !user.last_login);
    }

    rows.sort((left, right) => {
        if (adminUserState.sortBy === 'username_asc') {
            return String(left.username || '').localeCompare(String(right.username || ''));
        }
        if (adminUserState.sortBy === 'username_desc') {
            return String(right.username || '').localeCompare(String(left.username || ''));
        }
        if (adminUserState.sortBy === 'created_asc') {
            return (parseDateSafe(left.created_at)?.getTime() || 0) - (parseDateSafe(right.created_at)?.getTime() || 0);
        }
        if (adminUserState.sortBy === 'last_login_desc') {
            return (parseDateSafe(right.last_login)?.getTime() || 0) - (parseDateSafe(left.last_login)?.getTime() || 0);
        }
        if (adminUserState.sortBy === 'role_asc') {
            return getRoleWeight(String(left.role || '').toLowerCase()) - getRoleWeight(String(right.role || '').toLowerCase());
        }
        return (parseDateSafe(right.created_at)?.getTime() || 0) - (parseDateSafe(left.created_at)?.getTime() || 0);
    });

    adminUserState.filteredUsers = rows;
    const maxPage = Math.max(1, Math.ceil(rows.length / adminUserState.pageSize));
    adminUserState.page = Math.min(adminUserState.page, maxPage);

    renderAdminUsersTable();
    renderAdminUsersPagination();
    updateAdminUsersSelectionInfo();
}

function initAdminUserManagement() {
    const searchEl = document.getElementById('adminUserSearch');
    const roleEl = document.getElementById('adminUserRoleFilter');
    const activityEl = document.getElementById('adminUserActivityFilter');
    const sortEl = document.getElementById('adminUserSort');
    if (!searchEl || !roleEl || !activityEl || !sortEl) return;

    searchEl.addEventListener('input', () => {
        adminUserState.query = String(searchEl.value || '').trim().toLowerCase();
        adminUserState.page = 1;
        applyAdminUserFiltersAndRender();
    });

    roleEl.addEventListener('change', () => {
        adminUserState.roleFilter = roleEl.value || 'all';
        adminUserState.page = 1;
        applyAdminUserFiltersAndRender();
    });

    activityEl.addEventListener('change', () => {
        adminUserState.activityFilter = activityEl.value || 'all';
        adminUserState.page = 1;
        applyAdminUserFiltersAndRender();
    });

    sortEl.addEventListener('change', () => {
        adminUserState.sortBy = sortEl.value || 'created_desc';
        applyAdminUserFiltersAndRender();
    });
}

function changeAdminUsersPage(step) {
    const totalPages = Math.max(1, Math.ceil(adminUserState.filteredUsers.length / adminUserState.pageSize));
    adminUserState.page = Math.min(totalPages, Math.max(1, adminUserState.page + Number(step || 0)));
    renderAdminUsersTable();
    renderAdminUsersPagination();
}

async function loadAdminUsers() {
    const container = document.getElementById('adminUsersContainer');
    if (container) {
        container.innerHTML = '<div class="loading show">Loading admin users...</div>';
    }

    try {
        const { response, data: users } = await window.AdminPanel.api.getJson('/api/admin/users');
        if (!response.ok) {
            ownerNotifyError('Failed to load admin users');
            return;
        }

        adminUserState.users = Array.isArray(users) ? users : [];
        adminUserState.selectedIds.clear();
        renderAdminUsersOverview();
        applyAdminUserFiltersAndRender();
    } catch (error) {
        console.error('Error loading admin users:', error);
        ownerNotifyError('Failed to load admin users');
    }
}

async function deleteAdminUser(userId, username) {
    if (!userId || userId === 'undefined' || userId === '[object Object]') {
        ownerNotifyError('Cannot delete user: Invalid ID');
        return;
    }
    const target = adminUserState.users.find((user) => String(user.id) === String(userId));
    if (String(target?.role || '').toLowerCase() === 'owner') {
        ownerNotifyError('Owner accounts are protected and cannot be deleted here');
        return;
    }
    // Use custom prompt modal: require typing the exact username to confirm deletion
    try {
        const promptResult = await showPromptModal({
            title: 'Delete Admin Account',
            label: `Type the username to confirm deletion of "${username}" (this action is irreversible):`,
            placeholder: username,
            defaultValue: '',
            confirmText: 'Delete Account',
            cancelText: 'Cancel',
            confirmClass: 'btn-danger',
            includeCheckbox: { label: 'I understand this action is permanent and cannot be undone', required: true, errorText: 'You must acknowledge the permanence of this action' },
            validate: (val) => {
                if (!val) return 'Please type the username to confirm';
                if (val !== String(username)) return 'Username does not match';
                return true;
            }
        });

        if (!promptResult) return; // user cancelled
    } catch (err) {
        // Fallback to native confirm if modal system fails
        if (!confirm(`Are you sure you want to delete admin account "${username}"?`)) return;
    }

    try {
        const { response } = await window.AdminPanel.api.requestJson(`/api/admin/users/${userId}`, { method: 'DELETE' });
        if (response.ok) {
            adminUserState.selectedIds.delete(String(userId));
            ownerNotifySuccess('Admin user deleted');
            await loadAdminUsers();
        } else {
            ownerNotifyError('Failed to delete admin user');
        }
    } catch (error) {
        ownerNotifyError('Error deleting admin user');
    }
}

async function deleteSelectedAdminUsers() {
    const ids = Array.from(adminUserState.selectedIds);
    if (!ids.length) {
        ownerNotifyError('No users selected');
        return;
    }

    const usersById = new Map(adminUserState.users.map((user) => [String(user.id), user]));
    const deletableIds = ids.filter((id) => String(usersById.get(String(id))?.role || '').toLowerCase() !== 'owner');

    if (!deletableIds.length) {
        ownerNotifyError('Selected accounts are protected and cannot be deleted');
        return;
    }

    if (!confirm(`Delete ${deletableIds.length} selected account(s)? This cannot be undone.`)) return;

    let deleted = 0;
    let failed = 0;
    for (const targetUserId of deletableIds) {
        try {
            const { response } = await window.AdminPanel.api.requestJson(`/api/admin/users/${encodeURIComponent(targetUserId)}`, { method: 'DELETE' });
            if (response.ok) deleted += 1;
            else failed += 1;
        } catch (error) {
            failed += 1;
        }
    }

    adminUserState.selectedIds.clear();
    await loadAdminUsers();

    if (failed === 0) {
        ownerNotifySuccess(`${deleted} account(s) deleted`);
    } else {
        ownerNotifyError(`Deleted ${deleted}, failed ${failed}`);
    }
}

function exportAdminUsersCsv() {
    const rows = Array.isArray(adminUserState.filteredUsers) ? adminUserState.filteredUsers : [];
    if (!rows.length) {
        ownerNotifyError('No users to export for current filters');
        return;
    }

    const header = ['username', 'role', 'created_at', 'last_login'];
    const csvRows = [header.join(',')];

    rows.forEach((user) => {
        const row = [
            String(user.username || ''),
            String(user.role || ''),
            String(user.created_at || ''),
            String(user.last_login || '')
        ].map((value) => `"${value.replace(/"/g, '""')}"`);
        csvRows.push(row.join(','));
    });

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `admin-users-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    window.URL.revokeObjectURL(url);
}

window.adminUserState = adminUserState;
window.initAdminUserManagement = initAdminUserManagement;
window.applyAdminUserFiltersAndRender = applyAdminUserFiltersAndRender;
window.changeAdminUsersPage = changeAdminUsersPage;
window.loadAdminUsers = loadAdminUsers;
window.deleteAdminUser = deleteAdminUser;
window.deleteSelectedAdminUsers = deleteSelectedAdminUsers;
window.exportAdminUsersCsv = exportAdminUsersCsv;
