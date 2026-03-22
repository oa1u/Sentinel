const crypto = require('crypto');

// Helpers for generating secure, unique case IDs used in moderation logs.
// Uses `crypto` to produce random, hard-to-guess identifiers like `WARN-abc123`.

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Here's how we generate a random string using crypto.
function makeid(length = 10, charset = CHARSET) {
  if (!length || length < 1) return '';
  let result = '';
  
  // Prevent modulo bias by dropping bytes that don't fit evenly into the charset length
  const maxValidByte = 256 - (256 % charset.length);
  
  while (result.length < length) {
    // Generate extra bytes to account for dropped ones
    const bytes = crypto.randomBytes(length * 2);
    for (let i = 0; i < bytes.length && result.length < length; i++) {
      if (bytes[i] < maxValidByte) {
        result += charset[bytes[i] % charset.length];
      }
    }
  }
  return result;
}

// This builds a unique case ID, like WARN-XXXXXXXX, for tracking moderation cases.
function generateCaseId(caseType = 'CASE', randomLength = 8) {
  const typePrefix = (caseType || 'CASE').toUpperCase().slice(0, 10);
  const randomPart = makeid(randomLength);
  return `${typePrefix}-${randomPart}`;
}

module.exports = {
  disabled: true,
  makeid,
  generateCaseId,
  CHARSET
};