/**
 * Unified AI Detection Service v2
 * Replaces the old heuristic engine. Uses:
 * - aiBridge (Python + YOLOv8 + Pose + Weapons + Faces)
 * - threatScoring (multi-criteria scoring)
 *
 * Returns structured detections + critical alerts ready for notifications.
 */
const { logger } = require('../utils/logger');
const db = require('../utils/database');
const aiBridge = require('./aiBridge');
const threatScoring = require('./threatScoring');
const statsTracker = require('./statsTracker');
const fs = require('fs');
const path = require('path');

class UnifiedAIDetectionService {
  constructor() {
    this.io = null;
    this.notifications = null;
    this.alertCooldowns = new Map();
    this.detectionHistory = new Map();
    this.knownFacesByUser = new Map();
  }

  async initialize(io) {
    this.io = io;
    try {
      await aiBridge.start();
      // Chap 14.2 — enregistre l'uptime de l'engine
      try { statsTracker.setEngineStarted(); } catch (_) {}
      logger.info('[UnifiedAI] Service initialized');
    } catch (e) {
      logger.error('[UnifiedAI] Init failed:', e);
    }
  }

  setNotifications(notifications) {
    this.notifications = notifications;
  }

  async loadKnownFaces(userId) {
    try {
      const user = await db.getUserById(userId);
      if (user && user.knownFaces && user.knownFaces.length > 0) {
        this.knownFacesByUser.set(userId, user.knownFaces);
        threatScoring.setKnownFaces(userId, user.knownFaces);
        logger.info(`[UnifiedAI] Loaded ${user.knownFaces.length} known faces for user ${userId}`);
      } else {
        this.knownFacesByUser.set(userId, []);
        threatScoring.setKnownFaces(userId, []);
      }
    } catch (e) {
      logger.error('[UnifiedAI] Failed to load known faces:', e);
    }
  }

  async detect(jpegBuffer, cameraId) {
    try {
      const camera = await db.getCameraById(cameraId);
      if (!camera) return null;

      // Load known faces for this user if not already
      if (!this.knownFacesByUser.has(camera.ownerId)) {
        await this.loadKnownFaces(camera.ownerId);
      }
      const knownFaces = this.knownFacesByUser.get(camera.ownerId) || [];

      // Call Python AI
      const aiResult = await aiBridge.detect(jpegBuffer, {
        cameraId: camera.id,
        knownFaces,
        zones: camera.zones || []
      });

      // Extract annotated frame (if present) before formatting/scoring
      const annotatedFrame = aiResult?.annotated_frame || null;
      if (aiResult) delete aiResult.annotated_frame;

      if (annotatedFrame) {
        this.io?.to(`camera-${cameraId}`).emit('annotated-frame', {
          cameraId,
          frame: annotatedFrame,
          timestamp: new Date().toISOString()
        });
      }

      if (!aiResult || aiResult.error) {
        logger.warn(`[UnifiedAI] AI returned no result for ${cameraId}: ${aiResult?.error}`);
        return null;
      }

      // Extract and emit annotated frame efficiently (reads from disk, avoids JSON.parse block)
      if (aiResult.annotated_frame_path) {
        // __dirname is server/src/services. Go up to server, then into temp
        const framePath = path.join(__dirname, '..', '..', aiResult.annotated_frame_path);
        delete aiResult.annotated_frame_path;
        
        fs.readFile(framePath, (err, buffer) => {
          if (err) {
            logger.error(`[UnifiedAI] Failed to read frame from ${framePath}: ${err.message}`);
          } else {
            this.io?.to(`camera-${cameraId}`).emit('annotated-frame', {
              cameraId,
              frame: buffer.toString('base64'), // Convert back to base64 for foolproof client parsing
              timestamp: new Date().toISOString()
            });
          }
        });
      }

      // Score the threat (for secondary signals)
      const scoring = threatScoring.score(aiResult, {
        cameraId,
        userId: camera.ownerId,
        zones: camera.zones || []
      });

      // Process Python-native critical alerts (with clips) FIRST
      if (aiResult.alerts && aiResult.alerts.length > 0) {
        for (const pythonAlert of aiResult.alerts) {
          // Python alerts bypass threatScoring because they are pre-filtered
          // and have verified clips
          await this._processCriticalAlert(pythonAlert, aiResult, camera, jpegBuffer);
        }
      } else if (scoring.shouldAlert) {
        // Fallback to JS-based scoring for non-critical alerts
        await this._processAlert(scoring, aiResult, camera, jpegBuffer);
      }

      // Emit to frontend
      this.io?.to(`camera-${cameraId}`).emit('detections', {
        cameraId,
        detections: this._formatDetectionsForClient(aiResult, scoring),
        threatScore: scoring.score,
        threatType: scoring.threatType,
        severity: scoring.severity,
        summary: scoring.summary,
        timestamp: new Date().toISOString()
      });

      return { aiResult, scoring };
    } catch (e) {
      logger.error(`[UnifiedAI] detect error for ${cameraId}:`, e);
      return null;
    }
  }

  _formatDetectionsForClient(aiResult, scoring) {
    const out = [];
    for (const person of aiResult.persons || []) {
      const pose = (aiResult.poses || []).find(p => p.track_id === person.track_id);
      
      // Determine if there is a behavior alert matching this person
      const behavior = pose?.behavior || null;
      let type = 'person';
      if (behavior) {
        const behLower = behavior.toLowerCase();
        if (['violence', 'fighting', 'assault', 'shooting'].includes(behLower)) type = 'violence';
        else if (['theft', 'stealing', 'shoplifting', 'robbery'].includes(behLower)) type = 'theft';
        else if (behLower === 'intrusion') type = 'intrusion';
      }

      out.push({
        type: type,
        trackId: person.track_id,
        boundingBox: this._bboxToRelative(person.bbox, aiResult.frame_size),
        confidence: person.conf || 0.9,
        behavior: behavior,
        behaviorConf: pose?.behavior_conf || 0,
        posture: pose?.posture || 'unknown',
        gesture: pose?.gesture || 'unknown',
        zone: pose?.zone || null
      });
    }
    for (const weapon of aiResult.weapons || []) {
      out.push({
        type: 'weapon',
        class: weapon.class,
        boundingBox: this._bboxToRelative(weapon.bbox, aiResult.frame_size),
        confidence: weapon.confidence,
        severity: 'critical'
      });
    }
    for (const face of aiResult.faces || []) {
      out.push({
        type: 'face',
        boundingBox: this._bboxToRelative(face.bbox, aiResult.frame_size),
        isKnown: face.is_known,
        name: face.matched_name,
        similarity: face.similarity
      });
    }
    return out;
  }

  _bboxToRelative(bbox, frameSize) {
    if (!bbox || !frameSize) return null;
    const [x1, y1, x2, y2] = bbox;
    const [w, h] = frameSize;
    return { x: x1 / w, y: y1 / h, width: (x2 - x1) / w, height: (y2 - y1) / h };
  }

  async _processCriticalAlert(pythonAlert, aiResult, camera, jpegBuffer) {
    const alertCount = await db.getRecentAlertCount(camera.ownerId, 60);
    if (alertCount >= 20) return; // Still respect anti-spam

    const alert = await db.createAlert({
      cameraId: camera.id,
      ownerId: camera.ownerId,
      type: pythonAlert.type,
      severity: pythonAlert.severity || 'critical',
      confidence: 1.0, // Python alerts are pre-confirmed temporally
      details: {
        summary: `Incident détecté: ${pythonAlert.type}`,
        clipPath: pythonAlert.clip_path,
        requiresHuman: true
      },
      frameBase64: jpegBuffer.toString('base64')
    });

    this.io?.to(`camera-${camera.id}`).emit('alert', alert);
    if (this.notifications) this.notifications.emitAlertToOwner(alert);

    // Chap 14.2 — Compteur d'alertes pour le monitoring
    try { statsTracker.recordAlert(); } catch (_) {}

    if (this.notifications) {
      // Send with clip info if available
      this.notifications.sendAlert(alert, jpegBuffer.toString('base64'));
    }
    
    logger.info(`[UnifiedAI] CRITICAL ALERT ${alert.severity}: ${alert.type} for camera ${camera.id} (Clip: ${pythonAlert.clip_path})`);
  }

  async _processAlert(scoring, aiResult, camera, jpegBuffer) {
    const cooldownKey = `${camera.id}_${scoring.threatType}`;
    const lastAlert = this.alertCooldowns.get(cooldownKey);
    // Cooldown from env (default 30s) to prevent spam while keeping alerts responsive
    const cooldownMs = (parseInt(process.env.ALERT_COOLDOWN_SECONDS) || 30) * 1000;
    if (lastAlert && (Date.now() - lastAlert) < cooldownMs) return;

    // MULTI-FRAME CONFIRMATION: require the same critical threat in N consecutive frames
    // (4 frames eliminates false positives from phones/bottles detected as weapons)
    const REQUIRED_CONSECUTIVE = 4;
    const historyKey = `${camera.id}_${scoring.threatType}`;
    const history = this.detectionHistory.get(historyKey) || [];
    // Push this frame's detection
    history.push({ ts: Date.now(), confirmed: scoring.shouldCriticalAlert || scoring.shouldAlert });
    // Keep only last 10 frames (~10s at 1 FPS)
    while (history.length > 10) history.shift();
    this.detectionHistory.set(historyKey, history);

    // Count consecutive confirmations ending at the most recent frame
    let consecutive = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].confirmed) consecutive++;
      else break;
    }
    
    // Check if Python engine already confirmed an alert and generated a clip
    const hasPythonAlert = aiResult.alerts && aiResult.alerts.length > 0;
    const pythonAlert = hasPythonAlert ? aiResult.alerts[0] : null;

    // Only proceed if we have N consecutive confirmed frames OR Python triggered it
    if (consecutive < REQUIRED_CONSECUTIVE && !hasPythonAlert) {
      logger.debug(`[UnifiedAI] Threat ${scoring.threatType} on ${camera.id}: ${consecutive}/${REQUIRED_CONSECUTIVE} consecutive confirmations, waiting...`);
      return;
    }

    // Force threatType to match Python's if Python triggered it
    if (hasPythonAlert) {
      scoring.threatType = pythonAlert.type;
      scoring.severity = pythonAlert.severity;
    }

    const alertCount = await db.getRecentAlertCount(camera.ownerId, 60);
    if (alertCount >= 20) return;

    // Extraire le clip_path depuis les alertes Python
    const clip_path = pythonAlert ? pythonAlert.clip_path : null;

    const alert = await db.createAlert({
      cameraId: camera.id,
      ownerId: camera.ownerId,
      type: scoring.threatType,
      severity: scoring.severity,
      confidence: scoring.score,
      clip_path: clip_path,
      details: {
        summary: scoring.summary,
        signals: scoring.signals,
        personCount: scoring.personCount,
        unknownCount: scoring.unknownCount,
        knownCount: scoring.knownCount,
        weaponCount: scoring.weaponCount,
        isNight: scoring.isNight,
        consecutiveFrames: consecutive,
        weapons: (aiResult.weapons || []).map(w => ({ class: w.class, confidence: w.confidence })),
        faces: (aiResult.faces || []).map(f => ({ isKnown: f.is_known, name: f.matched_name, similarity: f.similarity })),
        poses: (aiResult.poses || []).map(p => ({ track_id: p.track_id, posture: p.posture, gesture: p.gesture }))
      },
      frameBase64: jpegBuffer.toString('base64')
    });

    this.alertCooldowns.set(cooldownKey, Date.now());
    this.io?.to(`camera-${camera.id}`).emit('alert', alert);
    if (this.notifications) this.notifications.emitAlertToOwner(alert);

    if (this.notifications) {
      this.notifications.sendAlert(alert, jpegBuffer.toString('base64'));
    }

    logger.info(`[UnifiedAI] ALERT ${alert.severity}: ${alert.type} for camera ${camera.id} (score: ${(scoring.score * 100).toFixed(0)}%, confirmed ${consecutive} frames)`);
  }

  async shutdown() {
    await aiBridge.stop();
  }
}

module.exports = new UnifiedAIDetectionService();
