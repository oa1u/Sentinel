const EmojiStickerAudit = require('../Functions/EmojiStickerAudit');

module.exports = {
    name: 'emojiCreate',
    runOnce: false,
    async execute(emoji) {
        await EmojiStickerAudit.handleEmojiCreate(emoji).catch(() => null);
    }
};