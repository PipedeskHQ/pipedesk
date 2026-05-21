const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. Please log in.' });
  }

  try {
    const verified = jwt.verify(token, process.env.SESSION_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied.' });
  }

  try {
    const verified = jwt.verify(token, process.env.SESSION_SECRET);
    if (verified.email !== process.env.ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Admin access only.' });
    }
    req.user = verified;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid or expired session.' });
  }
}

module.exports = { authenticateToken, authenticateAdmin };
