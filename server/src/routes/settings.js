const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticate } = require('./auth');
const db = require('../utils/database');
const { logger } = require('../utils/logger');

// Get user settings
router.get('/', authenticate, async (req, res) => {
  try {
    let settings = await db.getSettings(req.user.id);
    if (!settings) {
      settings = await db.updateSettings(req.user.id, {
        notifications: {
          telegram: true,
          telegramChatId: '',
          email: true,
          push: true,
          cooldownSeconds: 30,
          maxAlertsPerHour: 20
        },
        detection: {
          confidenceThreshold: 0.6,
          objectDetection: true,
          faceDetection: true,
          motionDetection: true,
          behaviorAnalysis: true,
          intrusionDetection: true,
          loiteringDetection: true,
          unattendedObject: true
        },
        security: {
          twoFactorEnabled: false,
          sessionTimeout: 3600,
          allowedIPs: []
        }
      });
    }
    res.json(settings);
  } catch (error) {
    logger.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update notification settings
router.put('/notifications', authenticate, [
  body('telegram').optional().isBoolean(),
  body('telegramChatId').optional().isString(),
  body('email').optional().isBoolean(),
  body('push').optional().isBoolean(),
  body('cooldownSeconds').optional().isInt({ min: 5, max: 300 }),
  body('maxAlertsPerHour').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const settings = await db.getSettings(req.user.id) || {};
    const currentNotifications = settings.notifications || {};

    const updatedSettings = await db.updateSettings(req.user.id, {
      notifications: { ...currentNotifications, ...req.body }
    });

    logger.info(`Notification settings updated for user ${req.user.id}`);
    res.json(updatedSettings);
  } catch (error) {
    logger.error('Error updating notification settings:', error);
    res.status(500).json({ error: 'Failed to update notification settings' });
  }
});

// Update detection settings
router.put('/detection', authenticate, [
  body('confidenceThreshold').optional().isFloat({ min: 0.1, max: 1.0 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const settings = await db.getSettings(req.user.id) || {};
    const currentDetection = settings.detection || {};

    const updatedSettings = await db.updateSettings(req.user.id, {
      detection: { ...currentDetection, ...req.body }
    });

    logger.info(`Detection settings updated for user ${req.user.id}`);
    res.json(updatedSettings);
  } catch (error) {
    logger.error('Error updating detection settings:', error);
    res.status(500).json({ error: 'Failed to update detection settings' });
  }
});

// Update security settings
router.put('/security', authenticate, [
  body('twoFactorEnabled').optional().isBoolean(),
  body('sessionTimeout').optional().isInt({ min: 300, max: 86400 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const settings = await db.getSettings(req.user.id) || {};
    const currentSecurity = settings.security || {};

    const updatedSettings = await db.updateSettings(req.user.id, {
      security: { ...currentSecurity, ...req.body }
    });

    logger.info(`Security settings updated for user ${req.user.id}`);
    res.json(updatedSettings);
  } catch (error) {
    logger.error('Error updating security settings:', error);
    res.status(500).json({ error: 'Failed to update security settings' });
  }
});

module.exports = router;
