import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Camera, MapPin, AlertTriangle, Shield, Globe, Trash2, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const API_BASE = process.env.REACT_APP_API_URL || `${window.location.protocol}//${window.location.hostname}:5001`;

export default function CameraCard({ camera, alertCount = 0, onDelete }) {
  const { token } = useAuth();
  const [streamUrl, setStreamUrl] = useState(null);
  const [proxyUrl, setProxyUrl] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [imgErrorCount, setImgErrorCount] = useState(0);
  const imgRef = useRef(null);

  // Use the streamUrl that the dashboard already fetched, fall back to a fresh fetch
  useEffect(() => {
    let cancelled = false;
    if (camera.streamUrl) {
      setStreamUrl(camera.streamUrl);
      setProxyUrl(camera.proxyUrl || null);
      return;
    }
    const fetchStreamUrl = async () => {
      try {
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(`${API_BASE}/api/cameras/${camera.id}/stream-url`, { headers });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.url) {
          setStreamUrl(data.url);
          setProxyUrl(data.proxyUrl);
          setPreviewLoaded(false);
          setPreviewError(false);
        }
      } catch (e) {
        // silent
      }
    };
    fetchStreamUrl();
    return () => { cancelled = true; };
  }, [camera.id, camera.streamUrl, camera.proxyUrl, camera.url, token]);

  // Tick a timestamp to force img reload on retry
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (previewError && proxyUrl) {
      const t = setTimeout(() => { setTick(x => x + 1); setPreviewError(false); }, 1500);
      return () => clearTimeout(t);
    }
  }, [previewError, proxyUrl, tick]);

  const handleRetry = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setPreviewError(false);
    setPreviewLoaded(false);
    setImgErrorCount(0);
    setTick(t => t + 1);
  };

  const handleDelete = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setShowConfirm(true);
  };

  const confirmDelete = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onDelete) onDelete(camera.id);
    setShowConfirm(false);
  };

  const nativeMjpegUrl = camera.id && token ? `${API_BASE}/api/cameras/${camera.id}/proxy-stream?t=${tick}&token=${encodeURIComponent(token)}` : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, rotateX: 10 }}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      whileHover={{ y: -8, scale: 1.02 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      style={{ transformStyle: 'preserve-3d', perspective: '1000px' }}
      className="gradient-border overflow-hidden group"
    >
      <div className="relative aspect-video bg-slate-900 overflow-hidden">
        {nativeMjpegUrl && !previewError && (
          <img
            ref={imgRef}
            src={nativeMjpegUrl}
            crossOrigin="anonymous"
            alt={camera.name}
            className="absolute inset-0 w-full h-full object-cover transition-opacity duration-300"
            style={{ opacity: previewLoaded ? 1 : 0 }}
            onLoad={() => { setPreviewLoaded(true); setPreviewError(false); }}
            onError={() => { setPreviewError(true); }}
          />
        )}
        {!previewError && !previewLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/50 z-10 pointer-events-none">
            <div className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {(previewError || !nativeMjpegUrl) && (
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-900/50 via-slate-900 to-purple-900/50">
            <div className="absolute inset-0 opacity-20" style={{
              backgroundImage: `radial-gradient(circle at 50% 50%, rgba(99, 102, 241, 0.3) 0%, transparent 60%)`,
            }} />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <motion.div
                animate={{ y: [0, -8, 0] }}
                transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                className="w-20 h-20 rounded-2xl bg-slate-800/60 flex items-center justify-center border border-slate-700/50 mb-3"
              >
                {previewError ? (
                  <AlertTriangle className="w-10 h-10 text-amber-400" />
                ) : (
                  <Globe className="w-10 h-10 text-indigo-400" />
                )}
              </motion.div>
              {previewError && (
                <button onClick={handleRetry} className="flex items-center text-xs text-slate-400 hover:text-white transition-colors">
                  <RefreshCw className="w-3 h-3 mr-1" /> Retry
                </button>
              )}
            </div>
          </div>
        )}

        {previewLoaded && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="scan-line" />
          </div>
        )}

        {previewLoaded && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute top-3 left-3 flex items-center px-2.5 py-1 bg-red-500 rounded-lg text-white text-xs font-bold shadow-lg shadow-red-500/30"
          >
            <span className="w-2 h-2 bg-white rounded-full animate-pulse mr-1.5" />
            LIVE
          </motion.div>
        )}

        {!previewLoaded && !previewError && nativeMjpegUrl && (
          <div className="absolute top-3 left-3 flex items-center px-2.5 py-1 bg-amber-500/80 rounded-lg text-white text-xs font-bold shadow-lg">
            <span className="w-2 h-2 bg-white rounded-full animate-pulse mr-1.5" />
            CONNECTING
          </div>
        )}

        {alertCount > 0 && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute top-3 right-3 flex items-center px-2.5 py-1 bg-amber-500 rounded-lg text-white text-xs font-bold shadow-lg"
          >
            <AlertTriangle className="w-3 h-3 mr-1" />
            {alertCount}
          </motion.div>
        )}

        <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
          <div className="flex items-center text-white text-xs font-medium">
            <span className={`w-2 h-2 rounded-full mr-1.5 ${previewLoaded ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            {previewLoaded ? 'Connected' : nativeMjpegUrl ? 'Connecting...' : 'Idle'}
          </div>
          <span className="text-xs text-slate-400">{camera.resolution || '720p'}</span>
        </div>
      </div>

      <div className="p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-lg font-bold text-white group-hover:text-indigo-400 transition-colors">
              {camera.name}
            </h3>
            <div className="flex items-center text-slate-400 text-sm mt-1">
              <MapPin className="w-3.5 h-3.5 mr-1" />
              {camera.location}
            </div>
          </div>
          <div className={`p-2.5 rounded-xl ${
            camera.detectionEnabled
              ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
              : 'bg-slate-800 text-slate-500'
          }`}>
            <Shield className="w-5 h-5" />
          </div>
        </div>

        <div className="mt-4 p-3 bg-slate-800/40 rounded-xl border border-slate-700/30">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-400 font-medium">AI Detection</span>
            <span className={`font-bold ${camera.detectionEnabled ? 'text-indigo-400' : 'text-slate-500'}`}>
              {camera.detectionEnabled ? 'ACTIVE' : 'DISABLED'}
            </span>
          </div>
        </div>

        <div className="mt-5 flex space-x-3">
          <Link to={`/camera/${camera.id}`} className="flex-1">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="w-full flex items-center justify-center py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-xl text-sm font-semibold transition-all shadow-lg shadow-indigo-500/20"
            >
              <Camera className="w-4 h-4 mr-2" />
              View Live
            </motion.button>
          </Link>
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={handleDelete}
            className="px-4 py-2.5 bg-slate-800 hover:bg-red-600/20 text-slate-400 hover:text-red-400 rounded-xl transition-all border border-slate-700 hover:border-red-500/30"
          >
            <Trash2 className="w-4 h-4" />
          </motion.button>
        </div>
      </div>

      {showConfirm && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-10 rounded-xl" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowConfirm(false); }}>
          <div className="text-center p-4" onClick={(e) => e.stopPropagation()}>
            <Trash2 className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <p className="text-white font-bold mb-1">Delete Camera?</p>
            <p className="text-slate-400 text-xs mb-4">This action cannot be undone</p>
            <div className="flex space-x-2">
              <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowConfirm(false); }} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-semibold">
                Cancel
              </button>
              <button onClick={confirmDelete} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
