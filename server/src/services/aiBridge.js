/**
 * Node.js ↔ Python AI Detection Bridge
 * Spawns persistent Python process, sends frames via stdin, receives detections via stdout.
 *
 * Auto-sélection de l'engine (ordre de priorité) :
 *   1. Variable d'env SENTINEL_AI_ENGINE  ('pro' | 'lstm' | 'auto')
 *   2. Si sentinel_data/behavior_model.pt existe → LSTM (ai_engine.py)
 *   3. Sinon → heuristique (ai_engine_pro.py)
 *
 * L'engine LSTM ajoute une 3e couche de classification comportementale
 * (Fighting, Assault, Robbery, Stealing, Shoplifting, Shooting) entraînée
 * sur UCF-Crime. Si le modèle est absent, l'engine LSTM tombe
 * automatiquement en mode heuristique.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const { logger } = require('../utils/logger');

const AI_DIR  = path.join(__dirname, '..', '..', '..', 'ai');
const ROOT    = path.join(AI_DIR, '..');
const LSTM_MODEL_DEFAULT = path.join(ROOT, 'sentinel_data', 'behavior_model.pt');

function pickEngine() {
  const override = (process.env.SENTINEL_AI_ENGINE || 'auto').toLowerCase();
  if (override === 'pro')   return { file: 'ai_engine_pro.py',     name: 'pro',  reason: 'env SENTINEL_AI_ENGINE=pro' };
  if (override === 'lstm') return { file: 'ai_engine.py',          name: 'lstm', reason: 'env SENTINEL_AI_ENGINE=lstm' };
  if (override === 'sv')   return { file: 'ai_engine_sv.py',       name: 'sv',   reason: 'env SENTINEL_AI_ENGINE=sv' };

  const lstmModel = process.env.SENTINEL_BEHAVIOR_MODEL || LSTM_MODEL_DEFAULT;
  if (fs.existsSync(lstmModel)) {
    return { file: 'ai_engine_sv.py', name: 'sv', reason: `model found: ${lstmModel} (defaulting to sv)` };
  }
  return { file: 'ai_engine_sv.py', name: 'sv', reason: 'no behavior model found (defaulting to sv)' };
}

class AIBridge {
  constructor() {
    this.process = null;
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.ready = false;
    this.initializing = false;
    this.queueBuffer = '';
    this.startTime = null;
    this._initResolve = null;
    this._initReject = null;
    this._initTimeout = null;
    this.engine = pickEngine();
  }

  /**
   * Returns info about the currently selected engine.
   * Useful for /api/health and the React UI to display "Mode: LSTM" or "Mode: Heuristique".
   */
  getEngineInfo() {
    return {
      ...this.engine,
      scriptPath: path.join(AI_DIR, this.engine.file),
      lstmModel: process.env.SENTINEL_BEHAVIOR_MODEL || LSTM_MODEL_DEFAULT,
      lstmModelExists: fs.existsSync(process.env.SENTINEL_BEHAVIOR_MODEL || LSTM_MODEL_DEFAULT),
    };
  }

  async start() {
    if (this.process) return;
    if (this.initializing) {
      return new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (this.ready) { clearInterval(check); resolve(); }
          if (!this.initializing && !this.process) { clearInterval(check); reject(new Error('init aborted')); }
        }, 100);
      });
    }
    this.initializing = true;

    // Re-pick at start in case the env changed
    this.engine = pickEngine();
    const pythonScript = path.join(AI_DIR, this.engine.file);
    if (!fs.existsSync(pythonScript)) {
      this.initializing = false;
      throw new Error(`[AIBridge] Engine script missing: ${pythonScript}`);
    }

    this.startTime = Date.now();
    logger.info(`[AIBridge] Starting Python engine: ${this.engine.name} (${pythonScript}) — ${this.engine.reason}`);

    this.process = spawn('python', [pythonScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.process.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.process.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) logger.info(`[AI] ${msg}`);
    });
    this.process.on('close', (code) => {
      logger.warn(`[AIBridge] Python process exited with code ${code}`);
      this.process = null;
      this.ready = false;
      this.initializing = false;
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('AI process died'));
      }
      this.pendingRequests.clear();
      if (this._initReject) {
        this._initReject(new Error('AI process died during init'));
        this._initResolve = null;
        this._initReject = null;
      }
    });
    this.process.on('error', (err) => {
      logger.error('[AIBridge] Python process error:', err);
    });

    try {
      await this._initialize();
    } catch (e) {
      this.initializing = false;
      throw e;
    }
    this.initializing = false;
  }

  _onStdout(chunk) {
    this.queueBuffer += chunk.toString();
    let newlineIdx;
    while ((newlineIdx = this.queueBuffer.indexOf('\n')) !== -1) {
      const line = this.queueBuffer.slice(0, newlineIdx).trim();
      this.queueBuffer = this.queueBuffer.slice(newlineIdx + 1);
      if (!line || !line.startsWith('{')) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const { resolve, reject } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          if (msg.error) reject(new Error(msg.error + (msg.trace ? '\n' + msg.trace : '')));
          else resolve(msg.result);
        } else if (msg.status === 'ready') {
          this._handleReady();
        }
      } catch (e) {
        // Silent skip
      }
    }
  }

  _handleReady() {
    if (this.ready) return;
    this.ready = true;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    logger.info(`[AIBridge] AI ready (${elapsed}s)`);
    if (this._initTimeout) {
      clearTimeout(this._initTimeout);
      this._initTimeout = null;
    }
    if (this._initResolve) {
      const r = this._initResolve;
      this._initResolve = null;
      this._initReject = null;
      r();
    }
  }

  _initialize() {
    return new Promise((resolve, reject) => {
      this._initResolve = resolve;
      this._initReject = reject;
      this._initTimeout = setTimeout(() => {
        this._initTimeout = null;
        this._initResolve = null;
        this._initReject = null;
        try { this.process && this.process.kill(); } catch (e) {}
        reject(new Error('AI init timeout (5 min)'));
      }, 300000);
      this.process.stdin.write(JSON.stringify({ cmd: 'init' }) + '\n');
    });
  }

  async detect(jpegBuffer, options = {}) {
    if (!this.ready) await this.start();
    const id = ++this.requestId;
    const payload = {
      id,
      camera_id: options.cameraId || 'default',
      image: jpegBuffer.toString('base64'),
      known_faces: options.knownFaces || [],
      zones: options.zones || []
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('AI detect timeout (120s)'));
        }
      }, 120000);
      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); }
      });
      this.process.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  async extractEmbedding(jpegBuffer, maxFaces = 1) {
    if (!this.ready) await this.start();
    const id = ++this.requestId;
    const payload = {
      id,
      cmd: 'extract_embedding',
      image: jpegBuffer.toString('base64'),
      max_faces: maxFaces
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('AI embedding timeout (30s)'));
        }
      }, 30000);
      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); }
      });
      this.process.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  async stop() {
    if (this.process) {
      try { this.process.kill(); } catch (e) {}
      this.process = null;
      this.ready = false;
    }
  }
}

module.exports = new AIBridge();
