module.exports = (client) => {
    var channelCreate = require("./ChannelCreate");
    var channelDelete = require("./ChannelDelete");
    var emojiCreate = require("./EmojiCreate");
    var emojiDelete = require("./EmojiDelete");
    var emojiUpdate = require("./EmojiUpdate");
    var guildMemberAdd = require("./GuildMemberAdd");
    var guildMemberRemove = require("./GuildMemberRemove");
    var guildMemberUpdate = require("./GuildMemberUpdate");
    var inviteCreate = require("./InviteCreate");
    var inviteDelete = require("./InviteDelete");
    var roleCreate = require("./RoleCreate");
    var roleDelete = require("./RoleDelete");
    var roleUpdate = require("./RoleUpdate");
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





