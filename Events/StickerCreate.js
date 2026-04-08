const EmojiStickerAudit = require('../Functions/EmojiStickerAudit');

module.exports = {
    name: 'stickerCreate',
    runOnce: false,
    async execute(sticker) {
        await EmojiStickerAudit.handleStickerCreate(sticker).catch(() => null);
    }
};