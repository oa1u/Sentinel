const EmojiStickerAudit = require('../Functions/EmojiStickerAudit');

module.exports = {
    name: 'emojiUpdate',
    runOnce: false,
    async execute(oldEmoji, newEmoji) {
        await EmojiStickerAudit.handleEmojiUpdate(oldEmoji, newEmoji).catch(() => null);
    }
};