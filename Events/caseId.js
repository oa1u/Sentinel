const crypto = require('crypto');

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Generate random string with crypto
function makeid(length = 10, charset = CHARSET) {
  if (!length || length < 1) return '';
  const bytes = crypto.randomBytes(length);
  const result = [];
  for (let i = 0; i < length; i++) {
    result.push(charset[bytes[i] % charset.length]);
  }
  return result.join('');
}

// Generate unique case ID (e.g., WARN-XXXXXXXX)
function generateCaseId(caseType = 'CASE', randomLength = 8) {
  const typePrefix = (caseType || 'CASE').toUpperCase().slice(0, 10);
  const randomPart = makeid(randomLength);
  return `${typePrefix}-${randomPart}`;
}

module.exports = {
  makeid,
  generateCaseId,
  CHARSET
};