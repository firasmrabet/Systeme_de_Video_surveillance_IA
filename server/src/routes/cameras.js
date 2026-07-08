const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('./auth');
const db = require('../utils/database');
const { logger } = require('../utils/logger');
const vault = require('../utils/vault');
const cameraTester = require('../services/cameraTester');
const hlsProxy = require('../services/hlsProxy');
const networkScanner = require('../services/networkScanner');
const { PRESETS, CLOUD_PROVIDERS, getPresetById, buildRtspUrl, buildSnapshotUrl } = require('../services/cameraPresets');

function fetchWithTimeout(url, timeout) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const protocol = isHttps ? https : http;
    const options = { timeout };
    // Accept self-signed certs (common on IP Webcam, cheap IP cameras)
    if (isHttps) options.rejectUnauthorized = false;
    const req = protocol.get(url, options, (res) => resolve(res));
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Extract the base URL (scheme + host + port) from a full camera URL.
 * e.g. "https://192.168.100.165:8080/shot.jpg" â†’ "https://192.168.100.165:8080"
 */
function getBaseUrl(fullUrl) {
  try {
    const u = new URL(fullUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return fullUrl.replace(/\/[^/]*$/, '') || fullUrl;
  }
}

// List presets
router.get('/presets', (req, res) => {
  res.json({ presets: PRESETS, cloudProviders: CLOUD_PROVIDERS });
});

// List USB cameras attached to the server
router.get('/usb-devices', authenticate, async (req, res) => {
  try {
    const { exec } = require('child_process');
    const util = require('util');
    const execP = util.promisify(exec);
    // Try a quick Python probe to list available USB camera indices
    const script = `
import cv2, sys, json
indices = []
for i in range(4):
    try:
        cap = cv2.VideoCapture(i, cv2.CAP_DSHOW if sys.platform.startswith('win') else cv2.CAP_ANY)
        if cap.isOpened():
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            indices.append({'index': i, 'name': f'USB Camera {i}', 'resolution': f'{w}x{h}'})
            cap.release()
    except Exception as e:
        pass
print(json.dumps({'devices': indices}))
`;
    try {
      const { stdout } = await execP(`python -c "${script.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`, { timeout: 8000 });
      const parsed = JSON.parse(stdout.trim().split('\n').pop());
      res.json(parsed);
    } catch (e) {
      // If python fails, return an empty list (the form will fallback to manual index)
      res.json({ devices: [] });
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to list USB devices' });
  }
});

// List cameras for current user (sanitized)
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const cameras = await db.getCamerasByOwner(userId);
    const cameraManager = req.app.locals.cameraManager;
    const pySvc = req.app.locals.pythonStreamer;
    const baseUrl = `${req.protocol}://${req.hostname}:${process.env.PORT || 5000}`;

    const enriched = cameras.map(c => {
      const cam = vault.sanitizeForClient(c);
      // Pre-resolve streamUrl so the dashboard can render <img> without a 2nd roundtrip
      let streamUrl = null;
      if (!cam.url || cam.url === 'webcam' || cam.url.startsWith('usb:')) {
        // USB webcam â†’ Python streamer
        if (pySvc) {
          if (!pySvc.getStreamUrl(cam.id)) pySvc.start(cam.id);
          streamUrl = pySvc.getStreamUrl(cam.id);
        }
      } else {
        const reg = cameraManager?.getCamera(cam.id);
        if (reg && reg.streamUrl) {
          streamUrl = ensureAbsoluteUrl(reg.streamUrl, cam);
        }
        if (!streamUrl && cam.url) {
          streamUrl = ensureAbsoluteUrl(cam.url, cam);
        }
      }
      cam.streamUrl = streamUrl;
      cam.proxyUrl = `${baseUrl}/api/cameras/${cam.id}/stream`;
      return cam;
    });
    res.json(enriched);
  } catch (error) {
    logger.error('Error fetching cameras:', error);
    res.status(500).json({ error: 'Failed to fetch cameras' });
  }
});

// Test connection (without saving) â€” must be authenticated
router.post('/test-connection', authenticate, async (req, res) => {
  try {
    let { protocol, host, port, path, snapshotPath, username, password, useTLS, vendor, model, apiKey, token, clientSecret, authType } = req.body;
    if (!protocol || !host) {
      return res.status(400).json({ error: 'protocol and host are required' });
    }

    // Sanitize: if user pasted full URL into host (e.g. "http://192.168.100.165:8080"),
    // extract the actual host and port
    if (typeof host === 'string' && host.includes('://')) {
      try {
        const u = new URL(host);
        host = u.hostname;
        if (!port) port = u.port ? parseInt(u.port) : (u.protocol === 'https:' || u.protocol === 'rtsps:' ? 443 : 80);
        if (!path && u.pathname && u.pathname !== '/') path = u.pathname + u.search;
      } catch (e) {
        // ignore â€” will fail downstream
      }
    }
    // If host has a port appended (e.g. "192.168.100.165:8080")
    else if (typeof host === 'string' && host.includes(':') && !host.startsWith('[')) {
      const idx = host.lastIndexOf(':');
      const possiblePort = parseInt(host.slice(idx + 1));
      if (!isNaN(possiblePort) && possiblePort > 0 && possiblePort < 65536) {
        if (!port) port = possiblePort;
        host = host.slice(0, idx);
      }
    }

    const result = await cameraTester.testConnection({
      protocol, host, port: port || null, path, snapshotPath, username, password, useTLS, vendor, model,
      apiKey, token, clientSecret, authType: authType || 'basic'
    });

    // If the test discovered the actual protocol (e.g. HTTPS self-signed),
    // persist that info so subsequent stream fetches use the right one.
    if (result.ok && result.details.actualProtocol) {
      result.details.recommendedUseTLS = result.details.actualProtocol === 'https';
      result.diagnostics.push({
        type: 'info',
        severity: 'info',
        message: `âš ï¸ CamÃ©ra servie en ${result.details.actualProtocol.toUpperCase()}. Le stream utilisera ce protocole.`
      });
    }

    res.json(result);
  } catch (error) {
    logger.error('Test connection error:', error);
    res.status(500).json({ error: 'Failed to test connection' });
  }
});

// Scan local network for cameras (probes a /24 subnet for a given port)
router.post('/scan-network', authenticate, async (req, res) => {
  try {
    const { port = 8080, subnetBase = null, start = 1, end = 254 } = req.body || {};
    // Sanity
    const intPort = parseInt(port) || 8080;
    const intStart = Math.max(1, Math.min(254, parseInt(start) || 1));
    const intEnd = Math.max(intStart, Math.min(254, parseInt(end) || 254));
    const result = await networkScanner.scanNetwork({
      port: intPort,
      subnetBase,
      start: intStart,
      end: intEnd
    });
    res.json(result);
  } catch (error) {
    logger.error('Network scan error:', error);
    res.status(500).json({ ok: false, error: 'Network scan failed' });
  }
});

// Return local network info (subnet, default port suggestions)
router.get('/network-info', authenticate, (req, res) => {
  res.json({
    subnets: networkScanner.getLocalSubnets()
  });
});

// HLS proxy control (start/stop/status)
router.post('/:id/hls/start', authenticate, async (req, res) => {
  try {
    const camera = await db.getCameraById(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (camera.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (!['rtsp', 'rtmp', 'mjpeg', 'http'].includes(camera.protocol)) {
      return res.status(400).json({ error: `HLS proxy not supported for protocol: ${camera.protocol}` });
    }
    const conn = camera.connection || {};
    const result = hlsProxy.start(camera.id, {
      host: conn.host, port: conn.port, path: conn.path, username: conn.username,
      password: vault.decrypt(conn.password), useTLS: conn.useTLS, protocol: camera.protocol
    });
    res.json(result);
  } catch (error) {
    logger.error('HLS start error:', error);
    res.status(500).json({ error: 'Failed to start HLS proxy' });
  }
});

router.post('/:id/hls/stop', authenticate, async (req, res) => {
  try {
    const camera = await db.getCameraById(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (camera.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json(hlsProxy.stop(camera.id));
  } catch (error) {
    logger.error('HLS stop error:', error);
    res.status(500).json({ error: 'Failed to stop HLS proxy' });
  }
});

router.get('/:id/hls/status', authenticate, async (req, res) => {
  try {
    const camera = await db.getCameraById(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (camera.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json(hlsProxy.status(camera.id));
  } catch (error) {
    res.status(500).json({ error: 'Failed to get HLS status' });
  }
});

// Add new camera (enhanced)
router.post('/', authenticate, [
  body('name').trim().notEmpty(),
  body('location').trim().notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      name, location, description, tags, timezone,
      protocol, vendor, model, connection = {}, capabilities = {}, network = {},
      resolution, fps, url: providedUrl
    } = req.body;

    // Auto-fill from preset
    const preset = vendor ? getPresetById(vendor) : null;
    const finalProtocol = protocol || preset?.protocols?.[0] || 'mjpeg';

    // Build default URL if not provided
    let url = providedUrl;
    if (!url) {
      if (finalProtocol === 'rtsp') {
        url = buildRtspUrl({ ...connection, useTLS: connection.useTLS });
      } else if (finalProtocol === 'usb') {
        // For USB webcams, store a sentinel URL like "usb:0" (or "usb:1" for the 2nd cam)
        const idx = parseInt(connection.host) || 0;
        url = `usb:${idx}`;
      } else if (['mjpeg', 'http', 'hls'].includes(finalProtocol)) {
        // For MJPEG/HTTP cameras, store the BASE URL (scheme://host:port)
        // The stream proxy will append the correct path (/?action=stream, /video, etc.)
        const scheme = connection.useTLS ? 'https' : 'http';
        const portPart = connection.port ? `:${connection.port}` : '';
        url = `${scheme}://${connection.host}${portPart}`;
        // If the user provided a specific stream path, append it
        if (connection.path) {
          url += connection.path.startsWith('/') ? connection.path : '/' + connection.path;
        }
      }
    }

    if (!url) return res.status(400).json({ error: 'Could not determine camera URL. Provide url or full connection details.' });

    // Normalize URL: downgrade httpsâ†’http for non-standard TLS ports
    // IP Webcam, etc. use HTTP on ports like 8080 â€” users sometimes paste https:// by mistake
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') {
        const port = parseInt(parsed.port) || 443;
        if (port !== 443 && port !== 4433) {
          parsed.protocol = 'http:';
          url = parsed.toString();
        }
      }
    } catch (_) {}

    // Validate URL is absolute (has scheme) â€” reject relative paths
    if (finalProtocol !== 'rtsp' && finalProtocol !== 'usb' && !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'Invalid camera URL. Must start with http:// or https://. Got: ' + url });
    }

    // Encrypt credentials before storing
    const encConn = vault.encryptCredentials({
      password: connection.password,
      apiKey: connection.apiKey,
      clientSecret: connection.clientSecret,
      token: connection.token
    });

    const camera = await db.createCamera({
      name, location, description, tags: tags || [], timezone: timezone || 'UTC',
      url,
      vendor, model, protocol: finalProtocol,
      resolution: resolution || '1280x720',
      fps: fps || 15,
      status: 'online',
      detectionEnabled: true,
      sensitivity: 'medium',
      connection: {
        host: connection.host,
        port: connection.port,
        path: connection.path,
        snapshotPath: connection.snapshotPath,
        username: connection.username,
        authType: connection.authType || 'basic',
        useTLS: !!connection.useTLS,
        ...encConn
      },
      capabilities: {
        ptz: !!capabilities.ptz,
        audio: !!capabilities.audio,
        codec: capabilities.codec || 'h264',
        resolution: capabilities.resolution || resolution || '1280x720',
        fps: capabilities.fps || fps || 15
      },
      network: {
        behindNAT: !!network.behindNAT,
        publicUrl: network.publicUrl,
        relayRequired: !!network.relayRequired,
        preferWebRTC: !!network.preferWebRTC
      },
      zones: [
        { id: 'z1', name: 'Main Zone', coordinates: [[0, 0], [1, 0], [1, 1], [0, 1]], type: 'critical' }
      ],
      ownerId: req.user.id
    });

    // Register in camera manager immediately (don't wait for probing)
    const cameraManager = req.app.locals.cameraManager;
    if (cameraManager) {
      // Extract host/port from URL if not provided in connection
      let resolvedHost = connection.host;
      let resolvedPort = connection.port;
      if (!resolvedHost && camera.url) {
        try {
          const parsedUrl = new URL(camera.url);
          resolvedHost = parsedUrl.hostname;
          resolvedPort = parsedUrl.port ? parseInt(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80);
        } catch (e) { /* ignore */ }
      }

      const snapshotUrl = buildSnapshotUrl({
        host: resolvedHost, port: resolvedPort,
        snapshotPath: connection.snapshotPath, useTLS: connection.useTLS, protocol: finalProtocol
      });
      const proto = connection.useTLS ? 'https' : 'http';
      const authQ = connection.username
        ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(connection.password || '')}@`
        : '';
      const portPart = resolvedPort ? `:${resolvedPort}` : '';
      const baseUrl = `${proto}://${authQ}${resolvedHost}${portPart}`;
      let streamUrl = connection.path
        ? baseUrl + (connection.path.startsWith('/') ? connection.path : '/' + connection.path)
        : baseUrl + '/?action=stream';

      cameraManager.registerCamera({
        id: camera.id,
        name: camera.name,
        location: camera.location,
        url: camera.url,
        snapshotUrl,
        streamUrl,
        host: resolvedHost,
        port: resolvedPort,
        username: connection.username,
        password: connection.password || null,
        useTLS: !!connection.useTLS,
        fps: camera.fps,
        resolution: camera.resolution
      });

      // Probe MJPEG endpoint in background (non-blocking)
      setImmediate(async () => {
        try {
          const https2 = require('https');
          const http2 = require('http');
          const probeMjpeg = (testUrl) => new Promise(resolve => {
            try {
              const u = new URL(testUrl);
              const lib = u.protocol === 'https:' ? https2 : http2;
              const req = lib.request({
                hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search, method: 'GET',
                headers: { 'User-Agent': 'SentinelAI/2.0', 'Accept': 'multipart/x-mixed-replace,*/*' },
                rejectUnauthorized: false, timeout: 2500
              }, (res) => {
                const ct = (res.headers['content-type'] || '').toLowerCase();
                if (ct.includes('multipart/x-mixed-replace') || ct.includes('mjpeg')) {
                  res.destroy();
                  resolve({ ok: true, ct });
                } else {
                  res.resume();
                  resolve({ ok: false, ct });
                }
              });
              req.on('timeout', () => { req.destroy(); resolve({ ok: false, ct: 'timeout' }); });
              req.on('error', e => resolve({ ok: false, ct: e.message }));
              req.end();
            } catch (e) { resolve({ ok: false, ct: e.message }); }
          });

          const candidates = [streamUrl];
          if (connection.path && (connection.path.includes('?action=stream') || connection.path === '/')) {
            const proto2 = connection.useTLS ? 'https' : 'http';
            const port2 = connection.port ? `:${connection.port}` : '';
            const auth2 = connection.username ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(connection.password || '')}@` : '';
            for (const p of ['/?action=stream', '/videofeed', '/video', '/mjpegfeed', '/stream', '/mjpg/video.mjpg']) {
              candidates.push(`${proto2}://${auth2}${connection.host}${port2}${p}`);
            }
          }
          let resolvedStreamUrl = streamUrl;
          for (const c of candidates) {
            const r = await probeMjpeg(c);
            if (r.ok) { resolvedStreamUrl = c; logger.info(`[Camera] MJPEG endpoint confirmed: ${c} (CT: ${r.ct})`); break; }
          }
          if (vendor === 'ip_webcam_android' || camera.protocol === 'mjpeg') {
            const proto2 = connection.useTLS ? 'https' : 'http';
            const port2 = connection.port ? `:${connection.port}` : '';
            const canonical = `${proto2}://${connection.host}${port2}/?action=stream`;
            const r = await probeMjpeg(canonical);
            if (r.ok) { resolvedStreamUrl = canonical; }
          }
          if (resolvedStreamUrl !== streamUrl) {
            db.updateCamera(camera.id, { url: resolvedStreamUrl }).catch(() => {});
            const reg = cameraManager.getCamera(camera.id);
            if (reg) { reg.url = resolvedStreamUrl; reg.streamUrl = resolvedStreamUrl; }
            logger.info(`[Camera] ${camera.id} resolved to ${resolvedStreamUrl}`);
          }

          // Set IP Webcam quality/FPS in background
          if (vendor === 'ip_webcam_android' || camera.protocol === 'mjpeg') {
            for (const setting of [{ path: '/settings/quality?set=90', name: 'quality' }, { path: '/settings/fps?set=30', name: 'fps' }]) {
              try {
                const lib2 = connection.useTLS ? https2 : http2;
                const sReq = lib2.request({
                  hostname: connection.host, port: connection.port || (connection.useTLS ? 443 : 80),
                  path: setting.path, method: 'GET', timeout: 2000, rejectUnauthorized: false
                }, (sRes) => { sRes.resume(); });
                sReq.on('error', () => {}); sReq.on('timeout', () => sReq.destroy());
                sReq.end();
              } catch (e) { /* non-fatal */ }
            }
          }
        } catch (e) {
          logger.warn(`[Camera] Background probe failed for ${camera.id}: ${e.message}`);
        }
      });
    }

    logger.info(`New camera added: ${camera.id} (${vendor || 'custom'}/${model || 'generic'}) by user ${req.user.id}`);
    res.status(201).json(vault.sanitizeForClient(camera));
  } catch (error) {
    logger.error('Error adding camera:', error);
    res.status(500).json({ error: 'Failed to add camera' });
  }
});

// Cache for successful stream paths to avoid hammering the camera with requests
const workingStreamPaths = {};

// MJPEG Stream proxy â€” optimized for low latency
// Uses the camera's actual stream URL (from cameraManager.registerCamera) which
// already has auth embedded in the URL. Falls back to camera.url if not registered.
router.get('/:id/stream', async (req, res) => {
  try {
    const camera = await db.getCameraById(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (!camera.url || camera.url === 'webcam') return res.status(400).json({ error: 'No stream URL' });

    // Prefer the registered streamUrl (built with auth embedded) for lowest latency
    const cameraManager = req.app.locals.cameraManager;
    const registered = cameraManager?.getCamera?.(req.params.id);
    
    // Build a host-only baseUrl
    let baseUrl = (registered?.streamUrl || camera.url).replace(/\/$/, '');
    try {
      const u = new URL(baseUrl);
      // For local hostnames that gemini messed up, fallback to connection host
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || !u.hostname.includes('.')) {
        throw new Error('Bad hostname');
      }
      baseUrl = `${u.protocol}//${u.host}`;
    } catch (e) {
      const proto2 = (registered?.useTLS ?? camera.connection?.useTLS) ? 'https' : 'http';
      const host2 = camera.connection?.host || '192.168.100.165';
      const port2 = camera.connection?.port || 8080;
      baseUrl = `${proto2}://${host2}:${port2}`;
    }

    const authHeader = (registered?.username)
      ? 'Basic ' + Buffer.from(`${registered.username}:${registered.password || ''}`).toString('base64')
      : null;

    const tryStream = (url) => new Promise((resolve) => {
      let parsedUrl;
      try { parsedUrl = new URL(url); } catch (e) { resolve(null); return; }
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;
      const headers = { 'User-Agent': 'SentinelAI/2.0' };
      if (authHeader) headers['Authorization'] = authHeader;
      
      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers,
        timeout: 4000 // Reduced timeout to fail faster
      };
      if (isHttps) reqOptions.rejectUnauthorized = false;
      
      const proxyReq = lib.request(reqOptions, (proxyRes) => {
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 400) {
          const ct = (proxyRes.headers['content-type'] || '').toLowerCase();
          // IP webcam web UI returns text/html, we want multipart for the actual stream
          if (!ct.includes('multipart') && !ct.includes('image')) {
            logger.warn(`[StreamProxy] REJECT ${url} -> ${proxyRes.statusCode} (CT: ${ct})`);
            proxyRes.resume(); // consume data
            resolve(null);
            return;
          }
          logger.info(`[StreamProxy] OK ${url} -> ${proxyRes.statusCode} ${ct.slice(0,40)}`);
          resolve({ res: proxyRes, url });
        } else {
          logger.warn(`[StreamProxy] FAIL ${url} -> ${proxyRes.statusCode}`);
          proxyRes.resume();
          resolve(null);
        }
      });
      proxyReq.on('timeout', () => { logger.warn(`[StreamProxy] TIMEOUT ${url}`); proxyReq.destroy(); resolve(null); });
      proxyReq.on('error', e => { logger.warn(`[StreamProxy] ERR ${url} -> ${e.code || e.message}`); resolve(null); });
      proxyReq.end();
    });

    // Build candidates: 
    // 1. Cached working path (if any)
    // 2. /videofeed (IP Webcam native MJPEG, fastest)
    // 3. /video
    // 4. /mjpegfeed
    // 5. The camera's full original URL (might contain /?action=stream)
    const candidates = [];
    // If we already have a cached working path, use it FIRST (fast path)
    if (workingStreamPaths[camera.id]) {
      candidates.push(baseUrl + workingStreamPaths[camera.id]);
    }
    // If cameraManager has a confirmed stream URL, try it early
    if (registered?.streamUrl && !candidates.includes(registered.streamUrl)) {
      candidates.push(registered.streamUrl);
    }
    const suffixList = ['/videofeed', '/video', '/mjpegfeed', '/?action=stream', '/stream'];
    for (const suffix of suffixList) {
      if (!candidates.includes(baseUrl + suffix)) candidates.push(baseUrl + suffix);
    }
    // Also add the registered full url if not already there
    const fullUrl = registered?.streamUrl || camera.url;
    if (!candidates.includes(fullUrl)) candidates.push(fullUrl);

    let proxyResult = null;
    for (const url of candidates) {
      try { logger.info(`[StreamProxy] Trying ${req.params.id} via ${url}`); } catch (_) {}
      proxyResult = await tryStream(url);
      if (proxyResult) {
        // Cache the successful path (strip baseUrl to just save the suffix)
        try {
          const successfulPath = new URL(proxyResult.url).pathname + new URL(proxyResult.url).search;
          workingStreamPaths[camera.id] = successfulPath;
        } catch(e) {}
        break;
      }
    }

    if (!proxyResult) {
      res.status(502).json({ error: 'Cannot connect to camera stream' });
      return;
    }

    const proxyRes = proxyResult.res;
    // PRESERVE ORIGINAL CASE OF CONTENT-TYPE!
    // Browsers are strict about the boundary case in multipart/x-mixed-replace.
    const ct = proxyRes.headers['content-type'] || '';
    const headers = {
      'Content-Type': ct.toLowerCase().includes('multipart') ? ct : 'multipart/x-mixed-replace; boundary=myboundary',
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',         // disable nginx buffering
      'X-Proxy-Buffering': 'no',         // disable generic proxy buffering
      'Content-Encoding': 'identity',    // forbid gzip/brotli compression of video
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Credentials': 'true'
    };
    res.writeHead(200, headers);
    
    // Disable Nagle's algorithm for low-latency TCP sends (no buffering small frames)
    if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
    if (proxyRes.socket && typeof proxyRes.socket.setNoDelay === 'function') proxyRes.socket.setNoDelay(true);
    
    // Pipe with minimal buffering for low latency
    proxyRes.pipe(res, { end: false });
    proxyRes.on('data', () => {
      // Force flush after every chunk so the browser sees frames ASAP
      // Removed forced flush to prevent MJPEG tearing in Chrome
      // if (typeof res.flush === 'function') res.flush();
    });
    
    // Cleanup properly
    const cleanup = () => {
      try { proxyRes.destroy(); } catch (e) {}
      try { res.end(); } catch (e) {}
    };
    proxyRes.on('error', cleanup);
    proxyRes.on('end', cleanup);
    req.on('close', cleanup);
    
  } catch (error) {
    logger.error('[ProxyStream] Error:', error.message || String(error), 'stack:', error.stack || 'no-stack');
    if (!res.headersSent) res.status(500).json({ error: 'Proxy failed', detail: error.message || String(error) });
  }
});

// Snapshot proxy
router.get('/:id/snapshot', async (req, res) => {
  try {
    const camera = await db.getCameraById(req.params.id);
    if (!camera || !camera.url) return res.status(404).json({ error: 'Camera not found' });
    const cameraManager = req.app.locals.cameraManager;
    const registered = cameraManager?.getCamera?.(req.params.id);
    const authHeader = (registered?.username)
      ? 'Basic ' + Buffer.from(`${registered.username}:${registered.password || ''}`).toString('base64')
      : null;

    const trySnapshot = (url) => new Promise((resolve) => {
      let parsedUrl;
      try { parsedUrl = new URL(url); } catch (e) { resolve(null); return; }
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;
      const headers = { 'User-Agent': 'SentinelAI/2.0' };
      if (authHeader) headers['Authorization'] = authHeader;
      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers,
        timeout: 5000
      };
      if (isHttps) reqOptions.rejectUnauthorized = false;
      const proxyReq = lib.request(reqOptions, (proxyRes) => {
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 400) {
          const ct = proxyRes.headers['content-type'] || 'image/jpeg';
          if (ct.includes('image')) resolve({ res: proxyRes, ct });
          else { proxyRes.resume(); resolve(null); }
        } else {
          proxyRes.resume();
          resolve(null);
        }
      });
      proxyReq.on('timeout', () => { proxyReq.destroy(); resolve(null); });
      proxyReq.on('error', () => resolve(null));
      proxyReq.end();
    });

    let baseUrl = (registered?.snapshotUrl || camera.url).replace(/\/$/, '');
    try {
      const u = new URL(baseUrl);
      baseUrl = `${u.protocol}//${u.host}`;
    } catch (e) {}
    const suffixes = ['/shot.jpg', '/snapshot', '/?action=snapshot', '/current.jpg', '/jpg/image.jpg', '/cgi-bin/snapshot.cgi'];
    for (const suffix of suffixes) {
      const result = await trySnapshot(baseUrl + suffix);
      if (result) {
        res.writeHead(200, {
          'Content-Type': result.ct,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Access-Control-Allow-Origin': '*'
        });
        result.res.pipe(res);
        return;
      }
    }
    res.status(502).json({ error: 'Cannot fetch snapshot' });
  } catch (error) {
    res.status(500).json({ error: 'Snapshot failed' });
  }
});

// Helper: ensure a URL is absolute (has scheme). If not, build one from connection.
function ensureAbsoluteUrl(rawUrl, camera) {
  if (!rawUrl) return null;
  let url = /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
  if (!url) {
    // Relative path â€” try to rebuild from connection data
    const conn = camera.connection || {};
    const useTLS = conn.useTLS;
    const scheme = useTLS ? 'https' : 'http';
    const host = conn.host || camera.host;
    const port = conn.port || camera.port;
    if (!host) return null;
    const portPart = port ? `:${port}` : '';
    const path = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
    url = `${scheme}://${host}${portPart}${path}`;
  }
  // Normalize: downgrade httpsâ†’http for non-standard ports
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
  return url;
}

// Return the optimal stream URL for a camera (direct or proxy)
// - USB/webcam: returns Python streamer local URL + proxy fallback
// - IP camera: returns camera's direct MJPEG URL + proxy fallback
router.get('/:id/stream-url', authenticate, async (req, res) => {
  try {
    const camera = await db.getCameraById(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    const userId = req.user.userId || req.user.id;
    if (camera.ownerId !== userId) return res.status(403).json({ error: 'Access denied' });

    const cameraManager = req.app.locals.cameraManager;
    const registered = cameraManager?.getCamera(req.params.id);
    const baseUrl = `${req.protocol}://${req.hostname}:${process.env.PORT || 5000}`;

    // USB webcam â†’ Python streamer
    if (!camera.url || camera.url === 'webcam' || camera.url.startsWith('usb:')) {
      const pySvc = req.app.locals.pythonStreamer;
      if (pySvc) {
        let url = pySvc.getStreamUrl(req.params.id);
        if (!url) {
          pySvc.start(req.params.id);
          url = pySvc.getStreamUrl(req.params.id);
        }
        return res.json({
          type: 'mjpeg',
          direct: true,
          url: url,
          proxyUrl: `${baseUrl}/api/cameras/${req.params.id}/stream`,
          source: camera.url || 'usb:0'
        });
      }
    }

    // External IP camera â†’ use its stream URL directly
    let directUrl = null;
    if (registered && registered.streamUrl) {
      directUrl = ensureAbsoluteUrl(registered.streamUrl, camera);
    }
    if (!directUrl && camera.url) {
      directUrl = ensureAbsoluteUrl(camera.url, camera);
    }

    if (directUrl) {
      return res.json({
        type: 'mjpeg',
        direct: true,
        url: directUrl,
        proxyUrl: `${baseUrl}/api/cameras/${req.params.id}/stream`,
        source: camera.url || directUrl
      });
    }

    res.json({ type: 'none', url: null, proxyUrl: null, source: null });
  } catch (error) {
    logger.error('[StreamURL] Error:', error.message);
    res.status(500).json({ error: 'Failed to get stream URL' });
  }
});

// Proxy the camera's MJPEG stream (for remote/HTTPS access)
// Proxies either Python streamer (USB cam) or camera's direct URL (IP cam)
router.get('/:id/proxy-stream', async (req, res) => {
  const camId = req.params.id;
  try {
    logger.info(`[ProxyStream] ${camId} request received`);
    const camera = await db.getCameraById(camId);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    logger.info(`[ProxyStream] ${camId} camera found, url=${camera.url}`);

    // Try Python streamer first (USB/webcam)
    const pySvc = req.app.locals.pythonStreamer;
    if (pySvc) {
      const pyUrl = pySvc.getStreamUrl(camId);
      if (pyUrl) {
        logger.info(`[ProxyStream] ${camId} using python streamer @ ${pyUrl}`);
        // Proxy the Python streamer's local MJPEG
        const proxyReq = http.get(pyUrl, (proxyRes) => {
          const ct = proxyRes.headers['content-type'] || 'multipart/x-mixed-replace; boundary=--jpgboundary';
          res.writeHead(200, {
            'Content-Type': ct,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering': 'no',
            'Content-Encoding': 'identity'
          });
          if (res.socket?.setNoDelay) res.socket.setNoDelay(true);
          if (proxyRes.socket?.setNoDelay) proxyRes.socket.setNoDelay(true);
          proxyRes.pipe(res);
          proxyRes.on('error', () => { try { res.end(); } catch (_) {} });
          proxyRes.on('end', () => { try { res.end(); } catch (_) {} });
          req.on('close', () => { try { proxyRes.destroy(); } catch (_) {} });
        });
        proxyReq.on('error', () => res.status(502).json({ error: 'Python streamer not ready' }));
        proxyReq.end();
        return;
      }
    }
    logger.info(`[ProxyStream] ${camId} no python streamer, using liveStreamer`);

    // Fallback: proxy the camera using the shared LiveStreamer (eliminates multiple connection bugs)
    const liveStreamer = req.app.locals.liveStreamer;
    if (!liveStreamer) return res.status(503).json({ error: 'LiveStreamer not ready' });

    // If we have a stream URL from the db/manager, pass it
    const registered = req.app.locals.cameraManager?.getCamera(camId);
    const streamUrl = registered?.streamUrl || camera.url;
    logger.info(`[ProxyStream] ${camId} streamUrl=${streamUrl}, about to write headers`);

    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Connection': 'close',
      'X-Accel-Buffering': 'no',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    // Fake socket object to trick LiveStreamer into keeping the stream alive
    const fakeSocket = {
      id: 'http-mjpeg-' + Math.random().toString(36).substring(2, 9),
      __isHttpProxy: true,
      join: () => {},
      leave: () => {},
      emit: (evt, jpeg) => { if (evt === `live-frame-${camId}`) writeFrame(jpeg); }
    };

    const writeFrame = (jpeg) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write('--myboundary\r\n');
        res.write('Content-Type: image/jpeg\r\n');
        res.write(`Content-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write('\r\n');
      } catch (e) {}
    };

    liveStreamer.subscribe(camId, fakeSocket, streamUrl);

    req.on('close', () => {
      liveStreamer.unsubscribe(camId, fakeSocket);
      try { res.end(); } catch (_) {}
    });
  } catch (error) {
    const msg = error?.message || String(error) || 'unknown';
    logger.error(`[ProxyStream] Error: ${msg}`);
    if (!res.headersSent) res.status(500).json({ error: 'Proxy failed', detail: msg });
  }
});

// Mini-stream snapshot preview (single JPEG) â€” used by dashboard card with periodic refresh
// Authenticated via JWT in header OR ?token= query param (for <img> tags which can't set headers)
router.get('/:id/preview', async (req, res) => {
  // Accept token via query param (for <img> tags)
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  return authenticate(req, res, () => previewHandler(req, res));
});

/**
 * GET /api/cameras/:id/capture-fresh
 *
 * Returns a fresh, fully-decoded JPEG for photo capture.
 * Strategy (in order, no impact on the live video stream):
 *   1. Reuse the in-memory `lastJpeg` from the active LiveJPEGStreamer (sub-ms, no extra load on the camera)
 *   2. Fall back to a brand-new snapshot via cameraManager._captureFrameFromUrl (single GET on /shot.jpg etc.)
 *   3. Fall back to the USB camera python streamer /shot.jpg
 *
 * This endpoint is independent of the MJPEG <img> stream, so it does NOT pause or
 * disrupt the live video the user is watching. The `<img>` keeps its 30 FPS feed.
 */
router.get('/:id/capture-fresh', async (req, res) => {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  return authenticate(req, res, async () => {
    try {
      const cameraId = req.params.id;
      const camera = await db.getCameraById(cameraId);
      if (!camera) return res.status(404).json({ error: 'Camera not found' });
      if (camera.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

      const liveStreamer = req.app.locals.liveStreamer;
      const cameraManager = req.app.locals.cameraManager;
      const pySvc = req.app.locals.pythonStreamer;

      // 1) Fast path â€” reuse the most recent in-memory JPEG from the live stream
      try {
        const stream = liveStreamer?.streams?.get(cameraId);
        if (stream && stream.lastJpeg && stream.lastJpeg.length > 100) {
          // Check it's not ancient (older than 30s â†’ camera probably disconnected, fetch fresh)
          const ageMs = Date.now() - (stream.lastBroadcastTs || 0);
          if (ageMs < 30000) {
            res.set({
              'Content-Type': 'image/jpeg',
              'Content-Length': stream.lastJpeg.length,
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              'Pragma': 'no-cache',
              'Expires': '0',
              'X-Frame-Source': 'live-buffer',
              'X-Frame-Age-Ms': String(ageMs),
              'Access-Control-Allow-Origin': '*'
            });
            return res.end(stream.lastJpeg);
          }
        }
      } catch (_) { /* fall through */ }

      // 2) Brand-new snapshot from the camera (1 HTTP GET, does not affect MJPEG stream)
      try {
        const registered = cameraManager?.getCamera?.(cameraId);
        if (registered) {
          const frame = await cameraManager._captureFrameFromUrl(registered, cameraId);
          if (frame && frame.jpeg && frame.jpeg.length > 100) {
            res.set({
              'Content-Type': 'image/jpeg',
              'Content-Length': frame.jpeg.length,
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              'Pragma': 'no-cache',
              'Expires': '0',
              'X-Frame-Source': 'fresh-snapshot',
              'X-Frame-Width': String(frame.width || 0),
              'X-Frame-Height': String(frame.height || 0),
              'Access-Control-Allow-Origin': '*'
            });
            return res.end(frame.jpeg);
          }
        }
      } catch (e) {
        logger.warn(`[CaptureFresh] snapshot fallback failed for ${cameraId}: ${e.message}`);
      }

      // 3) USB camera â€” get latest frame from the python streamer
      try {
        const pyUrl = pySvc?.getStreamUrl?.(cameraId);
        if (pyUrl) {
          const shotUrl = pyUrl.replace(/\/videofeed$/, '/shot.jpg').replace(/\/video$/, '/shot.jpg');
          const lib = shotUrl.startsWith('https') ? require('https') : require('http');
          await new Promise((resolve) => {
            const req2 = lib.get(shotUrl, { timeout: 2000, rejectUnauthorized: false }, (r) => {
              if (r.statusCode !== 200) { r.resume(); return resolve(); }
              const chunks = [];
              r.on('data', (c) => chunks.push(c));
              r.on('end', () => {
                const buf = Buffer.concat(chunks);
                if (buf.length < 100 || buf[0] !== 0xFF || buf[1] !== 0xD8) return resolve();
                res.set({
                  'Content-Type': 'image/jpeg',
                  'Content-Length': buf.length,
                  'Cache-Control': 'no-store',
                  'X-Frame-Source': 'usb-python',
                  'Access-Control-Allow-Origin': '*'
                });
                res.end(buf);
                resolve('done');
              });
              r.on('error', () => resolve());
            });
            req2.on('error', () => resolve());
            req2.on('timeout', () => { req2.destroy(); resolve(); });
          });
          if (res.headersSent) return; // success path already responded
        }
      } catch (_) { /* fall through */ }

      return res.status(503).json({ error: 'No fresh frame available (camera offline or still connecting)' });
    } catch (err) {
      logger.error('[CaptureFresh] unexpected error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Capture failed' });
    }
  });
});

// Fast live frame endpoint â€” returns the latest pre-buffered JPEG from the liveStreamer.
// Used for high-frequency (30+ FPS) client polling with <canvas> rendering for smoothness.
// Sub-millisecond response time because the frame is already in memory.
router.get('/:id/latest-frame', async (req, res) => {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  return authenticate(req, res, () => {
    const liveStreamer = req.app.locals.liveStreamer;
    if (!liveStreamer) return res.status(503).json({ error: 'LiveStreamer not ready' });

    let stream = liveStreamer.streams?.get(req.params.id);
    if (!stream) {
      // No stream yet â€” create + start one (synthetic subscriber that never unsubscribes)
      stream = liveStreamer._createStream();
      liveStreamer.streams.set(req.params.id, stream);
      // Add a fake subscriber socket so the stream stays alive
      stream.subscribers.add({ id: 'api-poll', emit: () => {} });
      liveStreamer._startStream(req.params.id, stream);
      logger.info(`[LatestFrame] Auto-started stream for ${req.params.id}`);
    }

    if (!stream.lastJpeg) {
      // No frame yet (stream just started) â€” wait up to 1s for the first one
      const start = Date.now();
      const checkFrame = () => {
        if (stream.lastJpeg) return sendFrame();
        if (Date.now() - start > 1000) return res.status(503).json({ error: 'No frame available yet' });
        setTimeout(checkFrame, 50);
      };
      const sendFrame = () => {
        res.set({
          'Content-Type': 'image/jpeg',
          'Content-Length': stream.lastJpeg.length,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          'X-Frame-Timestamp': stream.lastBroadcastTs || 0,
          'Access-Control-Allow-Origin': '*'
        });
        res.end(stream.lastJpeg);
      };
      return checkFrame();
    }

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': stream.lastJpeg.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Frame-Timestamp': stream.lastBroadcastTs || 0,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(stream.lastJpeg);
  });
});

async function previewHandler(req, res) {
  try {
    const camera = await db.getCameraById(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    const userId = req.user.userId || req.user.id;
    if (camera.ownerId !== userId) return res.status(403).json({ error: 'Access denied' });

    const cameraManager = req.app.locals.cameraManager;
    if (!cameraManager) return res.status(503).json({ error: 'Camera manager not ready' });
    const registered = cameraManager.getCamera(req.params.id);
    if (!registered) return res.status(503).json({ error: 'Camera not registered' });

    // Use the robust capture method from cameraManager instead of duplicating logic
    const captureResult = await cameraManager._captureFrameFromUrl(registered, req.params.id);
    const frame = captureResult ? captureResult.jpeg : null;

    if (!frame) return res.status(502).json({ error: 'Failed to capture frame' });
    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': frame.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(frame);
  } catch (error) {
    logger.error('[Preview] Error:', error.message);
    res.status(500).json({ error: 'Preview failed' });
  }
}

// Get camera by ID (sanitized)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const camera = await db.getCameraById(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (camera.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    // Augment with live detection stats and direct stream URL
    const cameraManager = req.app.locals.cameraManager;
    const pySvc = req.app.locals.pythonStreamer;
    const baseUrl = `${req.protocol}://${req.hostname}:${process.env.PORT || 5000}`;
    const registered = cameraManager?.getCamera(req.params.id);
    const detectionStats = cameraManager?.getDetectionStats?.(req.params.id) || null;
    const result = vault.sanitizeForClient(camera);

    // Resolve the best stream URL (absolute) â€” Python streamer for USB, camera URL for IP
    let streamUrl = null;
    if (!result.url || result.url === 'webcam' || result.url.startsWith('usb:')) {
      if (pySvc) {
        if (!pySvc.getStreamUrl(result.id)) pySvc.start(result.id);
        streamUrl = pySvc.getStreamUrl(result.id);
      }
    } else if (registered && registered.streamUrl) {
      streamUrl = ensureAbsoluteUrl(registered.streamUrl, result);
    } else if (result.url) {
      streamUrl = ensureAbsoluteUrl(result.url, result);
    }
    result.streamUrl = streamUrl;
    result.proxyUrl = `${baseUrl}/api/cameras/${result.id}/proxy-stream`;
    if (registered) result.snapshotUrl = registered.snapshotUrl;
    result.detectionStats = detectionStats;
    res.json(result);
  } catch (error) {
    logger.error('Error fetching camera:', error);
    res.status(500).json({ error: 'Failed to fetch camera' });
  }
});

// Update camera
router.put('/:id', authenticate, async (req, res) => {
  try {
    const camera = await db.getCameraById(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (camera.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const allowed = ['name', 'location', 'description', 'tags', 'timezone', 'url', 'resolution', 'fps',
      'detectionEnabled', 'sensitivity', 'zones', 'vendor', 'model', 'protocol', 'connection',
      'capabilities', 'network', 'health'];
    const updates = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    // Re-encrypt credentials if provided
    if (updates.connection) {
      const enc = vault.encryptCredentials({
        password: updates.connection.password,
        apiKey: updates.connection.apiKey,
        clientSecret: updates.connection.clientSecret,
        token: updates.connection.token
      });
      updates.connection = { ...camera.connection, ...updates.connection, ...enc };
    }

    const updatedCamera = await db.updateCamera(req.params.id, updates);

    // Re-register in camera manager
    const cameraManager = req.app.locals.cameraManager;
    if (cameraManager && (updates.url || updates.name || updates.fps || updates.connection)) {
      const conn = updatedCamera.connection || {};
      const snapshotUrl = buildSnapshotUrl({
        host: conn.host, port: conn.port,
        snapshotPath: conn.snapshotPath, useTLS: conn.useTLS, protocol: updatedCamera.protocol
      });
      const proto = conn.useTLS ? 'https' : 'http';
      const authQ = conn.username
        ? `${encodeURIComponent(conn.username)}:${encodeURIComponent(vault.decrypt(conn.password || ''))}@`
        : '';
      const portPart = conn.port ? `:${conn.port}` : '';
      const baseUrl = `${proto}://${authQ}${conn.host}${portPart}`;
      const streamUrl = conn.path
        ? baseUrl + (conn.path.startsWith('/') ? conn.path : '/' + conn.path)
        : baseUrl + '/?action=stream';

      cameraManager.registerCamera({
        id: updatedCamera.id,
        name: updatedCamera.name,
        location: updatedCamera.location,
        url: updatedCamera.url,
        snapshotUrl,
        streamUrl,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        password: conn.password ? vault.decrypt(conn.password) : null,
        useTLS: !!conn.useTLS,
        fps: updatedCamera.fps,
        resolution: updatedCamera.resolution
      });
    }

    logger.info(`Camera updated: ${req.params.id}`);
    res.json(vault.sanitizeForClient(updatedCamera));
  } catch (error) {
    logger.error('Error updating camera:', error);
    res.status(500).json({ error: 'Failed to update camera' });
  }
});

// Delete camera
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const camera = await db.getCameraById(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (camera.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const cameraManager = req.app.locals.cameraManager;
    if (cameraManager) cameraManager.unregisterCamera(req.params.id);
    hlsProxy.stop(req.params.id);

    await db.deleteCamera(req.params.id);
    logger.info(`Camera deleted: ${req.params.id}`);
    res.json({ message: 'Camera deleted successfully' });
  } catch (error) {
    logger.error('Error deleting camera:', error);
    res.status(500).json({ error: 'Failed to delete camera' });
  }
});
// ============ MANUAL ALERT ============
// Allows the user to trigger an alert manually while watching the live feed.
// Captures a fresh frame, sends Telegram (with photo) + Email, exactly like AI alerts.
router.post('/:id/manual-alert', authenticate, async (req, res) => {
  try {
    const camera = await db.getCameraById(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    if (camera.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const notifications = req.app.locals.notifications;
    if (!notifications) return res.status(500).json({ error: 'Notification service not available' });

    // Try to capture a fresh frame from the camera for the alert
    let frameBase64 = null;
    
    // 1. Try to get the absolute latest frame from the live streamer (Zero latency)
    const liveStreamer = req.app.locals.liveStreamer;
    if (liveStreamer) {
      const stream = liveStreamer.streams.get(camera.id);
      if (stream && stream.lastJpeg) {
        frameBase64 = stream.lastJpeg.toString('base64');
      }
    }

    // 2. Fallback to CameraManager URL capture
    const cameraManager = req.app.locals.cameraManager;
    if (!frameBase64 && cameraManager) {
      try {
        const frame = await cameraManager._captureFrameFromUrl(camera, camera.id);
        if (frame && frame.jpeg) {
          frameBase64 = frame.jpeg.toString('base64');
        }
      } catch (e) {
        logger.warn(`[ManualAlert] Could not capture frame for ${camera.id}: ${e.message}`);
      }
    }

    // 3. If backend failed, try the request body from frontend (Strip base64 prefix to prevent corruption)
    if (!frameBase64 && req.body.frameBase64) {
      frameBase64 = req.body.frameBase64.replace(/^data:image\/\w+;base64,/, '');
    }

    // 4. Record a 4-second video clip using ffmpeg (so Telegram and Email get the video too)
    let clip_path = null;
    try {
      const ffmpegPath = require('ffmpeg-static');
      const { spawn } = require('child_process');
      const path = require('path');
      const fs = require('fs');
      
      if (ffmpegPath) {
        const clipName = `manual-${Date.now()}.mp4`;
        const clipDir = path.join(__dirname, '..', '..', 'data', 'clips');
        if (!fs.existsSync(clipDir)) fs.mkdirSync(clipDir, { recursive: true });
        
        const absoluteClipPath = path.join(clipDir, clipName);
        
        // Use the internal proxy stream with the user's token to bypass IP Webcam connection limits
        const token = req.headers.authorization?.split(' ')[1] || '';
        const localProxyUrl = `http://127.0.0.1:${process.env.PORT || 5000}/api/cameras/${camera.id}/proxy-stream?token=${token}`;
        
        logger.info(`[ManualAlert] Recording 4s clip from local proxy`);
        
        await new Promise((resolve) => {
          const proc = spawn(ffmpegPath, [
            '-y', 
            '-use_wallclock_as_timestamps', '1',
            '-i', localProxyUrl, 
            '-t', '4', 
            '-c:v', 'libx264', 
            '-preset', 'ultrafast', 
            '-pix_fmt', 'yuv420p',
            absoluteClipPath
          ], { windowsHide: true });
          
          proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(absoluteClipPath) && fs.statSync(absoluteClipPath).size > 1000) {
              clip_path = `/data/clips/${clipName}`;
            } else {
              logger.warn(`[ManualAlert] FFmpeg exited with code ${code} or file empty`);
            }
            resolve();
          });
          proc.on('error', (err) => {
            logger.warn(`[ManualAlert] FFmpeg spawn error: ${err.message}`);
            resolve();
          });
        });
      }
    } catch (e) {
      logger.warn('[ManualAlert] Failed to record clip:', e.message);
    }

    const alert = {
      id: `manual-${Date.now()}`,
      cameraId: camera.id,
      ownerId: req.user.id,
      type: 'manual',
      severity: 'critical',
      confidence: 1.0,
      timestamp: new Date().toISOString(),
      clip_path: clip_path,
      details: {
        description: req.body.description || 'Manual alert triggered by user',
        triggeredBy: req.user.email,
        clipPath: clip_path
      }
    };

    // Save the alert to the database
    try {
      await db.createAlert(alert);
    } catch (e) {
      logger.warn('[ManualAlert] Could not save alert to DB:', e.message);
    }

    // Send notifications (Telegram + Email + Push) exactly like AI alerts
    await notifications.sendAlert(alert, frameBase64);

    // Also emit via WebSocket so the UI updates in real time
    notifications.emitAlertToOwner(alert);

    logger.info(`Manual alert triggered by ${req.user.email} for camera ${camera.name}`);
    res.json({ success: true, alertId: alert.id, message: 'Manual alert sent successfully' });
  } catch (error) {
    logger.error('Manual alert error:', error);
    res.status(500).json({ error: 'Failed to send manual alert' });
  }
});

module.exports = router;
