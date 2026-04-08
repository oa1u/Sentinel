const path = require('path');
const { createLogEmbed, sendLogEmbed } = require('./LoggingHelper');
const BotSafetyCenter = require('./BotSafetyCenter');

const DANGEROUS_EXTENSIONS = new Set(['.exe', '.scr', '.bat', '.cmd', '.ps1', '.js', '.vbs', '.jar', '.com', '.msi', '.apk', '.dmg', '.iso']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz']);

function scanAttachments(attachments) {
    const config = BotSafetyCenter.getConfig();
    const findings = [];
    let totalSize = 0;

    for (const attachment of attachments.values()) {
        totalSize += Number(attachment.size || 0);
        const fileName = String(attachment.name || attachment.url || 'unknown');
        const extension = path.extname(fileName).toLowerCase();
        const contentType = String(attachment.contentType || '').toLowerCase();

        if (DANGEROUS_EXTENSIONS.has(extension)) {
            findings.push(`Dangerous attachment extension detected: ${fileName}`);
        } else if (ARCHIVE_EXTENSIONS.has(extension)) {
            findings.push(`Archive attachment uploaded: ${fileName}`);
        }

        if (extension && contentType.startsWith('image/') && DANGEROUS_EXTENSIONS.has(extension)) {
            findings.push(`File extension and content type do not match for ${fileName}.`);
        }
    }

    if (attachments.size >= config.attachmentCountThreshold) {
        findings.push(`Message contains an unusually high number of attachments (${attachments.size}).`);
    }
    if (totalSize >= config.attachmentTotalSizeMbThreshold * 1024 * 1024) {
        findings.push(`Combined attachment size is high (${Math.round(totalSize / (1024 * 1024))} MB).`);
    }

    return findings;
}

async function inspectMessage(message) {
    if (!message?.guild || !message.attachments?.size || message.author?.bot) return null;
    const findings = scanAttachments(message.attachments);
    if (!findings.length) return null;

    BotSafetyCenter.recordAlert({
        type: 'attachment-risk',
        severity: 'warning',
        title: 'Attachment Risk Alert',
        message: `${message.author.tag} posted attachments that matched configured risk checks.`,
        guildId: message.guild.id,
        guildName: message.guild.name,
        meta: {
            attachmentCount: message.attachments.size,
            findings
        }
    });

    const embed = createLogEmbed({
        title: 'Attachment Risk Alert',
        description: `${message.author} posted attachments that should be reviewed.`,
        color: 0xF39C12,
        fields: [
            { name: 'User', value: `${message.author.tag} (${message.author.id})`, inline: true },
            { name: 'Channel', value: `${message.channel}`, inline: true },
            { name: 'Attachments', value: `${message.attachments.size}`, inline: true },
            { name: 'Findings', value: findings.join('\n').slice(0, 1000), inline: false }
        ]
    });

    await sendLogEmbed(message.guild, embed).catch(() => null);
    return findings;
}

module.exports = {
    handleMessageCreate: inspectMessage,
    handleMessageUpdate: async (_oldMessage, newMessage) => inspectMessage(newMessage)
};