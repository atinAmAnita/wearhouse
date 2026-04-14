// Per-account eBay sync lock. Prevents concurrent operations from racing
// against the same Mongo documents.
//
// Vercel caveat: in-memory = per serverless instance. Cross-instance races
// possible on scale-out. Acceptable for single-user workflow; migrate to
// Mongo TTL collection if that becomes a real problem.

const { HttpError } = require('./errors');

const ebayLocks = new Map();

function withEbayLock(accountId, operation, fn) {
    if (!accountId) throw new HttpError(400, 'Account ID required for sync operation');
    const existing = ebayLocks.get(accountId);
    if (existing) {
        const ageMs = Date.now() - existing.startedAt;
        // Stale safety net: auto-release after 5 min in case finally didn't run
        if (ageMs < 5 * 60 * 1000) {
            throw new HttpError(409,
                `Sync already in progress: ${existing.operation} (${Math.round(ageMs / 1000)}s ago)`,
                { operation: existing.operation, elapsedSec: Math.round(ageMs / 1000) }
            );
        }
        console.warn(`Stale eBay lock for ${accountId} (${Math.round(ageMs / 1000)}s), force-releasing`);
    }
    ebayLocks.set(accountId, { operation, startedAt: Date.now() });
    return Promise.resolve().then(fn).finally(() => ebayLocks.delete(accountId));
}

module.exports = { ebayLocks, withEbayLock };
