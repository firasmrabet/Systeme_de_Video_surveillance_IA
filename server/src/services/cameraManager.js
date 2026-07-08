const { logger } = require('../utils/logger');
const http = require('http');
const https = require('https');
const jpeg = require('jpeg-js');
const vault = require('../utils/vault');

class CameraManager {
  constructor(io) {
    this.io = io;
    this.cameras = new Map();
    this.activeDetections = new Map();
    this.aiDetection = null;
    this.unifiedAI = null;
    this.liveStreamer = null;   // Sera injecte par index.js pour reutiliser la frame du stream MJPEG
    this._frameStats = new Map(); // cameraId -> { fetched, decoded, failed, lastFetchAt, lastError }
  }

  setLiveStreamer(streamer) {
    this.liveStreamer = streamer;
    logger.info('[CameraManager] LiveStreamer reference set (frame sharing active)');
  }

  initialize() {
    logger.info('Camera Manager initialized - ready for user cameras');
  }

  setAIDetection(aiDetection) {
    this.aiDetection = aiDetection;
  }

  setUnifiedAI(unifiedAI) {
    this.unifiedAI = unifiedAI;
  }

  getCameras() {
    return Array.from(this.cameras.values());
  }

  getCamera(id) {
    return this.cameras.get(id);
  }

  registerCamera(cameraData) {
    let url = cameraData.url;
    // Normalize: downgrade https→http for non-standard TLS ports
    if (url) {
      try {
        const p = new URL(url);
        if (p.protocol === 'https:') {
          const port = parseInt(p.port) || 443;
          if (port !== 443 && port !== 4433) {
            p.protocol = 'http:';
            url = p.toString();
          }
        }
      } catch (_) {}
    }
    const isExternal = url && (url.startsWith('http://') || url.startsWith('https://'));
    // Auto-extract host/port from url if not provided (fix for cameras created without connection.host)
    let derivedHost = cameraData.host || null;
    let derivedPort = cameraData.port || null;
    if (!derivedHost && url) {
      try {
        const u = new URL(url);
        derivedHost = u.hostname || null;
        derivedPort = u.port || null;
      } catch (_) {}
    }
    const camera = {
      id: cameraData.id,
      name: cameraData.name,
      location: cameraData.location,
      url: url,
      snapshotUrl: cameraData.snapshotUrl || url,
      streamUrl: cameraData.streamUrl || url,
      // Auth/connection details (decrypted) for the frame capture
      host: derivedHost,
      port: derivedPort,
      username: cameraData.username || null,
      password: cameraData.password || null,  // Should already be decrypted by caller
      useTLS: !!cameraData.useTLS,
      status: 'online',
      type: isExternal ? 'external' : 'simulated',
      fps: cameraData.fps || parseInt(process.env.CAMERA_FPS) || 15,
      resolution: cameraData.resolution || `${process.env.CAMERA_RESOLUTION_WIDTH || 1280}x${process.env.CAMERA_RESOLUTION_HEIGHT || 720}`
    };
    this.cameras.set(cameraData.id, camera);
    logger.info(`Registered camera ${cameraData.id} (${camera.name}): ${camera.type} @ ${camera.url}`);
    return camera;
  }

  unregisterCamera(cameraId) {
    this.stopDetection(cameraId);
    this.cameras.delete(cameraId);
    this._frameStats.delete(cameraId);
    logger.info(`Unregistered camera ${cameraId}`);
  }

  /**
   * Load all cameras from the database on startup so detection works after restart.
   */
  async loadCamerasFromDB(db, vaultModule) {
    try {
      const cameras = await db.getAllCameras();
      let loaded = 0;
      for (const cam of cameras) {
        if (!cam.url) continue;
        const conn = cam.connection || {};
        const decryptedPass = (vaultModule || vault).decrypt(conn.password);
        // Build snapshotUrl from host:port and snapshotPath (if available)
        const proto = conn.useTLS ? 'https' : 'http';
        const portPart = conn.port ? `:${conn.port}` : '';
        const snapshotUrl = conn.snapshotPath 
            ? `${proto}://${conn.host}${portPart}${conn.snapshotPath}`
            : `${proto}://${conn.host}${portPart}/shot.jpg`;
        // Ensure streamUrl is absolute — build from connection if cam.url is just a path
        let streamUrl = cam.url;
        if (streamUrl && !/^https?:\/\//i.test(streamUrl)) {
          const portPart = conn.port ? `:${conn.port}` : '';
          const path = streamUrl.startsWith('/') ? streamUrl : `/${streamUrl}`;
          streamUrl = `${proto}://${conn.host}${portPart}${path}`;
        }
        this.registerCamera({
          id: cam.id,
          name: cam.name,
          location: cam.location,
          url: cam.url,
          snapshotUrl,
          streamUrl,
          host: conn.host,
          port: conn.port,
          username: conn.username || null,
          password: decryptedPass || null,
          useTLS: !!conn.useTLS,
          fps: cam.fps || parseInt(process.env.CAMERA_FPS) || 15,
          resolution: cam.resolution || `${process.env.CAMERA_RESOLUTION_WIDTH || 1280}x${process.env.CAMERA_RESOLUTION_HEIGHT || 720}`
        });
        loaded++;
      }
      logger.info(`Loaded ${loaded} cameras from database`);
    } catch (e) {
      logger.error('Failed to load cameras from database:', e.message);
    }
  }

  // Use keepAlive agents to reuse connections and lower overhead
  getAgent(isHttps) {
    if (isHttps) {
      if (!this.httpsAgent) this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 5, timeout: 5000 });
      return this.httpsAgent;
    } else {
      if (!this.httpAgent) this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 5, timeout: 5000 });
      return this.httpAgent;
    }
  }

  async startDetection(cameraId, aiDetection) {
    if (this.activeDetections.has(cameraId)) return;

    const camera = this.cameras.get(cameraId);
    if (!camera) {
      logger.warn(`[Detection] Camera ${cameraId} not registered`);
      return;
    }
    if (camera.type !== 'external' || !camera.url) {
      logger.warn(`Cannot start detection for non-external camera ${cameraId}`);
      return;
    }

    logger.info(`[Detection] Starting for camera ${cameraId} (${camera.name}) @ ${camera.url}`);
    this._frameStats.set(cameraId, { fetched: 0, decoded: 0, failed: 0, lastFetchAt: null, lastError: null });

    const useUnified = !!this.unifiedAI;
    let frameCount = 0;
    let consecutiveFailures = 0;

    const detectionLoop = async () => {
      while (this.activeDetections.has(cameraId)) {
        try {
          // OPTIMISATION : on reutilise la derniere frame du stream MJPEG
          // pour eviter une 2eme connexion HTTP vers la webcam (IP Webcam = single-threaded).
          let frame = null;
          const reusedJpeg = this.liveStreamer?.getLastJpeg?.(cameraId);
          if (reusedJpeg) {
            frame = { jpeg: reusedJpeg, width: 0, height: 0, source: 'stream' };
            this._bumpStat(cameraId, 'fetched', null);
            this._bumpStat(cameraId, 'decoded', null);
          } else {
            // Aucun abonne au stream (personne ne regarde la cam) et pas de frame partagee.
            // On economise la connexion HTTP en attendant plus longtemps (5s) — sinon on
            // martellerait /shot.jpg a 2 FPS pour rien, ce qui sature l'IP Webcam.
            const subs = this.liveStreamer?.streams?.get(cameraId)?.subscribers?.size || 0;
            if (subs === 0) {
              await this._sleep(5000);
              continue;
            }
            // Fallback : on fetch une frame nous-memes
            frame = await this._captureFrameFromUrl(camera, cameraId);
          }

          if (!frame || !frame.jpeg) {
            consecutiveFailures++;
            const backoff = Math.min(30000, 2000 * Math.pow(2, Math.min(consecutiveFailures - 1, 4)));
            const stats = this._frameStats.get(cameraId);
            if (stats && (consecutiveFailures === 1 || consecutiveFailures % 5 === 0)) {
              logger.warn(`[Detection] Frame capture failed for ${cameraId} (${consecutiveFailures} consecutive, backing off ${backoff}ms, last: ${stats.lastError || 'unknown'})`);
            }
            await this._sleep(backoff);
            continue;
          }
          consecutiveFailures = 0;

          frameCount++;
          if (frameCount === 1 || frameCount % 30 === 0) {
            const src = frame.source || 'url';
            logger.info(`[Detection] Frame #${frameCount} captured for ${cameraId} (${frame.jpeg.length} bytes, source=${src})`);
          }

          if (useUnified) {
            await this.unifiedAI.detect(frame.jpeg, cameraId);
          } else {
            await aiDetection.detect(frame, cameraId);
          }

          // 2 FPS pour la detection AI (3 models YOLO optimisés à 320px) ;
          // le stream MJPEG reste a 30 FPS pour la video temps reel
          await this._sleep(500);
        } catch (error) {
          logger.error(`[Detection] Error for camera ${cameraId}:`, error.message || error);
          await this._sleep(2000);
        }
      }
      logger.info(`[Detection] Loop ended for ${cameraId} after ${frameCount} frames`);
    };

    this.activeDetections.set(cameraId, detectionLoop);
    detectionLoop();
  }

  stopDetection(cameraId) {
    if (this.activeDetections.has(cameraId)) {
      this.activeDetections.delete(cameraId);
      logger.info(`Stopped detection for camera ${cameraId}`);
    }
  }

  getDetectionStats(cameraId) {
    return this._frameStats.get(cameraId) || null;
  }

  /**
   * _captureFrameFromUrl — Fetch a single JPEG frame from the IP camera.
   * Tries the snapshot URL first, then falls back to common paths.
   * Handles auth (Basic) and self-signed HTTPS certs.
   */
  _captureFrameFromUrl(camera, cameraId) {
    return new Promise((resolve) => {
      // Build a list of candidate URLs to try
      const candidates = [];
      if (camera.snapshotUrl) candidates.push(camera.snapshotUrl);
      if (camera.host) {
        const proto = camera.useTLS ? 'https' : 'http';
        const portPart = camera.port ? `:${camera.port}` : '';
        const authPart = camera.username
          ? `${encodeURIComponent(camera.username)}:${encodeURIComponent(camera.password || '')}@`
          : '';
        // IP Webcam snapshot paths — single JPEG, not MJPEG stream
        candidates.push(`${proto}://${authPart}${camera.host}${portPart}/shot.jpg`);
        candidates.push(`${proto}://${authPart}${camera.host}${portPart}/photo.jpg`);
        candidates.push(`${proto}://${authPart}${camera.host}${portPart}/photoaf.jpg`);
        candidates.push(`${proto}://${authPart}${camera.host}${portPart}/image.jpg`);
        candidates.push(`${proto}://${authPart}${camera.host}${portPart}/snapshot.jpg`);
        candidates.push(`${proto}://${authPart}${camera.host}${portPart}/jpg/image.jpg`);
        candidates.push(`${proto}://${authPart}${camera.host}${portPart}/cgi-bin/snapshot.cgi`);
        // MJPEG stream endpoints — we can extract a single frame from these
        candidates.push(`${proto}://${authPart}${camera.host}${portPart}/video`);
        candidates.push(`${proto}://${authPart}${camera.host}${portPart}/?action=stream`);
        candidates.push(`${proto}://${authPart}${camera.host}${portPart}/videofeed`);

        // Robustness: If the user forgot the IP Webcam Android port (8080) and left it as default (80)
        if (!camera.port || camera.port === 80) {
          candidates.push(`${proto}://${authPart}${camera.host}:8080/shot.jpg`);
          candidates.push(`${proto}://${authPart}${camera.host}:8080/photo.jpg`);
          candidates.push(`${proto}://${authPart}${camera.host}:8080/video`);
          candidates.push(`${proto}://${authPart}${camera.host}:8080/videofeed`);
        }
      }

      const tryNext = (i) => {
        if (i >= candidates.length) {
          logger.error(`[CameraManager] All ${candidates.length} snapshot URLs failed for ${cameraId}. Tried: ${candidates.join(', ')}`);
          this._bumpStat(cameraId, 'failed', 'all_candidates_failed');
          resolve(null);
          return;
        }
        const url = candidates[i];
        // Context-aware timeout: local cameras are fast, remote might be slow
        let timeout = 4000; // default
        if (camera.type === 'simulated' || camera.host?.includes('localhost') || camera.host?.includes('127.0.0.1')) {
          timeout = 2000;
        } else if (camera.url?.includes('localhost') || camera.url?.includes('127.0.0.1')) {
          timeout = 3000;
        }
        
        logger.debug(`[CameraManager] Trying snapshot [${i+1}/${candidates.length}] (${timeout}ms): ${url.substring(0, 80)}`);
        this._tryFetchFrame(url, camera, timeout)
          .then((frame) => {
            if (frame) {
              logger.info(`[CameraManager] ✅ Frame captured from URL ${i+1}: ${url.substring(0, 80)}`);
              this._bumpStat(cameraId, 'fetched', null);
              this._bumpStat(cameraId, 'decoded', null);
              resolve(frame);
            } else {
              logger.debug(`[CameraManager] URL ${i+1} returned no frame, trying next...`);
              tryNext(i + 1);
            }
          })
          .catch((err) => {
            logger.debug(`[CameraManager] URL ${i+1} error: ${err?.message}, trying next...`);
            tryNext(i + 1);
          });
      };

      tryNext(0);
    });
  }

  _tryFetchFrame(urlStr, camera, timeout = 4000) {
    return new Promise((resolve) => {
      let url;
      try { url = new URL(urlStr); } catch (e) {
        resolve(null);
        return;
      }
      const isHttps = url.protocol === 'https:';
      const headers = {
        'User-Agent': 'SentinelAI/2.0',
        'Accept': 'image/jpeg,image/jpg,image/*;q=0.9,*/*;q=0.8'
      };
      if (camera.username) {
        const auth = Buffer.from(`${camera.username}:${camera.password || ''}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      }
      const reqOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        timeout,
        agent: this.getAgent(isHttps)
      };
      if (isHttps) reqOptions.rejectUnauthorized = false;
      const protocol = isHttps ? https : http;
      const req = protocol.request(reqOptions, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const ct = (res.headers['content-type'] || '').toLowerCase();
        const isMultipart = ct.includes('multipart') || ct.includes('mixed-replace');

        if (isMultipart) {
          // MJPEG stream — extract the first JPEG frame
          let buffer = Buffer.alloc(0);
          let foundEnd = false;
          const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            // Look for JPEG end marker (FF D9) in accumulated data
            for (let i = buffer.length - chunk.length - 2; i < buffer.length - 1; i++) {
              if (i >= 0 && buffer[i] === 0xFF && buffer[i + 1] === 0xD9) {
                // Found JPEG end marker — extract the frame
                const frame = buffer.slice(0, i + 2);
                foundEnd = true;
                res.removeListener('data', onData);
                res.destroy();
                if (frame.length > 500 && frame[0] === 0xFF && frame[1] === 0xD8) {
                  resolve({
                    cameraId: camera.id,
                    timestamp: Date.now(),
                    width: 1280, height: 720,
                    data: null, jpeg: frame
                  });
                } else {
                  resolve(null);
                }
                return;
              }
            }
            // Cap at dynamic size based on resolution
            const maxBuffer = camera.resolution?.includes('4K') 
              ? 5 * 1024 * 1024
              : camera.resolution?.includes('2K')
                ? 3 * 1024 * 1024
                : 2 * 1024 * 1024;
            
            if (buffer.length > maxBuffer) {
              logger.warn(`[CameraManager] Buffer for ${camera.id} exceeded ${(maxBuffer/1024/1024).toFixed(1)}MB, truncating`);
              res.removeListener('data', onData);
              res.destroy();
              resolve(null);
            }
          };
          res.on('data', onData);
          // Timeout for stream extraction
          const streamTimeout = setTimeout(() => {
            if (!foundEnd) { res.removeListener('data', onData); res.destroy(); resolve(null); }
          }, 5000);
          res.on('close', () => clearTimeout(streamTimeout));
          res.on('error', () => { clearTimeout(streamTimeout); resolve(null); });
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        const MAX_BYTES = 5 * 1024 * 1024; // 5MB cap to prevent OOM on stream responses
        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_BYTES) {
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          // Validate JPEG magic bytes (FF D8 FF)
          if (buffer.length < 500 || buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
            resolve(null);
            return;
          }
          try {
            const decoded = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 64 });
            resolve({
              cameraId: camera.id,
              timestamp: Date.now(),
              width: decoded?.width || 1280,
              height: decoded?.height || 720,
              data: decoded?.data ? Buffer.from(decoded.data) : null,
              jpeg: buffer
            });
          } catch (e) {
            // Even if decode fails, return the jpeg buffer — unifiedAI only needs the jpeg
            resolve({
              cameraId: camera.id,
              timestamp: Date.now(),
              width: 1280,
              height: 720,
              data: null,
              jpeg: buffer
            });
          }
        });
        res.on('error', () => resolve(null));
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  _bumpStat(cameraId, field, errorMessage) {
    const stats = this._frameStats.get(cameraId);
    if (!stats) return;
    if (field === 'fetched' || field === 'decoded') stats[field] = (stats[field] || 0) + 1;
    if (field === 'failed') {
      stats.failed = (stats.failed || 0) + 1;
      if (errorMessage) stats.lastError = errorMessage;
    }
    stats.lastFetchAt = Date.now();
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { CameraManager };

