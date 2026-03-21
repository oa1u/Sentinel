// Server logging loader
// Registers handlers that post server activity (channels, roles, members, emojis, invites)
// into a central log channel for auditing and review.

module.exports = (client) => {
    const channelCreate = require("./ChannelCreate");
    const channelDelete = require("./ChannelDelete");
    const emojiCreate = require("./EmojiCreate");
    const emojiDelete = require("./EmojiDelete");
    const emojiUpdate = require("./EmojiUpdate");
    const guildMemberUpdate = require("./GuildMemberUpdate");
    const inviteCreate = require("./InviteCreate");
    const inviteDelete = require("./InviteDelete");
    const roleCreate = require("./RoleCreate");
    const roleDelete = require("./RoleDelete");
    const roleUpdate = require("./RoleUpdate");
    const messageDelete = require("./MessageDelete");
    const messageUpdate = require("./MessageUpdate");
    const messageBulkDelete = require("./MessageBulkDelete");
    const voiceStateUpdate = require("./VoiceStateUpdate");
    const guildUpdate = require("./GuildUpdate");
    const channelPinsUpdate = require("./ChannelPinsUpdate");
    const threadCreate = require("./ThreadCreate");
    const threadUpdate = require("./ThreadUpdate");
    const threadDelete = require("./ThreadDelete");
    const webhooksUpdate = require("./WebhooksUpdate");
    const integrationCreate = require("./IntegrationCreate");
    const integrationUpdate = require("./IntegrationUpdate");
    const integrationDelete = require("./IntegrationDelete");
    const guildScheduledEventCreate = require("./GuildScheduledEventCreate");
    const guildScheduledEventUpdate = require("./GuildScheduledEventUpdate");
    const guildScheduledEventDelete = require("./GuildScheduledEventDelete");
    const stickerCreate = require("./StickerCreate");
    const stickerUpdate = require("./StickerUpdate");
    const stickerDelete = require("./StickerDelete");
    channelCreate(client);
    channelDelete(client);
    emojiCreate(client);
    emojiDelete(client);
    emojiUpdate(client);
    guildMemberUpdate(client);
    inviteCreate(client);
    inviteDelete(client);
    roleCreate(client);
    roleDelete(client);
    roleUpdate(client);
    messageDelete(client);
    messageUpdate(client);
    messageBulkDelete(client);
    voiceStateUpdate(client);
    guildUpdate(client);
    channelPinsUpdate(client);
    threadCreate(client);
    threadUpdate(client);
    threadDelete(client);
    webhooksUpdate(client);
    integrationCreate(client);
    integrationUpdate(client);
    integrationDelete(client);
    guildScheduledEventCreate(client);
    guildScheduledEventUpdate(client);
    guildScheduledEventDelete(client);
    stickerCreate(client);
    stickerUpdate(client);
    stickerDelete(client);
}