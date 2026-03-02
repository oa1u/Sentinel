const db = require('./MySQLDatabaseManager');

// Appeal helpers
// Small utilities related to appeals, like validating that a ban case ID
// exists and is currently marked as banned.
async function isValidBanCaseId(caseId) {
    if (!caseId || typeof caseId !== 'string' || !caseId.startsWith('BAN-')) return { valid: false };
    // Query for a user_bans record with this caseId and banned = 1
    const results = await db.connection.query(
        'SELECT user_id FROM user_bans WHERE ban_case_id = ? AND banned = TRUE',
        [caseId]
    );
    if (results.length > 0) {
        return { valid: true, userId: results[0].user_id };
    }
    return { valid: false };
}

module.exports = {
    isValidBanCaseId
};