const EmojiStickerAudit = require('../Functions/EmojiStickerAudit');

module.exports = {
    name: 'emojiDelete',
    runOnce: false,
    async execute(emoji) {
        await EmojiStickerAudit.handleEmojiDelete(emoji).catch(() => null);
    }
};