// Server logging loader
// Registers handlers that post server activity (channels, roles, members, emojis, invites)
// into a central log channel for auditing and review.

module.exports = (client) => {
    const channelCreate = require("./ChannelCreate");
    const channelDelete = require("./ChannelDelete");
    const emojiCreate = require("./EmojiCreate");
    const emojiDelete = require("./EmojiDelete");
    const emojiUpdate = require("./EmojiUpdate");
    const guildMemberAdd = require("./GuildMemberAdd");
    const guildMemberRemove = require("./GuildMemberRemove");
    const guildMemberUpdate = require("./GuildMemberUpdate");
    const inviteCreate = require("./InviteCreate");
    const inviteDelete = require("./InviteDelete");
    const roleCreate = require("./RoleCreate");
    const roleDelete = require("./RoleDelete");
    const roleUpdate = require("./RoleUpdate");

    channelCreate(client);
    channelDelete(client);
    emojiCreate(client);
    emojiDelete(client);
    emojiUpdate(client);
    guildMemberAdd(client);
    guildMemberRemove(client);
    guildMemberUpdate(client);
    inviteCreate(client);
    inviteDelete(client);
    roleCreate(client);
    roleDelete(client);
    roleUpdate(client);
}