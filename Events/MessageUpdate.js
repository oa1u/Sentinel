const AutoMod = require('./AutoMod');
const AttachmentScanner = require('../Functions/AttachmentScanner');
const { createLogEmbed, sendLogEmbed } = require('../Functions/LoggingHelper');

function truncate(value, maxLength = 400) {
    const text = String(value || '').trim();
    if (!text) return 'None';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 3)}...`;
}

function extractUrls(content) {
    const matches = String(content || '').match(/https?:\/\/[^\s]+/gi);
    return Array.from(new Set((matches || []).map((entry) => entry.toLowerCase())));
}

function getSuspiciousEditSummary(oldContent, newContent) {
    const beforeUrls = extractUrls(oldContent);
    const afterUrls = extractUrls(newContent);
    if (afterUrls.length === 0) return null;

    if (beforeUrls.length === 0) {
        return {
            title: 'Link Added After Posting',
            description: 'A member edited a message to add a link after it was already posted.'
        };
    }

    const beforeHosts = new Set(beforeUrls.map((entry) => {
        try {
            return new URL(entry).host;
        } catch {
            return entry;
        }
    }));
    const afterHosts = new Set(afterUrls.map((entry) => {
        try {
            return new URL(entry).host;
        } catch {
            return entry;
        }
    }));

    const hostChanged = beforeHosts.size !== afterHosts.size || [...afterHosts].some((host) => !beforeHosts.has(host));
    if (!hostChanged) return null;

    return {
        title: 'Edited Link Host Changed',
        description: 'A member edited a message and swapped the linked host after posting.'
    };
}

async function logSuspiciousEdit(oldMessage, newMessage) {
    const summary = getSuspiciousEditSummary(oldMessage?.content || '', newMessage?.content || '');
    if (!summary || !newMessage.guild) return;

    const embed = createLogEmbed({
        title: summary.title,
        description: summary.description,
        color: 0xF1C40F,
        fields: [
            { name: 'Member', value: `${newMessage.author} (${newMessage.author.tag})`, inline: true },
            { name: 'Channel', value: `${newMessage.channel}`, inline: true },
            { name: 'Message', value: `[Jump to message](${newMessage.url})`, inline: true },
            { name: 'Before', value: truncate(oldMessage?.content), inline: false },
            { name: 'After', value: truncate(newMessage?.content), inline: false }
        ]
    });

    await sendLogEmbed(newMessage.guild, embed).catch(() => null);
}

module.exports = {
    name: 'messageUpdate',
    runOnce: false,
    call: async (client, args) => {
        let [oldMessage, newMessage] = args;
        if (!newMessage) return;

        if (newMessage.partial) {
            newMessage = await newMessage.fetch().catch(() => null);
        }
        if (!newMessage || !newMessage.guild || newMessage.author?.bot) return;

        if (oldMessage?.partial) {
            oldMessage = await oldMessage.fetch().catch(() => oldMessage);
        }

        const oldContent = String(oldMessage?.content || '');
        const newContent = String(newMessage.content || '');
        if (!newContent.trim() || oldContent === newContent) return;

        await logSuspiciousEdit(oldMessage, newMessage);
        await AttachmentScanner.handleMessageUpdate(oldMessage, newMessage, client).catch(() => null);
        await AutoMod.handleMessageUpdate(oldMessage, newMessage, client);
    }
};