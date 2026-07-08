const jwt = require('jsonwebtoken');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { logger } = require('../utils/logger');

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

// Email/password login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const user = await db.getUserByEmail(email);
    if (!user || !user.password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const bcrypt = require('bcryptjs');
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    logger.info(`User logged in: ${user.email}`);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role } });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Email/password register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name required' });
    }
    const existing = await db.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const bcrypt = require('bcryptjs');
    const hashed = await bcrypt.hash(password, 10);
    const user = await db.createUser({ email, password: hashed, name, role: 'admin' });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    logger.info(`User registered: ${user.email}`);
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (error) {
    logger.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Configure Passport Google Strategy
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const user = await db.findOrCreateGoogleUser(profile);
    return done(null, user);
  } catch (err) {
    logger.error('Google OAuth error:', err);
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// Auth middleware (JWT)
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Google OAuth - initiate login
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  prompt: 'select_account'
}));

// Google OAuth - callback
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: `${CLIENT_URL}/login?error=auth_failed` }),
  (req, res) => {
    try {
      const user = req.user;
      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );
      logger.info(`User logged in via Google: ${user.email}`);
      res.redirect(`${CLIENT_URL}/auth/callback?token=${token}&user=${encodeURIComponent(JSON.stringify({
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar
      }))}`);
    } catch (error) {
      logger.error('Google callback error:', error);
      res.redirect(`${CLIENT_URL}/login?error=auth_failed`);
    }
  }
);

// Get current user profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      createdAt: user.createdAt
    });
  } catch (error) {
    logger.error('Profile fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Update profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const updates = {};
    if (req.body.name) updates.name = req.body.name;

    const user = await db.updateUser(req.user.id, updates);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      message: 'Profile updated',
      user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar }
    });
  } catch (error) {
    logger.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});



// Known faces management (for face recognition whitelist)
router.get('/known-faces', authenticate, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const faces = (user.knownFaces || []).map(f => ({
      id: f.id,
      name: f.name,
      thumbnail: f.thumbnail,
      addedAt: f.addedAt
    }));
    res.json({ knownFaces: faces });
  } catch (error) {
    logger.error('Fetch known faces error:', error);
    res.status(500).json({ error: 'Failed to fetch known faces' });
  }
});

router.post('/known-faces', authenticate, async (req, res) => {
  try {
    const { name, embedding, thumbnail } = req.body;
    if (!name || !Array.isArray(embedding)) {
      return res.status(400).json({ error: 'Name and embedding required' });
    }
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const faces = user.knownFaces || [];
    faces.push({
      id: require('uuid').v4(),
      name,
      embedding,
      thumbnail: thumbnail || null,
      addedAt: new Date()
    });
    await db.updateUser(req.user.id, { knownFaces: faces });
    res.json({ message: 'Face added', knownFaces: faces.map(f => ({ id: f.id, name: f.name, thumbnail: f.thumbnail })) });
  } catch (error) {
    logger.error('Add known face error:', error);
    res.status(500).json({ error: 'Failed to add known face' });
  }
});

router.delete('/known-faces/:id', authenticate, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const faces = (user.knownFaces || []).filter(f => f.id !== req.params.id);
    await db.updateUser(req.user.id, { knownFaces: faces });
    res.json({ message: 'Face removed' });
  } catch (error) {
    logger.error('Remove known face error:', error);
    res.status(500).json({ error: 'Failed to remove face' });
  }
});

module.exports = router;
module.exports.authenticate = authenticate;
