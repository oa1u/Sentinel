const EmojiStickerAudit = require('../Functions/EmojiStickerAudit');

module.exports = {
    name: 'stickerDelete',
    runOnce: false,
    async execute(sticker) {
        await EmojiStickerAudit.handleStickerDelete(sticker).catch(() => null);
    }
};