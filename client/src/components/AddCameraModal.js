import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, ChevronRight, ChevronLeft, Camera, Check, AlertCircle, Loader2,
  Globe, Wifi, Cloud, Lock, Shield, Settings, Eye, EyeOff, TestTube, Save,
  Server, Video, FileVideo
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';

const STEPS = [
  { id: 1, title: 'Type & Brand', icon: Camera, desc: 'Select protocol and manufacturer' },
  { id: 2, title: 'Connection', icon: Wifi, desc: 'Network and authentication' },
  { id: 3, title: 'Test', icon: TestTube, desc: 'Verify connection works' },
  { id: 4, title: 'Details & Save', icon: Save, desc: 'Name, location, save' }
];

const PROTOCOLS = [
  { id: 'rtsp', label: 'RTSP', desc: 'Real-Time Streaming Protocol (most IP cameras)', icon: Video },
  { id: 'rtmp', label: 'RTMP', desc: 'Real-Time Messaging Protocol (older)', icon: FileVideo },
  { id: 'hls', label: 'HLS / HTTP', desc: 'HTTP-based stream (browser-friendly)', icon: Globe },
  { id: 'mjpeg', label: 'MJPEG', desc: 'IP Webcam app, motion JPEG', icon: Camera },
  { id: 'onvif', label: 'ONVIF', desc: 'Standard protocol for IP cameras', icon: Server },
  { id: 'cloud', label: 'Cloud Provider', desc: 'Wyze, Ring, Arlo, Nest, etc.', icon: Cloud },
  { id: 'usb', label: 'USB Webcam', desc: 'Built-in laptop / USB camera (server-attached)', icon: Camera }
];

export default function AddCameraModal({ isOpen, onClose, onAdded }) {
  const { api } = useAuth();
  const [step, setStep] = useState(1);
  const [presets, setPresets] = useState([]);
  const [cloudProviders, setCloudProviders] = useState([]);
  const [form, setForm] = useState({
    name: '',
    location: '',
    description: '',
    tags: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    protocol: 'rtsp',
    vendor: '',
    model: '',
    connection: {
      host: '',
      port: '',
      path: '',
      snapshotPath: '',
      username: '',
      password: '',
      useTLS: false,
      authType: 'basic'
    },
    capabilities: {
      ptz: false,
      audio: false,
      codec: 'h264',
      resolution: '1280x720',
      fps: 15
    },
    network: {
      behindNAT: false,
      publicUrl: '',
      relayRequired: false,
      preferWebRTC: false
    },
    resolution: '1280x720',
    fps: 15
  });
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);

  // Load presets
  useEffect(() => {
    if (!isOpen) return;
    api.get('/cameras/presets').then(res => {
      setPresets(res.data.presets || []);
      setCloudProviders(res.data.cloudProviders || []);
    }).catch(e => console.warn('Failed to load presets', e));
  }, [isOpen, api]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setTestResult(null);
    }
  }, [isOpen]);

  const updateField = (field, value) => setForm(prev => ({ ...prev, [field]: value }));
  const updateConn = (field, value) => setForm(prev => ({ ...prev, connection: { ...prev.connection, [field]: value } }));
  const updateCap = (field, value) => setForm(prev => ({ ...prev, capabilities: { ...prev.capabilities, [field]: value } }));
  const updateNet = (field, value) => setForm(prev => ({ ...prev, network: { ...prev.network, [field]: value } }));

  // Auto-fill defaults when vendor/protocol changes
  useEffect(() => {
    if (!presets.length) return;
    const preset = presets.find(p => p.id === form.vendor);
    if (!preset) return;
    // For protocol, use the first matching protocol of the preset if current protocol is not supported
    const effectiveProtocol = preset.protocols.includes(form.protocol) ? form.protocol : preset.protocols[0];
    if (effectiveProtocol !== form.protocol) {
      updateField('protocol', effectiveProtocol);
      return;
    }
    const portKey = effectiveProtocol;
    // Fallback chain: protocol -> http -> first available
    const portMap = preset.defaultPort || {};
    const defaultPort = portMap[portKey] || portMap.http || Object.values(portMap)[0];
    const path = preset.defaultPaths?.[0] || '';
    setForm(prev => ({
      ...prev,
      connection: {
        ...prev.connection,
        port: defaultPort ? String(defaultPort) : prev.connection.port,
        path: path || prev.connection.path,
        snapshotPath: preset.snapshotPath || prev.connection.snapshotPath,
        username: preset.defaultAuth?.username !== undefined ? preset.defaultAuth.username : prev.connection.username,
        password: preset.defaultAuth?.password !== undefined ? preset.defaultAuth.password : prev.connection.password
      }
    }));
  }, [form.vendor, form.protocol, presets]);

  const runTest = async () => {
    if (!form.connection.host) {
      toast.error('Host required');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.post('/cameras/test-connection', {
        protocol: form.protocol,
        host: form.connection.host,
        port: form.connection.port ? parseInt(form.connection.port) : null,
        path: form.connection.path,
        snapshotPath: form.connection.snapshotPath,
        username: form.connection.username,
        password: form.connection.password,
        useTLS: form.connection.useTLS,
        vendor: form.vendor,
        model: form.model
      });
      setTestResult(res.data);
      if (res.data.ok) {
        toast.success('Connection test successful!');
        // Auto-fill the form with the discovered working URL/path
        if (res.data.streamUrl) {
          try {
            const u = new URL(res.data.streamUrl);
            // Update path if it's different and meaningful
            if (u.pathname && u.pathname !== '/' && u.pathname !== form.connection.path) {
              updateConn('path', u.pathname + u.search);
              toast('Path auto-updated to ' + u.pathname, { icon: '🔧' });
            }
            // Update host/port if user left them blank
            if (!form.connection.host && u.hostname) updateConn('host', u.hostname);
            if (!form.connection.port && u.port) updateConn('port', u.port);
          } catch (_) { /* ignore parse errors */ }
        }
        // Auto-fill snapshot path if discovered
        if (res.data.snapshotUrl) {
          try {
            const su = new URL(res.data.snapshotUrl);
            if (su.pathname && su.pathname !== '/shot.jpg' && su.pathname !== form.connection.snapshotPath) {
              updateConn('snapshotPath', su.pathname + su.search);
            }
          } catch (_) {}
        }
      } else {
        toast.error(res.data.error || 'Test failed');
      }
    } catch (e) {
      toast.error(e.response?.data?.error || 'Test failed');
      setTestResult({ ok: false, error: e.message, diagnostics: [] });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!form.name || !form.location) {
      toast.error('Name and location required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
        port: form.connection.port ? parseInt(form.connection.port) : null,
        fps: parseInt(form.fps) || 15
      };

      // Si le test a été réussi et qu'une URL de flux fonctionnelle a été trouvée
      if (testResult && testResult.ok) {
        if (testResult.streamUrl) {
          payload.url = testResult.streamUrl;
        }
        if (testResult.snapshotUrl) {
          try {
            const urlObj = new URL(testResult.snapshotUrl);
            payload.connection.snapshotPath = urlObj.pathname + urlObj.search;
          } catch (err) {
            // Ignorer si l'URL est invalide
          }
        }
      }

      const res = await api.post('/cameras', payload);
      toast.success('Camera added successfully');
      onAdded?.(res.data);
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to add camera');
    } finally {
      setSaving(false);
    }
  };

  const canProceed = () => {
    if (step === 1) return !!form.protocol;
    if (step === 2) {
      if (form.protocol === 'usb') return true; // USB doesn't need host
      return !!form.connection.host;
    }
    if (step === 3) return testResult?.ok || true; // Allow save even if test fails (user chooses)
    return true;
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.9, opacity: 0, y: 20 }}
          onClick={e => e.stopPropagation()}
          className="gradient-border w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-slate-800/50">
            <div>
              <h2 className="text-2xl font-bold text-white flex items-center">
                <Camera className="w-6 h-6 mr-2 text-indigo-400" />
                Add Camera
              </h2>
              <p className="text-slate-400 text-sm mt-1">Connect any IP camera: ONVIF, RTSP, HLS, cloud providers</p>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-xl text-slate-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Stepper */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800/50 bg-slate-900/50">
            {STEPS.map((s, i) => (
              <React.Fragment key={s.id}>
                <div className="flex items-center space-x-2">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                    step >= s.id ? 'bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30' : 'bg-slate-800 text-slate-500'
                  }`}>
                    {step > s.id ? <Check className="w-4 h-4" /> : <s.icon className="w-4 h-4" />}
                  </div>
                  <div className="hidden sm:block">
                    <div className={`text-xs font-semibold ${step >= s.id ? 'text-white' : 'text-slate-500'}`}>{s.title}</div>
                  </div>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`flex-1 h-0.5 mx-2 transition-all ${step > s.id ? 'bg-indigo-500' : 'bg-slate-800'}`} />
                )}
              </React.Fragment>
            ))}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6">
            {step === 1 && <Step1Protocol form={form} updateField={updateField} updateConn={updateConn} presets={presets} cloudProviders={cloudProviders} api={api} />}
            {step === 2 && <Step2Connection form={form} updateField={updateField} updateConn={updateConn} updateCap={updateCap} updateNet={updateNet} showPassword={showPassword} setShowPassword={setShowPassword} />}
            {step === 3 && <Step3Test form={form} updateConn={updateConn} testing={testing} testResult={testResult} runTest={runTest} api={api} />}
            {step === 4 && <Step4Details form={form} updateField={updateField} testResult={testResult} />}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between p-6 border-t border-slate-800/50 bg-slate-900/50">
            <button
              onClick={() => setStep(s => Math.max(1, s - 1))}
              disabled={step === 1}
              className="flex items-center px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm font-semibold border border-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4 mr-1" /> Back
            </button>
            {step < 4 ? (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={!canProceed()}
                className="flex items-center px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl text-sm font-semibold shadow-lg shadow-indigo-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight className="w-4 h-4 ml-1" />
              </button>
            ) : (
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-xl text-sm font-semibold shadow-lg shadow-emerald-500/20 disabled:opacity-40"
              >
                {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                Save Camera
              </button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function Step1Protocol({ form, updateField, updateConn, presets, cloudProviders }) {
  const [phoneIp, setPhoneIp] = React.useState('');
  const [scanning, setScanning] = React.useState(false);
  const [scanResult, setScanResult] = React.useState(null);
  const { api } = useAuth();

  const applyIpWebcam = (ip) => {
    if (!ip) return;
    // Strip http:// or path if any
    let cleanIp = ip.trim().replace(/^https?:\/\//, '').split('/')[0];
    // Strip port if present
    if (cleanIp.includes(':')) cleanIp = cleanIp.split(':')[0];
    updateField('protocol', 'mjpeg');
    updateField('vendor', 'ip_webcam_android');
    updateConn('host', cleanIp);
    updateConn('port', '8080');
    updateConn('path', '/?action=stream');
    updateConn('snapshotPath', '/shot.jpg');
  };

  const scanForIpWebcams = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      // Scan port 8080 and common alternatives
      const results = [];
      for (const port of [8080, 8081, 8554]) {
        try {
          const res = await api.post('/cameras/scan-network', { port, end: 200 });
          if (res.data.devices) results.push(...res.data.devices.map(d => ({ ...d, port })));
        } catch (e) { /* ignore */ }
      }
      // Filter out self
      const filtered = results.filter(d => d.host !== '192.168.100.81');
      setScanResult({ devices: filtered });
    } catch (e) {
      setScanResult({ error: e.message, devices: [] });
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Quick setup: IP Webcam (Android) - one field only */}
      <div className="p-5 rounded-2xl bg-gradient-to-br from-indigo-500/10 via-purple-500/10 to-pink-500/10 border border-indigo-500/30">
        <div className="flex items-center gap-2 mb-2">
          <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-indigo-500/20 text-indigo-300 rounded">Quick Setup</span>
          <span className="text-xs text-slate-400">Most common — phone as camera</span>
        </div>
        <div className="text-base font-bold text-white flex items-center gap-2 mb-2">
          📱 IP Webcam (Android)
        </div>
        <p className="text-xs text-slate-300 mb-3">
          1. Install "IP Webcam" by Pavel Khlebovich on your phone<br/>
          2. Open the app, scroll down, tap <strong>"Start server"</strong><br/>
          3. Note the IP shown (e.g. <code className="text-amber-300">192.168.100.165:8080</code>)<br/>
          4. Enter just the IP below and click "Apply"
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={phoneIp}
            onChange={e => setPhoneIp(e.target.value)}
            placeholder="192.168.100.165"
            className="input-3d flex-1 font-mono"
          />
          <button
            onClick={() => applyIpWebcam(phoneIp)}
            disabled={!phoneIp}
            className="px-4 py-2 text-sm font-bold bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg disabled:opacity-40"
          >
            Apply
          </button>
          <button
            onClick={scanForIpWebcams}
            disabled={scanning}
            className="px-3 py-2 text-xs font-bold bg-slate-700 hover:bg-slate-600 text-white rounded-lg disabled:opacity-40"
            title="Scan local network for IP Webcam phones"
          >
            {scanning ? '⏳' : '🔍'} Scan
          </button>
        </div>
        {scanResult && (
          <div className="mt-2 p-2 bg-slate-800/50 rounded-lg max-h-32 overflow-y-auto">
            {scanResult.error && <div className="text-xs text-red-300 p-1">{scanResult.error}</div>}
            {scanResult.devices?.length === 0 && (
              <div className="text-xs text-slate-400 p-1">No IP Webcam found on the network. Make sure the app is running on your phone.</div>
            )}
            {scanResult.devices?.map((d, i) => (
              <button
                key={i}
                onClick={() => { applyIpWebcam(d.host); setPhoneIp(d.host); }}
                className="w-full text-left p-1.5 hover:bg-slate-700/50 rounded text-xs flex items-center justify-between"
              >
                <span className="text-slate-200">📱 {d.host}:{d.port}</span>
                <span className="text-slate-500">{d.responseTime}ms</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-lg font-bold text-white mb-3">Or pick another connection type</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {PROTOCOLS.map(p => {
            const Icon = p.icon;
            const selected = form.protocol === p.id;
            return (
              <motion.button
                key={p.id}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => updateField('protocol', p.id)}
                className={`p-4 rounded-xl text-left border transition-all ${
                  selected
                    ? 'bg-indigo-500/10 border-indigo-500/50 shadow-lg shadow-indigo-500/10'
                    : 'bg-slate-800/30 border-slate-700/50 hover:border-slate-600'
                }`}
              >
                <Icon className={`w-5 h-5 mb-2 ${selected ? 'text-indigo-400' : 'text-slate-400'}`} />
                <div className="text-sm font-bold text-white">{p.label}</div>
                <div className="text-xs text-slate-400 mt-1">{p.desc}</div>
              </motion.button>
            );
          })}
        </div>
      </div>

      {form.protocol !== 'cloud' && (
        <div>
          <h3 className="text-lg font-bold text-white mb-3">2. Brand / Model (optional)</h3>
          <select
            value={form.vendor}
            onChange={e => updateField('vendor', e.target.value)}
            className="input-3d w-full"
          >
            <option value="">— Select brand for auto-fill —</option>
            {presets.map(p => (
              <option key={p.id} value={p.id}>{p.vendor} {p.supportsOnvif ? '(ONVIF)' : ''}</option>
            ))}
          </select>
          {form.vendor && (
            <div className="mt-3 p-3 bg-slate-800/30 rounded-lg border border-slate-700/50">
              <div className="text-xs text-slate-400">
                <strong className="text-slate-300">Auto-filled paths:</strong>{' '}
                {presets.find(p => p.id === form.vendor)?.defaultPaths?.join(' • ')}
              </div>
              {presets.find(p => p.id === form.vendor)?.notes && (
                <div className="text-xs text-amber-400 mt-2">ℹ {presets.find(p => p.id === form.vendor).notes}</div>
              )}
            </div>
          )}
          <div className="mt-3">
            <label className="block text-xs font-semibold text-slate-300 mb-1">Model (optional)</label>
            <input
              type="text"
              value={form.model}
              onChange={e => updateField('model', e.target.value)}
              placeholder="e.g. DS-2CD2143G0-I"
              className="input-3d w-full"
            />
          </div>
        </div>
      )}

      {form.protocol === 'cloud' && (
        <div>
          <h3 className="text-lg font-bold text-white mb-3">2. Cloud Provider</h3>
          <div className="grid grid-cols-2 gap-3">
            {cloudProviders.map(p => (
              <motion.button
                key={p.id}
                whileHover={{ scale: 1.02 }}
                onClick={() => updateField('vendor', p.id)}
                className={`p-3 rounded-xl text-left border transition-all ${
                  form.vendor === p.id
                    ? 'bg-indigo-500/10 border-indigo-500/50'
                    : 'bg-slate-800/30 border-slate-700/50 hover:border-slate-600'
                }`}
              >
                <div className="text-sm font-bold text-white">{p.vendor}</div>
                <div className="text-xs text-slate-400 mt-1">{p.notes || 'OAuth required'}</div>
              </motion.button>
            ))}
          </div>
          <div className="mt-3 p-3 bg-amber-500/10 rounded-lg border border-amber-500/30 text-xs text-amber-300">
            <Shield className="w-4 h-4 inline mr-1" /> Cloud cameras require API key / OAuth token.
            You'll enter it on the next step.
          </div>
        </div>
      )}
    </div>
  );
}

function Step2Connection({ form, updateField, updateConn, updateCap, updateNet, showPassword, setShowPassword }) {
  const [usbDevices, setUsbDevices] = React.useState(null);
  const [usbLoading, setUsbLoading] = React.useState(false);

  React.useEffect(() => {
    if (form.protocol !== 'usb') return;
    setUsbLoading(true);
    const API_BASE = process.env.REACT_APP_API_URL || `${window.location.protocol}//${window.location.hostname}:5001`;
    fetch(`${API_BASE}/api/cameras/usb-devices`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => { setUsbDevices(d); setUsbLoading(false); })
      .catch(() => setUsbLoading(false));
  }, [form.protocol]);

  if (form.protocol === 'usb') {
    const idx = parseInt(form.connection.host) || 0;
    return (
      <div className="space-y-5">
        <h3 className="text-lg font-bold text-white">USB Webcam</h3>

        <div className="p-4 bg-indigo-500/10 border border-indigo-500/30 rounded-xl text-sm text-indigo-200">
          <strong>📷 Server-attached USB camera.</strong> The webcam plugged into the same machine that runs the server (your laptop's built-in cam, or any USB cam connected to it).
          <br /><br />
          OpenCV is used to capture frames. Each camera is mapped to a numeric index (0 = first, 1 = second, etc.).
        </div>

        <div className="p-3 bg-slate-800/40 border border-slate-700/50 rounded-xl">
          <div className="text-xs font-semibold text-slate-300 mb-2">Detected USB cameras:</div>
          {usbLoading && <div className="text-xs text-slate-400">Scanning USB bus...</div>}
          {!usbLoading && usbDevices?.devices?.length > 0 && (
            <div className="space-y-1">
              {usbDevices.devices.map(d => (
                <button
                  key={d.index}
                  type="button"
                  onClick={() => updateConn('host', String(d.index))}
                  className={`w-full text-left p-2 rounded text-xs flex items-center justify-between ${
                    idx === d.index ? 'bg-indigo-500/20 border border-indigo-500/40' : 'hover:bg-slate-700/50'
                  }`}
                >
                  <span className="text-slate-200">📷 {d.name} <span className="text-slate-500">(index {d.index})</span></span>
                  <span className="text-slate-500">{d.resolution}</span>
                </button>
              ))}
            </div>
          )}
          {!usbLoading && (!usbDevices || !usbDevices.devices?.length) && (
            <div className="text-xs text-slate-400">No USB cameras detected. The server will use index 0 by default.</div>
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-300 mb-1">Camera index</label>
          <input
            type="number"
            min="0"
            max="9"
            value={form.connection.host}
            onChange={e => updateConn('host', e.target.value)}
            placeholder="0"
            className="input-3d w-full"
          />
          <p className="text-xs text-slate-500 mt-1">0 = first camera, 1 = second, etc.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h3 className="text-lg font-bold text-white">Connection Details</h3>

      <div className="p-3 bg-indigo-500/10 border border-indigo-500/30 rounded-xl text-xs text-indigo-300">
        <strong>📱 IP Webcam setup:</strong> Open the IP Webcam app on your phone → tap "Start Server" → use the URL shown (e.g., http://192.168.100.165:8080).
        <br />⚠ Make sure PC and phone are on the same WiFi network. The phone's IP can change if WiFi reconnects.
      </div>

      <div className="p-3 bg-slate-800/40 border border-slate-700/50 rounded-xl text-xs text-slate-300 space-y-1">
        <div><strong>For MJPEG / IP Webcam (most common with phones):</strong></div>
        <div>• Host: just the IP like <code className="text-amber-300">192.168.100.165</code> (no <code>http://</code> prefix)</div>
        <div>• Port: <code className="text-amber-300">8080</code> (default IP Webcam port, NOT 554)</div>
        <div>• Stream Path: <code className="text-amber-300">/?action=stream</code></div>
        <div>• Username/Password: leave empty unless you set auth in the IP Webcam app</div>
      </div>

      <div className="bg-slate-800/40 rounded-xl border border-indigo-500/30 p-3">
        <label className="block text-xs font-semibold text-indigo-300 mb-1">⚡ Quick fill — paste a full URL</label>
        <input
          type="text"
          placeholder="rtsp://user:pass@camera.com:554/stream1  OR  http://192.168.100.81:4000/video"
          className="input-3d w-full font-mono text-sm"
          onChange={e => {
            const raw = e.target.value.trim();
            if (!raw) return;
            try {
              // Accept rtsp://, rtsps://, http://, https://
              if (!/^(rtsp|rtsps|http|https|rtmp):\/\//i.test(raw)) return;
              const u = new URL(raw);
              const isTls = ['https:', 'rtsps:'].includes(u.protocol);
              updateConn('useTLS', isTls);
              if (u.username) updateConn('username', decodeURIComponent(u.username));
              if (u.password) updateConn('password', decodeURIComponent(u.password));
              updateConn('host', u.hostname);
              updateConn('port', u.port || (isTls ? '443' : u.protocol === 'rtsp:' ? '554' : '80'));
              const path = u.pathname && u.pathname !== '/' ? u.pathname + u.search : '';
              updateConn('path', path);
              // Auto-pick protocol from URL scheme
              if (u.protocol.startsWith('rtsp')) updateField('protocol', 'rtsp');
              else if (u.protocol === 'rtmp:') updateField('protocol', 'rtmp');
              else if (u.protocol === 'https:' || u.protocol === 'http:') updateField('protocol', 'mjpeg');
              toast.success('URL parsed — protocol/host/port/auth filled');
            } catch (err) {
              // not a valid URL yet, ignore silently
            }
          }}
        />
        <p className="text-xs text-slate-500 mt-1">Paste RTSP, RTMP, HTTP or HTTPS URL. Auth in URL is extracted to fields.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-slate-300 mb-1">Host / IP *</label>
          <input
            type="text"
            value={form.connection.host}
            onChange={e => updateConn('host', e.target.value)}
            placeholder="192.168.1.100 or camera.example.com"
            className="input-3d w-full"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-300 mb-1">Port</label>
          <input
            type="number"
            value={form.connection.port}
            onChange={e => updateConn('port', e.target.value)}
            placeholder="554"
            className="input-3d w-full"
          />
        </div>
      </div>

      {form.protocol !== 'cloud' && (
        <>
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Stream Path</label>
            <input
              type="text"
              value={form.connection.path}
              onChange={e => updateConn('path', e.target.value)}
              placeholder="/Streaming/Channels/101"
              className="input-3d w-full font-mono text-sm"
            />
            <p className="text-xs text-slate-500 mt-1">e.g. /live.sdp, /video, /h264/ch01/main</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Snapshot Path (optional)</label>
            <input
              type="text"
              value={form.connection.snapshotPath}
              onChange={e => updateConn('snapshotPath', e.target.value)}
              placeholder="/shot.jpg or /ISAPI/Streaming/channels/1/picture"
              className="input-3d w-full font-mono text-sm"
            />
          </div>
        </>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-slate-300 mb-1">Username</label>
          <input
            type="text"
            value={form.connection.username}
            onChange={e => updateConn('username', e.target.value)}
            placeholder="admin"
            className="input-3d w-full"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-300 mb-1">Password / Token</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={form.connection.password}
              onChange={e => updateConn('password', e.target.value)}
              placeholder="••••••••"
              className="input-3d w-full pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1"
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center space-x-3">
        <label className="flex items-center space-x-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={form.connection.useTLS}
            onChange={e => updateConn('useTLS', e.target.checked)}
            className="rounded border-slate-600 bg-slate-800 text-indigo-500"
          />
          <span>Use TLS / SSL (rtsps, https)</span>
        </label>
      </div>

      <details className="bg-slate-800/30 rounded-xl border border-slate-700/50">
        <summary className="px-4 py-3 cursor-pointer text-sm font-semibold text-slate-300 hover:text-white">
          ⚙ Advanced options
        </summary>
        <div className="p-4 space-y-4 border-t border-slate-700/50">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">Resolution</label>
              <select value={form.capabilities.resolution} onChange={e => { updateCap('resolution', e.target.value); updateField('resolution', e.target.value); }} className="input-3d w-full">
                <option value="640x480">640x480 (VGA)</option>
                <option value="1280x720">1280x720 (HD)</option>
                <option value="1920x1080">1920x1080 (Full HD)</option>
                <option value="2560x1440">2560x1440 (QHD/2K)</option>
                <option value="3840x2160">3840x2160 (4K)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">FPS</label>
              <input type="number" value={form.fps} onChange={e => { updateField('fps', parseInt(e.target.value) || 15); updateCap('fps', parseInt(e.target.value) || 15); }} min="1" max="60" className="input-3d w-full" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="flex items-center space-x-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.capabilities.ptz} onChange={e => updateCap('ptz', e.target.checked)} className="rounded border-slate-600 bg-slate-800" />
              <span>PTZ (Pan/Tilt/Zoom)</span>
            </label>
            <label className="flex items-center space-x-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.capabilities.audio} onChange={e => updateCap('audio', e.target.checked)} className="rounded border-slate-600 bg-slate-800" />
              <span>Audio enabled</span>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="flex items-center space-x-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.network.behindNAT} onChange={e => updateNet('behindNAT', e.target.checked)} className="rounded border-slate-600 bg-slate-800" />
              <span>Behind NAT</span>
            </label>
            <label className="flex items-center space-x-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.network.relayRequired} onChange={e => updateNet('relayRequired', e.target.checked)} className="rounded border-slate-600 bg-slate-800" />
              <span>Relay required</span>
            </label>
          </div>
        </div>
      </details>
    </div>
  );
}

function Step3Test({ form, updateConn, testing, testResult, runTest, api }) {
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);

  const getTroubleshootingTips = () => {
    if (!testResult || testResult.ok) return null;
    const tips = [];
    const err = (testResult.error || '').toLowerCase();
    const diag = (testResult.diagnostics || []).map(d => (d.message || '').toLowerCase()).join(' ');

    if (err.includes('enotfound') || err.includes('getaddrinfo') || diag.includes('unreachable') || diag.includes('host not found')) {
      tips.push({ icon: '🌐', text: 'The host could not be resolved. Check that the IP address is correct and that the device is on the same network as this server.' });
    }
    if (err.includes('timeout') || err.includes('etimedout') || diag.includes('timed out')) {
      tips.push({ icon: '⏱', text: 'Connection timed out. The device may be offline, on a different network, or a firewall is blocking the port. Try pinging the IP.' });
    }
    if (err.includes('econnrefused') || diag.includes('connection refused')) {
      tips.push({ icon: '🚫', text: 'Connection refused. The port is closed or the service is not running. For IP Webcam, make sure the app is "Started" on the phone.' });
    }
    if (err.includes('401') || err.includes('unauthorized') || diag.includes('auth')) {
      tips.push({ icon: '🔒', text: 'Authentication failed. Double-check username and password. Some cameras need a special "auth" string.' });
    }
    if (form.protocol === 'rtsp' && form.connection.port === '554' && form.vendor === 'ip_webcam_android') {
      tips.push({ icon: '📱', text: 'IP Webcam RTSP uses port 8554 (not 554), and must be enabled in the app settings. Try MJPEG on port 8080 instead.' });
    }
    if (tips.length === 0) {
      tips.push({ icon: '💡', text: 'Check network connectivity, firewall, and that the device is powered on and the streaming service is started.' });
    }
    return tips;
  };

  const runNetworkScan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await api.post('/cameras/scan-network', { port: form.connection.port || 8080 });
      setScanResult(res.data);
    } catch (e) {
      setScanResult({ ok: false, error: e.message, devices: [] });
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-5">
      <h3 className="text-lg font-bold text-white">Test Connection</h3>
      <p className="text-sm text-slate-400">Verify the camera is reachable and credentials work before saving.</p>

      <button
        onClick={runTest}
        disabled={testing || !form.connection.host}
        className="w-full flex items-center justify-center px-5 py-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl font-semibold shadow-lg shadow-indigo-500/20 disabled:opacity-40"
      >
        {testing ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Testing...</> : <><TestTube className="w-5 h-5 mr-2" /> Run Connection Test</>}
      </button>

      {testResult && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className={`p-4 rounded-xl border ${
          testResult.ok ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'
        }`}>
          <div className="flex items-center mb-2">
            {testResult.ok ? <Check className="w-5 h-5 mr-2 text-emerald-400" /> : <AlertCircle className="w-5 h-5 mr-2 text-red-400" />}
            <span className={`font-bold ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {testResult.ok ? 'Connection successful' : 'Connection failed'}
            </span>
            <span className="ml-auto text-xs text-slate-400">{testResult.duration_ms}ms</span>
          </div>
          {testResult.error && <div className="text-sm text-red-300 mt-1">{testResult.error}</div>}
          {testResult.diagnostics && testResult.diagnostics.length > 0 && (
            <div className="mt-3 space-y-1">
              {testResult.diagnostics.map((d, i) => (
                <div key={i} className={`text-xs flex items-start ${
                  d.severity === 'success' ? 'text-emerald-300' :
                  d.severity === 'error' ? 'text-red-300' :
                  d.severity === 'warning' ? 'text-amber-300' : 'text-slate-300'
                }`}>
                  <span className="mr-2">{d.severity === 'success' ? '✓' : d.severity === 'error' ? '✗' : 'ℹ'}</span>
                  {d.message}
                </div>
              ))}
            </div>
          )}

          {!testResult.ok && getTroubleshootingTips() && (
            <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg space-y-2">
              <div className="text-xs font-bold text-amber-300">Troubleshooting</div>
              {getTroubleshootingTips().map((tip, i) => (
                <div key={i} className="text-xs text-amber-200 flex items-start">
                  <span className="mr-2">{tip.icon}</span>
                  <span>{tip.text}</span>
                </div>
              ))}
            </div>
          )}

          {testResult.snapshotUrl && (
            <div className="mt-3">
              <div className="text-xs text-slate-400 mb-1">Snapshot preview:</div>
              <img src={testResult.snapshotUrl} alt="snapshot" className="rounded-lg max-h-48 border border-slate-700"
                onError={e => { e.target.style.display = 'none'; }} />
            </div>
          )}
        </motion.div>
      )}

      <div className="border-t border-slate-700/50 pt-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-slate-400">
            <strong>Can't find your camera's IP?</strong> Scan the local network to discover devices.
          </div>
          <button
            onClick={runNetworkScan}
            disabled={scanning}
            className="flex items-center px-3 py-1.5 text-xs bg-slate-700/50 hover:bg-slate-700 text-slate-200 rounded-lg disabled:opacity-40"
          >
            {scanning ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Scanning...</> : <><Wifi className="w-3 h-3 mr-1.5" /> Scan Network</>}
          </button>
        </div>
        {scanResult && (
          <div className="mt-2 p-2 bg-slate-800/30 rounded-lg max-h-40 overflow-y-auto">
            {scanResult.ok && scanResult.devices?.length === 0 && (
              <div className="text-xs text-slate-500 p-2">No devices found on port {scanResult.port}.</div>
            )}
            {scanResult.devices?.map((d, i) => (
              <button
                key={i}
                onClick={() => updateConn('host', d.host)}
                className="w-full text-left p-2 hover:bg-slate-700/50 rounded text-xs flex items-center justify-between"
              >
                <span className="text-slate-200">{d.host}</span>
                <span className="text-slate-500">{d.responseTime}ms</span>
              </button>
            ))}
            {scanResult.error && <div className="text-xs text-red-300 p-2">{scanResult.error}</div>}
          </div>
        )}
      </div>

      <div className="text-xs text-slate-500 p-3 bg-slate-800/30 rounded-lg">
        <strong>Tip:</strong> RTSP/RTMP streams require an HLS/WebRTC proxy for browser viewing.
        The system will automatically start the proxy when needed.
      </div>
    </div>
  );
}

function Step4Details({ form, updateField, testResult }) {
  return (
    <div className="space-y-5">
      <h3 className="text-lg font-bold text-white">Final Details</h3>

      <div>
        <label className="block text-xs font-semibold text-slate-300 mb-1">Camera Name *</label>
        <input
          type="text"
          value={form.name}
          onChange={e => updateField('name', e.target.value)}
          placeholder="Front Door"
          className="input-3d w-full"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-300 mb-1">Location *</label>
        <input
          type="text"
          value={form.location}
          onChange={e => updateField('location', e.target.value)}
          placeholder="Main entrance, ground floor"
          className="input-3d w-full"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-300 mb-1">Description</label>
        <textarea
          value={form.description}
          onChange={e => updateField('description', e.target.value)}
          placeholder="Optional notes about this camera..."
          rows={2}
          className="input-3d w-full"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-300 mb-1">Tags (comma-separated)</label>
        <input
          type="text"
          value={form.tags}
          onChange={e => updateField('tags', e.target.value)}
          placeholder="entrance, outdoor, 24/7"
          className="input-3d w-full"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-300 mb-1">Timezone</label>
        <input
          type="text"
          value={form.timezone}
          onChange={e => updateField('timezone', e.target.value)}
          placeholder="Africa/Tunis"
          className="input-3d w-full"
        />
      </div>

      {testResult && (
        <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-700/50">
          <div className="text-xs font-semibold text-slate-300 mb-2">Summary</div>
          <div className="text-xs text-slate-400 space-y-1">
            <div>Protocol: <span className="text-white">{form.protocol.toUpperCase()}</span></div>
            <div>Host: <span className="text-white font-mono">{form.connection.host}:{form.connection.port || '(default)'}</span></div>
            <div>Test: <span className={testResult.ok ? 'text-emerald-400' : 'text-red-400'}>{testResult.ok ? '✓ OK' : '✗ Failed'}</span></div>
          </div>
        </div>
      )}

      <div className="text-xs text-amber-400 p-3 bg-amber-500/10 rounded-lg border border-amber-500/30">
        <Shield className="w-4 h-4 inline mr-1" /> Your credentials will be encrypted with AES-256-GCM before storage.
      </div>
    </div>
  );
}
