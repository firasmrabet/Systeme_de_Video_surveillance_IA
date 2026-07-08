/**
 * Live JPEG Streamer — WebSocket-based low-latency streaming
 *
 * PRIMARY: Connects to the camera's MJPEG stream and parses multipart
 * boundaries on the SERVER side, pushing individual JPEG frames via Socket.IO.
 *
 * FALLBACK: If the camera doesn't support MJPEG streaming, falls back to
 * polling _captureFrameFromUrl at STREAM_FPS rate.
 *
 * EPOCH TRACKING: Each stream has an epoch counter that increments on every
 * start/stop. Callbacks from previous epochs are silently discarded, preventing
 * duplicate streams and corrupted buffers caused by React StrictMode's
 * rapid mount/unmount/mount cycle.
 */
const { logger } = require('../utils/logger');
const http = require('http');
const https = require('https');

const STREAM_FPS = parseInt(process.env.LIVE_STREAM_FPS) || 30;
const STREAM_INTERVAL_MS = Math.floor(1000 / STREAM_FPS);
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB cap to prevent memory leaks

class LiveJPEGStreamer {
  constructor(cameraManager) {
    this.cameraManager = cameraManager;
    /** cameraId -> stream state */
    this.streams = new Map();
    this._io = null;
  }

  setIO(io) {
    this._io = io;
  }

  // ==================== SUBSCRIBE / UNSUBSCRIBE ====================
  subscribe(cameraId, socket, streamUrl) {
    if (!this.streams.has(cameraId)) {
      this.streams.set(cameraId, this._createStream(streamUrl));
    }
    const stream = this.streams.get(cameraId);
    stream.subscribers.add(socket);
    socket.join(`live-${cameraId}`);

    if (!stream.running) {
      this._startStream(cameraId, stream);
    }

    // Send last frame immediately so the client doesn't see a blank screen
    if (stream.lastJpeg) {
      try { socket.emit(`live-frame-${cameraId}`, stream.lastJpeg); } catch (_) {}
    }

    logger.info(`[LiveStream] ${socket.id} subscribed to ${cameraId} (${stream.subscribers.size} subs)`);
  }

  unsubscribe(cameraId, socket) {
    const stream = this.streams.get(cameraId);
    if (!stream) return;
    stream.subscribers.delete(socket);
    socket.leave(`live-${cameraId}`);
    if (stream.subscribers.size === 0) {
      this._stopStream(cameraId, stream);
    }
    logger.info(`[LiveStream] ${socket.id} unsubscribed from ${cameraId} (${stream.subscribers.size} subs)`);
  }

  unsubscribeAll(socket) {
    for (const [cameraId, stream] of this.streams) {
      if (stream.subscribers.has(socket)) {
        stream.subscribers.delete(socket);
        socket.leave(`live-${cameraId}`);
        if (stream.subscribers.size === 0) {
          this._stopStream(cameraId, stream);
        }
      }
    }
  }

  setStreamUrl(cameraId, url) {
    const stream = this.streams.get(cameraId);
    if (stream) {
      stream.forcedUrl = url;
      if (stream.running) {
        this._stopStream(cameraId, stream);
        setTimeout(() => {
          if (stream.subscribers.size > 0) {
            this._startStream(cameraId, stream);
          }
        }, 500);
      }
    }
  }

  // ==================== STREAM LIFECYCLE ====================
  _createStream(streamUrl) {
    return {
      subscribers: new Set(),
      lastJpeg: null,
      lastBroadcastTs: 0,
      running: false,
      epoch: 0,           // Prevents stale callbacks from corrupting state
      interval: null,
      frameCount: 0,
      dropped: 0,
      mjpegBuffer: Buffer.alloc(0),
      mjpegBoundary: null,
      mjpegReq: null,
      isMjpegMode: false,
      forcedUrl: streamUrl || null
    };
  }

  _startStream(cameraId, stream) {
    if (stream.running) return;
    // Increment epoch — all callbacks from previous epochs will be silently ignored
    stream.epoch++;
    stream.running = true;
    stream.frameCount = 0;
    stream.dropped = 0;
    stream.mjpegBuffer = Buffer.alloc(0);
    stream.mjpegBoundary = null;
    stream.isMjpegMode = false;
    logger.info(`[LiveStream] Starting for ${cameraId} (epoch ${stream.epoch})`);
    this._tryMjpegStream(cameraId, stream, stream.epoch);
  }

  _stopStream(cameraId, stream) {
    const wasRunning = stream.running;
    const oldEpoch = stream.epoch;
    // Increment epoch to INVALIDATE all pending HTTP callbacks from previous epoch
    stream.epoch++;
    stream.running = false;
    stream.isMjpegMode = false;
    if (stream.interval) { clearInterval(stream.interval); stream.interval = null; }
    if (stream.mjpegReq) {
      try { stream.mjpegReq.destroy(); } catch (_) {}
      stream.mjpegReq = null;
    }
    stream.mjpegBuffer = Buffer.alloc(0);
    stream.mjpegBoundary = null;
    if (wasRunning) {
      logger.info(`[LiveStream] Stopped for ${cameraId} (epoch ${oldEpoch}, frames: ${stream.frameCount}, dropped: ${stream.dropped})`);
    }
  }

  // ==================== MJPEG STREAM (primary) ====================
  _tryMjpegStream(cameraId, stream, epoch) {
    // Stale epoch check
    if (stream.epoch !== epoch) return;

    // Build connection info and smart path list
    let host, port, useTLS, paths;
    const camera = this.cameraManager.getCamera(cameraId) || {};

    if (stream.forcedUrl) {
      try {
        const parsed = new URL(stream.forcedUrl);
        host = parsed.hostname;
        useTLS = parsed.protocol === 'https:';
        port = parseInt(parsed.port) || (useTLS ? 443 : 80);
        const urlPath = parsed.pathname + (parsed.search || '');
        // Try the exact URL path first, then common alternatives
        paths = [urlPath];
        if (urlPath !== '/') paths.push('/');
        if (urlPath !== '/videofeed') paths.push('/videofeed');
        if (urlPath !== '/video') paths.push('/video');
      } catch (e) {
        logger.warn(`[LiveStream] ${cameraId} invalid forced URL: ${stream.forcedUrl}`);
        this._startPollingLoop(cameraId, stream, epoch);
        return;
      }
    } else {
      if (!camera.host) {
        this._startPollingLoop(cameraId, stream, epoch);
        return;
      }
      host = camera.host;
      useTLS = camera.useTLS;
      port = camera.port || (useTLS ? 443 : 80);

      // Build smart path list: camera's own URL path first, then common paths
      paths = [];
      const cameraUrl = camera.streamUrl || camera.url;
      if (cameraUrl) {
        try {
          const parsed = new URL(cameraUrl);
          const urlPath = parsed.pathname + (parsed.search || '');
          if (urlPath) paths.push(urlPath);
          // Auto-detect protocol from the URL itself (fixes HTTPS vs HTTP mismatch)
          const urlUseTLS = parsed.protocol === 'https:';
          if (urlUseTLS !== useTLS) {
            useTLS = urlUseTLS;
            port = parseInt(parsed.port) || (useTLS ? 443 : 80);
            logger.info(`[LiveStream] ${cameraId} protocol corrected to ${useTLS ? 'HTTPS' : 'HTTP'}:${port} from URL`);
          }
        } catch (_) {}
      }
      // Add common MJPEG paths (skip duplicates)
      const commonPaths = ['/', '/videofeed', '/video', '/?action=stream', '/mjpegfeed', '/stream'];
      for (const p of commonPaths) {
        if (!paths.includes(p)) paths.push(p);
      }
    }

    const proto = useTLS ? 'https' : 'http';
    logger.info(`[LiveStream] ${cameraId} trying MJPEG on ${proto}://${host}:${port} paths=[${paths.join(', ')}]`);
    this._tryMjpegPath(cameraId, stream, epoch, camera, proto, host, port, paths, 0, false);
  }

  _tryMjpegPath(cameraId, stream, epoch, camera, proto, host, port, paths, idx, isPort8080Fallback) {
    // *** STALE CHECK — critical for preventing duplicate streams ***
    if (stream.epoch !== epoch) return;

    if (idx >= paths.length) {
      // Robustness: If the user forgot the IP Webcam Android port (8080) and left it as default (80)
      if (!isPort8080Fallback && (!camera.port || camera.port === 80)) {
        logger.info(`[LiveStream] ${cameraId} no MJPEG path works on port 80, trying port 8080 as fallback`);
        this._tryMjpegPath(cameraId, stream, epoch, camera, proto, host, 8080, paths, 0, true);
        return;
      }
      logger.warn(`[LiveStream] ${cameraId} no MJPEG path works, falling back to polling`);
      this._startPollingLoop(cameraId, stream, epoch);
      return;
    }

    const headers = { 'User-Agent': 'SentinelAI/2.0' };
    if (camera.username) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${camera.username}:${camera.password || ''}`).toString('base64');
    }

    const path = paths[idx];
    const lib = proto === 'https' ? https : http;

    const req = lib.request({
      hostname: host,
      port,
      path,
      method: 'GET',
      headers,
      timeout: 5000,
      ...(proto === 'https' ? { rejectUnauthorized: false } : {})
    }, (res) => {
      // Stale check inside callback — prevents ghost connections
      if (stream.epoch !== epoch) {
        res.destroy();
        return;
      }

      const ct = (res.headers['content-type'] || '').toLowerCase();
      const bm = ct.match(/boundary=([^;]+)/i);

      if (bm && ct.includes('multipart')) {
        // ═══ SUCCESS — valid MJPEG stream found ═══
        const rawB = bm[1].trim();
        stream.mjpegBoundary = Buffer.from(rawB.startsWith('--') ? rawB : '--' + rawB);
        stream.isMjpegMode = true;
        stream.mjpegReq = req;
        logger.info(`[LiveStream] ${cameraId} MJPEG stream OK via ${proto}://${host}:${port}${path} (boundary: ${rawB.slice(0, 30)})`);

        res.on('data', (chunk) => {
          if (stream.epoch !== epoch) { res.destroy(); return; }
          stream.mjpegBuffer = Buffer.concat([stream.mjpegBuffer, chunk]);
          // Cap buffer size to prevent memory leaks
          if (stream.mjpegBuffer.length > MAX_BUFFER_BYTES) {
            stream.mjpegBuffer = stream.mjpegBuffer.slice(-MAX_BUFFER_BYTES / 2);
            logger.warn(`[LiveStream] ${cameraId} buffer overflow, trimmed to ${stream.mjpegBuffer.length} bytes`);
          }
          this._processMjpegBuffer(cameraId, stream, epoch);
        });

        res.on('end', () => {
          if (stream.epoch !== epoch) return;
          if (stream.isMjpegMode && stream.running) {
            logger.info(`[LiveStream] ${cameraId} MJPEG stream ended, reconnecting in 1s`);
            stream.mjpegBuffer = Buffer.alloc(0);
            setTimeout(() => {
              if (stream.epoch !== epoch) return;
              this._tryMjpegPath(cameraId, stream, epoch, camera, proto, host, port, paths, idx, isPort8080Fallback);
            }, 1000);
          }
        });

        res.on('error', () => {
          if (stream.epoch !== epoch) return;
          if (stream.isMjpegMode && stream.running) {
            stream.mjpegBuffer = Buffer.alloc(0);
            logger.warn(`[LiveStream] ${cameraId} MJPEG error, reconnecting in 1s`);
            setTimeout(() => {
              if (stream.epoch !== epoch) return;
              this._tryMjpegPath(cameraId, stream, epoch, camera, proto, host, port, paths, idx, isPort8080Fallback);
            }, 1000);
          }
        });
      } else {
        // Not MJPEG — try next path
        res.destroy();
        if (stream.epoch !== epoch) return;
        this._tryMjpegPath(cameraId, stream, epoch, camera, proto, host, port, paths, idx + 1, isPort8080Fallback);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      if (stream.epoch !== epoch) return;
      this._tryMjpegPath(cameraId, stream, epoch, camera, proto, host, port, paths, idx + 1, isPort8080Fallback);
    });

    req.on('error', () => {
      if (stream.epoch !== epoch) return;
      this._tryMjpegPath(cameraId, stream, epoch, camera, proto, host, port, paths, idx + 1, isPort8080Fallback);
    });

    req.end();
  }

  // ==================== MJPEG BUFFER PARSER ====================
  // Robust JPEG-based parser — extracts the LATEST JPEG (FF D8 ... FF D9) from the MJPEG stream.
  // Skips intermediate frames in the buffer to avoid flooding the client with stale frames.
  // Doesn't rely on boundary strings, which can vary in case/format across servers.
  _processMjpegBuffer(cameraId, stream, epoch) {
    if (stream.epoch !== epoch) return;

    // Throttle: only broadcast at most every 33ms (~30 FPS) for smooth real-time
    const now = Date.now();
    const minInterval = 33;
    const canBroadcast = (now - (stream._lastBroadcastAt || 0)) >= minInterval;

    let latestJpeg = null;

    // Use a while loop to process ALL complete frames currently in the buffer.
    // We use forward indexOf to avoid accidentally matching FF D8/D9 markers
    // inside EXIF thumbnails, which lastIndexOf is prone to doing.
    let iterations = 0;
    while (iterations++ < 50) { // Higher safety cap to clear backlog
      const jpegStart = stream.mjpegBuffer.indexOf(Buffer.from([0xFF, 0xD8]));
      if (jpegStart < 0) break; // No start marker

      const jpegEnd = stream.mjpegBuffer.indexOf(Buffer.from([0xFF, 0xD9]), jpegStart + 2);
      if (jpegEnd < 0) break; // No end marker yet, wait for more data

      const frameEnd = jpegEnd + 2;
      const jpeg = stream.mjpegBuffer.slice(jpegStart, frameEnd);

      // Verify it looks like a valid JPEG
      if (jpeg.length >= 3 && jpeg[0] === 0xFF && jpeg[1] === 0xD8 && jpeg[2] === 0xFF) {
        latestJpeg = jpeg; // Keep overwriting so we only keep the LAST complete frame
      }

      // Advance buffer past this frame to clear the backlog and maintain zero latency
      stream.mjpegBuffer = stream.mjpegBuffer.slice(frameEnd);
    }

    // Broadcast only the latest frame, throttled
    if (latestJpeg && canBroadcast) {
      stream.lastJpeg = latestJpeg;
      stream.frameCount++;
      stream.lastBroadcastTs = Date.now();
      stream._lastBroadcastAt = now;
      this._broadcastFrame(cameraId, stream, latestJpeg);
    } else if (latestJpeg) {
      // Still store lastJpeg so late subscribers get the most recent frame
      stream.lastJpeg = latestJpeg;
    }
  }

  /**
   * Envoie une frame a tous les subscribers :
   *  - vrai socket Socket.IO → broadcast via room (couvre tous les clients dans la room)
   *  - faux socket HTTP proxy (marker __isHttpProxy) → emit direct (sa room join est no-op)
   */
  _broadcastFrame(cameraId, stream, jpeg) {
    if (!stream || stream.subscribers.size === 0) return;
    const event = `live-frame-${cameraId}`;
    const io = this._io;
    if (io) io.to(`live-${cameraId}`).emit(event, jpeg);
    // Aussi emit direct pour les faux sockets (HTTP proxy) qui n'appartiennent pas a la room
    for (const sub of stream.subscribers) {
      if (sub && sub.__isHttpProxy && typeof sub.emit === 'function') {
        try { sub.emit(event, jpeg); } catch (_) {}
      }
    }
  }

  // ==================== POLLING FALLBACK ====================
  _startPollingLoop(cameraId, stream, epoch) {
    if (stream.epoch !== epoch) return;
    if (stream.interval) clearInterval(stream.interval);
    stream.isMjpegMode = false;
    stream.mjpegBuffer = Buffer.alloc(0);
    stream.mjpegBoundary = null;
    if (stream.mjpegReq) { try { stream.mjpegReq.destroy(); } catch (_) {} stream.mjpegReq = null; }

    logger.info(`[LiveStream] ${cameraId} polling fallback @ ${STREAM_FPS} FPS`);

    stream.interval = setInterval(async () => {
      // Stale epoch check — stops polling from previous lifecycle
      if (stream.epoch !== epoch) {
        clearInterval(stream.interval);
        stream.interval = null;
        return;
      }
      if (stream.subscribers.size === 0) { this._stopStream(cameraId, stream); return; }
      try {
        const camera = this.cameraManager.getCamera(cameraId);
        if (!camera) { this._stopStream(cameraId, stream); return; }
        const frame = await this.cameraManager._captureFrameFromUrl(camera, cameraId);
        if (stream.epoch !== epoch) return; // Check again after async
        if (!frame || !frame.jpeg) { 
          stream.dropped++;
          // Log warning on every 100 dropped frames to track pattern
          if (stream.dropped % 100 === 0) {
            logger.warn(`[LiveStream] ${cameraId} high drop rate: ${stream.dropped}/${stream.frameCount}`);
          }
          return; 
        }
        // Reset drop counter on successful frame
        stream.dropped = Math.max(0, stream.dropped - 1);
        stream.lastJpeg = frame.jpeg;
        stream.frameCount++;
        stream.lastBroadcastTs = Date.now();
        this._broadcastFrame(cameraId, stream, frame.jpeg);
      } catch (e) {
        logger.error(`[LiveStream] polling error for ${cameraId}:`, e.message);
        stream.dropped++;
      }
    }, STREAM_INTERVAL_MS);
  }

  // ==================== STATS ====================
  getStats(cameraId) {
    const stream = this.streams.get(cameraId);
    if (!stream) return null;
    return {
      subscribers: stream.subscribers.size,
      running: stream.running,
      frameCount: stream.frameCount,
      dropped: stream.dropped,
      lastBroadcastTs: stream.lastBroadcastTs,
      mode: stream.isMjpegMode ? 'mjpeg' : 'polling',
      fps: stream.running ? STREAM_FPS : 0
    };
  }

  /**
   * Retourne la derniere frame JPEG recue du stream MJPEG.
   * Utilisee par le detection loop pour eviter une 2eme connexion HTTP
   * vers la meme camera (IP Webcam = single-threaded server).
   */
  getLastJpeg(cameraId) {
    const stream = this.streams.get(cameraId);
    if (!stream) return null;
    return stream.lastJpeg || null;
  }
}

module.exports = LiveJPEGStreamer;
