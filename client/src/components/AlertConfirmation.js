import React from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, ShieldAlert, CheckCircle, XCircle, Video } from 'lucide-react';

// Use environment API base if configured, otherwise fallback to standard dev port
const API_BASE = process.env.REACT_APP_API_URL || `${window.location.protocol}//${window.location.hostname}:5001`;

export default function AlertConfirmation({ alert, onConfirm, onDismiss }) {
  if (!alert) return null;

  // Build the full URL to the video clip served by Node.js static middleware
  const videoUrl = alert.details?.clipPath ? `${API_BASE}${alert.details.clipPath}` : null;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
    >
      <div className="bg-slate-900 border-2 border-red-500/50 rounded-2xl shadow-2xl shadow-red-900/20 max-w-2xl w-full overflow-hidden">
        {/* Header */}
        <div className="bg-red-500/10 border-b border-red-500/20 p-4 flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-6 h-6 text-red-500" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white uppercase flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-500" />
              Confirmation Humaine Requise
            </h2>
            <p className="text-sm text-red-300">
              {alert.details?.summary || `Menace critique détectée (${alert.type})`}
            </p>
          </div>
        </div>

        {/* Video Player */}
        <div className="p-4">
          <div className="bg-black rounded-xl aspect-video relative overflow-hidden border border-slate-700 flex items-center justify-center">
            {videoUrl ? (
              <video 
                src={videoUrl} 
                autoPlay 
                controls 
                loop 
                className="w-full h-full object-contain"
                crossOrigin="anonymous"
              />
            ) : (
              <div className="text-slate-500 flex flex-col items-center">
                <Video className="w-12 h-12 mb-2 opacity-50" />
                <p>Clip vidéo non disponible</p>
                {alert.frameBase64 && (
                  <img src={`data:image/jpeg;base64,${alert.frameBase64}`} alt="Alert snapshot" className="absolute inset-0 w-full h-full object-cover opacity-50 blur-sm" />
                )}
              </div>
            )}
            
            <div className="absolute top-2 right-2 bg-black/60 backdrop-blur px-2 py-1 rounded text-xs font-mono text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              PREUVE VIDÉO
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 bg-slate-800/50 border-t border-slate-700 flex gap-4">
          <button
            onClick={() => onDismiss(alert)}
            className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-colors border border-slate-600"
          >
            <XCircle className="w-5 h-5" />
            FAUSSE ALERTE
          </button>
          <button
            onClick={() => onConfirm(alert)}
            className="flex-1 bg-red-600 hover:bg-red-500 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-colors shadow-lg shadow-red-900/50"
          >
            <CheckCircle className="w-5 h-5" />
            CONFIRMER — APPELER POLICE
          </button>
        </div>
      </div>
    </motion.div>
  );
}
