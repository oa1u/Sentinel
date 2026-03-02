const crypto = require('crypto');

// CSRF helper utilities
// Generate and verify compact CSRF tokens and validate request origin headers.
const TOKEN_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour token validity window
const TOKEN_VERSION = 'v1';

class CsrfHelper {
    static generateSecret() {
        return crypto.randomBytes(32).toString('hex');
    }

    static normalizeHostValue(hostValue) {
        return String(hostValue || '')
            .split(',')
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean);
    }

    static hostVariants(hostValue) {
        const variants = new Set();
        const raw = String(hostValue || '').trim().toLowerCase();
        if (!raw) return variants;

        variants.add(raw);

        const withoutPort = raw.replace(/:\d+$/, '');
        variants.add(withoutPort);

        if (raw.endsWith(':443')) variants.add(raw.slice(0, -4));
        if (raw.endsWith(':80')) variants.add(raw.slice(0, -3));

        return variants;
    }


    static createToken(secret) {
        if (!secret) throw new Error('CSRF Secret is required to generate a token');

        const timestamp = Date.now().toString(36); // Base36 for compactness
        const salt = crypto.randomBytes(8).toString('hex');
        const payload = `${TOKEN_VERSION}:${timestamp}:${salt}`;

        // Sign the token payload using HMAC-SHA256 and return a compact token string.
        const signature = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('base64')
            .replace(/\+/g, '-') // URL-safe base64
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        return `${payload}:${signature}`;
    }


    static verifyToken(secret, token) {
        if (!secret) {
            console.debug('[CSRF Debug] Missing secret in verifyToken');
            return false;
        }
        if (!token) {
            console.debug('[CSRF Debug] Missing token in verifyToken');
            return false;
        }
        if (typeof token !== 'string') {
            console.debug('[CSRF Debug] Token is not a string:', typeof token);
            return false;
        }

        const parts = token.split(':');
        if (parts.length !== 4) {
            console.debug(`[CSRF Debug] Invalid token format. Parts: ${parts.length}`);
            return false;
        }

        const [version, timestampStr, salt, providedSignature] = parts;

        // 1. Check version
        if (version !== TOKEN_VERSION) {
            console.debug(`[CSRF Debug] Invalid version: ${version}`);
            return false;
        }

        // 2. Check Expiration
        const timestamp = parseInt(timestampStr, 36);
        if (isNaN(timestamp)) {
            console.debug(`[CSRF Debug] Invalid timestamp parsing: ${timestampStr}`);
            return false;
        }

        const now = Date.now();
        // Allow for some clock skew (e.g. 2 mins future) but mainly check expiration
        // We extend the token max age slightly just to be safe during server restarts or slight clock drift
        if (timestamp > now + 5 * 60 * 1000) {
            console.debug(`[CSRF Debug] Future token rejected. Token time: ${new Date(timestamp).toISOString()}, Server time: ${new Date(now).toISOString()}`);
            return false; // Future token?
        }
        if (timestamp < now - TOKEN_MAX_AGE_MS) {
            console.debug(`[CSRF Debug] Token expired. Age: ${(now - timestamp) / 1000}s`);
            return false; // Expired token
        }

        // 3. Recompute Signature
        const payload = `${version}:${timestampStr}:${salt}`;
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        // 4. Constant-time comparison
        const bufferProvided = Buffer.from(providedSignature);
        const bufferExpected = Buffer.from(expectedSignature);

        if (bufferProvided.length !== bufferExpected.length) {
            console.debug(`[CSRF Debug] Signature length mismatch. Provided: ${bufferProvided.length}, Expected: ${bufferExpected.length}`);
            return false;
        }

        return crypto.timingSafeEqual(bufferProvided, bufferExpected);
    }

    /**
     * Verifies that the request Origin/Referer matches the Host.
     * This protects against cross-origin attacks where the attacker can't forge headers.
     * @param {import('express').Request} req 
     * @returns {boolean} True if origin is trusted
     */
    static verifyOrigin(req) {
        // Skip check for GET/HEAD/OPTIONS (handled by middleware usually, but good to have)
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;

        const origin = req.headers['origin'];
        const referer = req.headers['referer'];

        // Allowed hosts logic
        const allowedHosts = new Set();
        const hostHeaders = [req.headers['host'], req.headers['x-forwarded-host']];

        for (const headerValue of hostHeaders) {
            for (const candidate of CsrfHelper.normalizeHostValue(headerValue)) {
                for (const variant of CsrfHelper.hostVariants(candidate)) {
                    allowedHosts.add(variant);
                }
            }
        }

        // If neither Origin nor Referer is present, we can't verify.
        // In strict mode we'd fail, but for API compatibility we might allow it (or block if strict).
        if (!origin && !referer) return true;

        if (origin) {
            try {
                const url = new URL(origin);
                const originVariants = CsrfHelper.hostVariants(url.host);
                for (const variant of originVariants) {
                    if (allowedHosts.has(variant)) return true;
                }
                return false;
            } catch {
                return false;
            }
        }

        if (referer) {
            try {
                const url = new URL(referer);
                const refererVariants = CsrfHelper.hostVariants(url.host);
                for (const variant of refererVariants) {
                    if (allowedHosts.has(variant)) return true;
                }
                return false;
            } catch {
                return false;
            }
        }

        return false;
    }
}


module.exports = CsrfHelper;