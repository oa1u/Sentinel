const EmojiStickerAudit = require('../Functions/EmojiStickerAudit');

module.exports = {
    name: 'stickerUpdate',
    runOnce: false,
    async execute(oldSticker, newSticker) {
        await EmojiStickerAudit.handleStickerUpdate(oldSticker, newSticker).catch(() => null);
    }
};