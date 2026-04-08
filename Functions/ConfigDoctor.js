const ConfigValidator = require('./ConfigValidator');
const { createLogEmbed } = require('./LoggingHelper');

function expectedTypeText(key) {
    const normalized = String(key || '').toLowerCase();
    if (normalized.includes('category')) return 'category channel';
    if (normalized.includes('voice')) return 'voice or stage channel';
    if (normalized.includes('logchannel') || normalized.includes('welcomechannel') || normalized.includes('ruleschannel')) return 'text-based channel';
    return 'matching channel or role';
}

function buildSuggestion(issue) {
    const message = String(issue?.message || '').toLowerCase();
    const key = String(issue?.key || '');
    if (message.includes('does not exist')) {
        return `Run /setup for ${issue.config || 'this config'} and point ${issue.label || issue.path || 'this field'} to a live ${expectedTypeText(key)}.`;
    }
    if (message.includes('wrong type')) {
        return `Pick a ${expectedTypeText(key)} for ${issue.label || issue.path || 'this field'} or rename the field if the expected type changed.`;
    }
    if (message.includes('missing channel permissions')) {
        return 'Grant the bot View Channel, Send Messages, and Embed Links in that channel, or choose a channel the bot can already use.';
    }
    if (message.includes('administrator permission')) {
        return 'Either grant Administrator to that role or update the config to a role that actually represents your admin team.';
    }
    if (message.includes('moderatemembers')) {
        return 'Grant Moderate Members to that role or point moderatorRoleId at a role that can perform moderation actions.';
    }
    if (message.includes('cannot manage this configured role')) {
        return 'Move the bot role above that role in the role list, or choose a lower role that the bot can manage.';
    }
    if (message.includes('configured value is empty')) {
        return `Set ${issue.label || issue.path || 'this field'} through /setup if that feature is required for your server.`;
    }
    return 'Review the current server structure and rerun /setup for this area.';
}

function diagnoseValidationReport(report) {
    const issues = Array.isArray(report?.issues) ? report.issues : [];
    return {
        ...report,
        diagnoses: issues.map((issue) => ({
            ...issue,
            suggestion: buildSuggestion(issue)
        }))
    };
}

async function diagnoseGuildConfig(client, guildOrId) {
    const report = await ConfigValidator.validateConfigForGuild(client, guildOrId);
    return diagnoseValidationReport(report);
}

function buildDoctorEmbeds(report, reason = 'manual') {
    const diagnoses = Array.isArray(report?.diagnoses) ? report.diagnoses : [];
    if (!diagnoses.length) return [];

    const chunks = [];
    for (let index = 0; index < diagnoses.length; index += 4) {
        chunks.push(diagnoses.slice(index, index + 4));
    }

    return chunks.map((group, index) => createLogEmbed({
        title: index === 0 ? 'Config Doctor Suggestions' : `Config Doctor Suggestions (${index + 1})`,
        description: `Suggested fixes for ${report.guildName || report.guildId || 'unknown guild'} during ${reason}.`,
        color: 0x5865F2,
        fields: group.map((issue) => ({
            name: issue.label || issue.path || 'Unknown path',
            value: `${issue.message}\nSuggestion: ${issue.suggestion}`,
            inline: false
        }))
    }));
}

module.exports = {
    diagnoseGuildConfig,
    diagnoseValidationReport,
    buildDoctorEmbeds,
    buildSuggestion
};