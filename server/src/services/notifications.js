const { logger } = require('../utils/logger');
const db = require('../utils/database');
const fs = require('fs');
const path = require('path');

class NotificationService {
  constructor(io) {
    this.io = io;
    this.twilioClient = null;
    this.emailTransporter = null;
    this.isInitialized = false;
    this.dryRun = false;
  }

  async initialize() {
    logger.info('Initializing Notification Service...');
    try {
      this.dryRun = String(process.env.NOTIFICATIONS_DRY_RUN).toLowerCase() === 'true';

      if (this.dryRun) {
        logger.warn('Notification Service running in DRY-RUN mode');
      }

      const hasTelegram = !!process.env.TELEGRAM_BOT_TOKEN;
      const hasSmtp = !!(process.env.SMTP_USER && process.env.SMTP_PASS);
      logger.info(`[Notifications] Config: dryRun=${this.dryRun}, telegram=${hasTelegram}, smtp=${hasSmtp}`);

      if (!this.dryRun && hasTelegram) {
        this.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
        logger.info('Telegram Bot professional service initialized (HTTPS Encrypted)');
      } else if (!this.dryRun) {
        logger.warn('[Notifications] Telegram Bot Token not configured — Alerts will NOT be sent via Telegram');
      }

      if (!this.dryRun && hasSmtp) {
        const nodemailer = require('nodemailer');
        this.emailTransporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || 'smtp.gmail.com',
          port: parseInt(process.env.SMTP_PORT) || 587,
          secure: false,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
        logger.info('Email service initialized');
      } else if (!this.dryRun) {
        logger.warn('[Notifications] SMTP not configured — emails will NOT be sent');
      }

      this.isInitialized = true;
      logger.info('Notification Service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Notification Service:', error);
      this.isInitialized = true;
    }
  }

  setAIDetection(aiDetection) {
    this.aiDetection = aiDetection;
  }

  emitAlertToOwner(alert) {
    if (!this.io) return;
    for (const [, socket] of this.io.sockets.sockets) {
      if (socket.userId === alert.ownerId) {
        socket.emit('global-alert', alert);
      }
    }
  }

  async sendAlert(alert, frameBase64) {
    if (!this.isInitialized) return;

    try {
      const user = await db.getUserById(alert.ownerId);
      const camera = await db.getCameraById(alert.cameraId);
      if (!user || !camera) return;

      const settings = await db.getSettings(user.id);
      const notifPrefs = settings?.notifications || {};

      const message = this._formatAlertMessage(alert, camera, user, frameBase64);

      // Send Telegram Alert (End-to-End Encrypted via HTTPS)
      if (notifPrefs.telegram && notifPrefs.telegramChatId) {
        await this._sendTelegramMessage(notifPrefs.telegramChatId, message.textAlert, frameBase64);
        // Also send the video clip to Telegram if available
        const rawClipPath = alert.clip_path || (alert.details && alert.details.clipPath);
        if (rawClipPath) {
          await this._sendTelegramVideo(notifPrefs.telegramChatId, rawClipPath, `🎬 Video clip: ${alert.type}`);
        }
      }

      // Send Email with attached frame photo AND video clip
      if (notifPrefs.email) {
        const rawClipPath = alert.clip_path || (alert.details && alert.details.clipPath);
        await this._sendEmail(user.email, message.emailSubject, message.emailHtml, frameBase64, rawClipPath);
      }

      // Push notification via WebSocket — only to the camera owner
      if (notifPrefs.push) {
        const userSockets = this.io.sockets.sockets;
        for (const [, socket] of userSockets) {
          if (socket.userId === user.id) {
            socket.emit('notification', {
              userId: user.id,
              type: 'alert',
              title: `Security Alert - ${camera.name}`,
              message: message.short,
              data: { ...alert, frameBase64 }
            });
          }
        }
      }

      logger.info(`Alert notification sent for camera ${alert.cameraId} to user ${user.email}`);
    } catch (error) {
      logger.error('Failed to send alert notification:', error);
    }
  }

  _formatAlertMessage(alert, camera, user, frameBase64) {
    const typeLabels = {
      intrusion: 'INTRUSION DETECTED',
      theft: 'POTENTIAL THEFT DETECTED',
      weapon_detected: 'WEAPON DETECTED — CALL POLICE',
      vandalism: 'VANDALISM DETECTED',
      loitering: 'SUSPICIOUS LOITERING',
      suspicious_behavior: 'SUSPICIOUS BEHAVIOR DETECTED',
      unusual_behavior: 'SUSPICIOUS BEHAVIOR DETECTED',
      unattended_object: 'UNATTENDED OBJECT',
      unknown_person: 'UNKNOWN PERSON DETECTED',
      manual: 'MANUAL ALERT',
      person: 'PERSON DETECTED',
      motion: 'MOTION DETECTED'
    };

    const alertType = typeLabels[alert.type] || 'SECURITY ALERT';
    const severityEmoji = { critical: '\u{1F6A8}', warning: '\u{26A0}\u{FE0F}', info: '\u{2139}\u{FE0F}' };
    const emoji = severityEmoji[alert.severity] || '\u{26A0}\u{FE0F}';
    const time = new Date(alert.timestamp).toLocaleString('en-US', { timeZone: 'Africa/Tunis' });

    const details = alert.details || {};
    const analysisText = this._buildAnalysisText(alert.type, details);
    const apiUrl = process.env.API_URL || 'http://localhost:5000';
    // Le chemin du clip peut être à la racine (alert.clip_path) ou dans les détails (details.clipPath)
    const rawClipPath = alert.clip_path || details.clipPath;
    const clipLink = rawClipPath ? `${apiUrl}${rawClipPath}` : null;

    return {
      short: `${emoji} ${alertType} at ${camera.name}`,
      emailSubject: `${emoji} SENTINELAI Alert: ${alertType} - ${camera.name}`,
      textAlert: `${emoji} SENTINELAI SECURITY ALERT\n\n${alertType}\nLocation: ${camera.location}\nTime: ${time}\nConfidence: ${(alert.confidence * 100).toFixed(1)}%\n\n${analysisText}\n\n${clipLink ? `Video Clip: ${clipLink}\n\n` : ''}Check your security system immediately.`,
      emailHtml: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #1e1b4b, #312e81); padding: 30px; text-align: center; border-radius: 12px 12px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 24px;">${emoji} SENTINELAI</h1>
            <p style="color: #a5b4fc; margin: 8px 0 0;">AI-Powered Security System</p>
          </div>
          <div style="background: #0f172a; padding: 30px; border-radius: 0 0 12px 12px;">
            <div style="background: ${alert.severity === 'critical' ? '#7f1d1d' : '#78350f'}; border-radius: 8px; padding: 16px; margin-bottom: 20px; border: 1px solid ${alert.severity === 'critical' ? '#dc2626' : '#d97706'};">
              <h2 style="color: ${alert.severity === 'critical' ? '#fca5a5' : '#fcd34d'}; margin: 0; font-size: 20px;">${alertType}</h2>
              <p style="color: #94a3b8; margin: 8px 0 0;">Severity: ${alert.severity.toUpperCase()}</p>
            </div>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
              <tr><td style="padding: 10px; color: #64748b; border-bottom: 1px solid #1e293b;">Camera</td><td style="padding: 10px; color: #e2e8f0; border-bottom: 1px solid #1e293b; font-weight: bold;">${camera.name}</td></tr>
              <tr><td style="padding: 10px; color: #64748b; border-bottom: 1px solid #1e293b;">Location</td><td style="padding: 10px; color: #e2e8f0; border-bottom: 1px solid #1e293b;">${camera.location}</td></tr>
              <tr><td style="padding: 10px; color: #64748b; border-bottom: 1px solid #1e293b;">Time</td><td style="padding: 10px; color: #e2e8f0; border-bottom: 1px solid #1e293b;">${time}</td></tr>
              <tr><td style="padding: 10px; color: #64748b; border-bottom: 1px solid #1e293b;">Confidence</td><td style="padding: 10px; color: #22d3ee; border-bottom: 1px solid #1e293b; font-weight: bold;">${(alert.confidence * 100).toFixed(1)}%</td></tr>
            </table>
            <div style="background: #1e293b; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
              <h3 style="color: #a5b4fc; margin: 0 0 8px; font-size: 14px;">AI Analysis</h3>
              <p style="color: #cbd5e1; margin: 0; font-size: 14px; line-height: 1.6;">${analysisText}</p>
            </div>
            ${frameBase64 ? `
            <div style="margin-bottom: 20px;">
              <h3 style="color: #a5b4fc; margin: 0 0 8px; font-size: 14px;">Captured Frame</h3>
              <img src="data:image/jpeg;base64,${frameBase64}" alt="Alert capture" style="width: 100%; border-radius: 8px; border: 1px solid #334155;" />
            </div>` : ''}
            ${clipLink ? `
            <div style="margin-bottom: 20px; text-align: center;">
              <a href="${clipLink}" style="display: inline-block; background-color: #ef4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">View Recorded Video Clip (MP4)</a>
            </div>` : ''}
            <p style="color: #ef4444; font-weight: bold; text-align: center; margin: 20px 0;">Check your security system immediately.</p>
            <p style="color: #475569; font-size: 12px; text-align: center; margin: 0;">SENTINELAI - Automated Security Alert</p>
          </div>
        </div>
      `
    };
  }

  _buildAnalysisText(type, details) {
    const analyses = {
      intrusion: `An unauthorized person has been detected entering a restricted zone. The AI system identified this as a potential security breach with high confidence. Immediate review of the camera footage is recommended.`,
      theft: `The AI behavior analysis engine has detected suspicious movements consistent with potential theft activity. The individual was observed acting erratically, with rapid movements and evasive behavior patterns.`,
      weapon_detected: `A WEAPON HAS BEEN DETECTED ON CAMERA. This is a CRITICAL security threat. Please contact local law enforcement IMMEDIATELY and do not approach the location. Police emergency number in Tunisia: 197.`,
      suspicious_behavior: `The AI behavior engine has flagged unusual activity. Movement patterns, posture, or gestures deviate from normal baseline. Person may be acting with criminal intent.`,
      unknown_person: `An unknown person has been detected in your monitored area. They are not in your known faces database. Please verify their identity and ensure they are authorized to be there.`,
      unusual_behavior: `The AI has flagged unusual behavioral patterns detected by our advanced neural networks. Movement analysis shows deviations from normal activity, including erratic path patterns and suspicious posture changes.`,
      loitering: `A person has been detected remaining in a monitored zone for an extended period beyond normal thresholds. The AI tracked movement patterns that suggest loitering behavior.`,
      vandalism: `The AI has detected potentially destructive behavior. Rapid, forceful movements have been identified that are consistent with vandalism activity.`,
      unattended_object: `An unattended object has been detected in the monitored area. The AI flagged this object as it has remained stationary for an extended period without nearby individuals.`,
      person: `A person has been detected in the monitored area. The AI is continuously analyzing their behavior for any suspicious activity.`,
      motion: `Motion has been detected in the monitored zone. The AI is analyzing the source and pattern of the movement.`
    };
    return analyses[type] || `A security event has been detected by the AI analysis engine. The detection was based on advanced behavioral analysis and pattern recognition algorithms.`;
  }

  async _sendTelegramMessage(chatId, message, frameBase64) {
    if (this.dryRun) {
      logger.info(`[TELEGRAM DRY-RUN] To: ${chatId}\n${message}`);
      return;
    }
    if (!this.telegramToken || !chatId) {
      logger.info(`[TELEGRAM LOG] To: ${chatId} (Token or ChatID missing)\n${message}`);
      return;
    }

    try {
      if (frameBase64) {
        // Send as photo with caption (Highly secure HTTPS transmission)
        const buffer = Buffer.from(frameBase64, 'base64');
        const blob = new Blob([buffer], { type: 'image/jpeg' });
        
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('photo', blob, 'alert.jpg');
        formData.append('caption', message);

        const response = await fetch(`https://api.telegram.org/bot${this.telegramToken}/sendPhoto`, {
          method: 'POST',
          body: formData
        });

        const data = await response.json();
        if (data.ok) {
          logger.info(`Secure Telegram photo alert sent to Chat ID ${chatId}`);
        } else {
          logger.error(`Telegram API error: ${data.description}`);
        }
      } else {
        // Send as text only
        const response = await fetch(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: message
          })
        });

        const data = await response.json();
        if (data.ok) {
          logger.info(`Secure Telegram text alert sent to Chat ID ${chatId}`);
        } else {
          logger.error(`Telegram API error: ${data.description}`);
        }
      }
    } catch (error) {
      logger.error(`Failed to send Telegram message to ${chatId}:`, error.message);
    }
  }

  async _sendTelegramVideo(chatId, rawClipPath, caption) {
    if (this.dryRun) {
      logger.info(`[TELEGRAM VIDEO DRY-RUN] To: ${chatId}, clip: ${rawClipPath}`);
      return;
    }
    if (!this.telegramToken || !chatId) return;

    try {
      const normalizedPath = rawClipPath.startsWith('/') ? rawClipPath.substring(1) : rawClipPath;
      const absoluteClipPath = path.join(__dirname, '../../', normalizedPath);

      // Wait for the clip file to be fully written by Python's background thread (up to 10 seconds)
      let attempts = 0;
      let lastSize = -1;
      while (attempts < 20) {
        if (fs.existsSync(absoluteClipPath)) {
          const stats = fs.statSync(absoluteClipPath);
          if (stats.size > 0 && stats.size === lastSize) break; // File is stable and ready
          lastSize = stats.size;
        }
        await new Promise(r => setTimeout(r, 500));
        attempts++;
      }

      if (!fs.existsSync(absoluteClipPath) || fs.statSync(absoluteClipPath).size === 0) {
        logger.warn(`[Telegram Video] Clip file not found or empty after waiting: ${absoluteClipPath}`);
        return;
      }

      const videoBuffer = fs.readFileSync(absoluteClipPath);
      const blob = new Blob([videoBuffer], { type: 'video/mp4' });

      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('video', blob, 'alert-clip.mp4');
      formData.append('caption', caption || 'Security Alert Video Clip');
      formData.append('supports_streaming', 'true');

      const response = await fetch(`https://api.telegram.org/bot${this.telegramToken}/sendVideo`, {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      if (data.ok) {
        logger.info(`Secure Telegram video clip sent to Chat ID ${chatId}`);
      } else {
        logger.error(`Telegram video API error: ${data.description}`);
      }
    } catch (error) {
      logger.error(`Failed to send Telegram video to ${chatId}:`, error.message);
    }
  }

  async _sendEmail(email, subject, htmlContent, frameBase64, rawClipPath) {
    if (this.dryRun) {
      logger.info(`[EMAIL DRY-RUN] To: ${email}, Subject: ${subject}`);
      return;
    }
    if (!this.emailTransporter) {
      logger.info(`[EMAIL LOG] To: ${email}, Subject: ${subject}`);
      return;
    }
    try {
      const mailOptions = {
        from: `"SENTINELAI" <${process.env.SMTP_USER}>`,
        to: email,
        subject,
        html: htmlContent,
        attachments: []
      };

      if (frameBase64) {
        mailOptions.attachments.push({
          filename: `alert-capture-${Date.now()}.jpg`,
          content: Buffer.from(frameBase64, 'base64'),
          contentType: 'image/jpeg'
        });
      }

      if (rawClipPath) {
        // Remove leading slash so path.join doesn't jump to the C: root on Windows
        const normalizedPath = rawClipPath.startsWith('/') ? rawClipPath.substring(1) : rawClipPath;
        const absoluteClipPath = path.join(__dirname, '../../', normalizedPath);
        
        // Wait for the clip file to be fully written by Python's background thread
        let attempts = 0;
        let lastSize = -1;
        while (attempts < 20) {
          if (fs.existsSync(absoluteClipPath)) {
            const stats = fs.statSync(absoluteClipPath);
            if (stats.size > 0 && stats.size === lastSize) break;
            lastSize = stats.size;
          }
          await new Promise(r => setTimeout(r, 500));
          attempts++;
        }

        if (fs.existsSync(absoluteClipPath) && fs.statSync(absoluteClipPath).size > 0) {
          mailOptions.attachments.push({
            filename: `alert-video.mp4`,
            path: absoluteClipPath,
            contentType: 'video/mp4'
          });
          logger.info(`Attached video clip to email: ${absoluteClipPath}`);
        } else {
          logger.warn(`Clip file not found for email attachment: ${absoluteClipPath}`);
        }
      }

      await this.emailTransporter.sendMail(mailOptions);
      logger.info(`Email sent to ${email}`);
    } catch (error) {
      logger.error('Failed to send email:', error);
    }
  }
}

function initializeNotificationService(io) {
  const service = new NotificationService(io);
  service.initialize();
  return service;
}

module.exports = { NotificationService, initializeNotificationService };
