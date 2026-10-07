const crypto = require('crypto');

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // timingSafeEqual throws on different lengths, so check first
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

const requireInternalAuth = (req, res, next) => {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    // Fail closed: if the key isn't configured, the endpoint stays off
    return res.status(503).json({ message: 'Internal API not configured' });
  }
  const provided = req.get('x-api-key') ?? '';
  if (!safeEqual(provided, expected)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
};

module.exports = requireInternalAuth;
