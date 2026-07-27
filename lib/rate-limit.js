const rateLimitBuckets = new Map();
const RATE_LIMIT_CAPACITY = 100;
const RATE_LIMIT_REFILL = 10;

function rateLimit(ip) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip) || { tokens: RATE_LIMIT_CAPACITY, lastRefill: now };
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + elapsed * RATE_LIMIT_REFILL);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) {
    rateLimitBuckets.set(ip, bucket);
    return false;
  }
  bucket.tokens -= 1;
  rateLimitBuckets.set(ip, bucket);
  return true;
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

export { rateLimit, getClientIp };
