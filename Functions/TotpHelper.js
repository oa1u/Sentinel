const crypto = require('crypto');

// TOTP helper functions
// Generate and verify TOTP/HOTP codes, build otpauth:// URLs, and encrypt/decrypt
// stored 2FA secrets. These helpers keep 2FA logic in one place.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateBase32Secret(length = 32) {
    const bytes = crypto.randomBytes(length);
    let output = '';
    for (let i = 0; i < bytes.length; i += 1) {
        output += BASE32_ALPHABET[bytes[i] % BASE32_ALPHABET.length];
    }
    return output;
}

function base32ToBuffer(base32) {
    const normalized = String(base32 || '').toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
    let bits = '';

    for (const char of normalized) {
        const value = BASE32_ALPHABET.indexOf(char);
        if (value === -1) continue;
        bits += value.toString(2).padStart(5, '0');
    }

    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }

    return Buffer.from(bytes);
}

function generateHotp(secret, counter, digits = 6) {
    const key = base32ToBuffer(secret);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));

    const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binaryCode = ((hmac[offset] & 0x7f) << 24)
        | ((hmac[offset + 1] & 0xff) << 16)
        | ((hmac[offset + 2] & 0xff) << 8)
        | (hmac[offset + 3] & 0xff);

    return String(binaryCode % (10 ** digits)).padStart(digits, '0');
}

function generateTotp(secret, time = Date.now(), stepSeconds = 30, digits = 6) {
    const counter = Math.floor(time / 1000 / stepSeconds);
    return generateHotp(secret, counter, digits);
}

function verifyTotp(token, secret, options = {}) {
    const normalizedToken = String(token || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalizedToken)) return false;

    const stepSeconds = Number(options.stepSeconds) || 30;
    const digits = Number(options.digits) || 6;
    const window = Number(options.window) || 1;
    const nowCounter = Math.floor(Date.now() / 1000 / stepSeconds);

    for (let delta = -window; delta <= window; delta += 1) {
        const candidate = generateHotp(secret, nowCounter + delta, digits);
        if (candidate === normalizedToken) {
            return true;
        }
    }

    return false;
}

function buildOtpauthUrl({ secret, accountName, issuer = 'Admin Panel' }) {
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedLabel = encodeURIComponent(`${issuer}:${accountName}`);
    return `otpauth://totp/${encodedLabel}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

function encryptTwoFactorSecret(secret, encryptionKey) {
    const key = crypto.createHash('sha256').update(String(encryptionKey || '')).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.from(JSON.stringify({
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        encrypted: encrypted.toString('hex')
    })).toString('base64');
}

function decryptTwoFactorSecret(payload, encryptionKey) {
    const key = crypto.createHash('sha256').update(String(encryptionKey || '')).digest();
    const decoded = JSON.parse(Buffer.from(String(payload), 'base64').toString('utf8'));
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(decoded.iv, 'hex')
    );

    decipher.setAuthTag(Buffer.from(decoded.authTag, 'hex'));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(decoded.encrypted, 'hex')),
        decipher.final()
    ]);

    return decrypted.toString('utf8');
}

module.exports = {
    generateBase32Secret,
    generateTotp,
    verifyTotp,
    buildOtpauthUrl,
    encryptTwoFactorSecret,
    decryptTwoFactorSecret
};
