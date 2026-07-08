import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Search, Filter, Grid3x3, LayoutGrid, Calendar, Trash2, Download,
  Image as ImageIcon, Camera, X, Eye, ChevronLeft, ChevronRight, RefreshCw
} from 'lucide-react';
import toast from 'react-hot-toast';

const API_BASE = process.env.REACT_APP_API_URL || `${window.location.protocol}//${window.location.hostname}:5001`;

export default function Photos() {
  const { api } = useAuth();
  const navigate = useNavigate();
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cameras, setCameras] = useState([]);
  const [stats, setStats] = useState({ total: 0, last24h: 0, byCamera: [] });
  const [filter, setFilter] = useState({ camera: 'all', search: '', sort: 'newest' });
  const [view, setView] = useState('grid');
  const [lightboxIdx, setLightboxIdx] = useState(null);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [photosRes, statsRes, camerasRes] = await Promise.all([
        api.get('/photos?limit=500'),
        api.get('/photos/stats'),
        api.get('/cameras').catch(() => ({ data: [] }))
      ]);
      setPhotos(photosRes.data.photos || []);
      setStats(statsRes.data);
      // /api/cameras returns an array directly (not wrapped in { data })
      setCameras(Array.isArray(camerasRes.data) ? camerasRes.data : (camerasRes.data?.cameras || []));
    } catch (e) {
      console.error(e);
      toast.error('Failed to load photos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  const filtered = useMemo(() => {
    let list = photos;
    if (filter.camera !== 'all') list = list.filter(p => p.cameraId === filter.camera);
    if (filter.search) {
      const q = filter.search.toLowerCase();
      list = list.filter(p => (p.cameraName || '').toLowerCase().includes(q));
    }
    list = [...list];
    if (filter.sort === 'oldest') list.sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    else if (filter.sort === 'size') list.sort((a, b) => (b.size || 0) - (a.size || 0));
    else list.sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
    return list;
  }, [photos, filter]);

  const cameraMap = useMemo(() => Object.fromEntries(cameras.map(c => [c.id, c])), [cameras]);

  const handleDelete = async (p) => {
    if (!window.confirm('Delete this photo?')) return;
    try {
      await api.delete(`/photos/${p.id}`);
      setPhotos(prev => prev.filter(x => x.id !== p.id));
      toast.success('Photo deleted');
    } catch (e) {
      toast.error('Delete failed');
    }
  };

  const handleDownload = (p) => {
    const url = p.url.startsWith('http') ? p.url : `${API_BASE}${p.url}`;
    const a = document.createElement('a');
    a.href = url; a.download = p.filename; a.click();
  };

  // Lightbox keyboard
  useEffect(() => {
    if (lightboxIdx === null) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setLightboxIdx(null);
      if (e.key === 'ArrowRight') setLightboxIdx(i => Math.min(filtered.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setLightboxIdx(i => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxIdx, filtered]);

  return (
    <div className="min-h-screen bg-[#030712]">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div className="flex items-center space-x-4">
            <motion.button whileHover={{ scale: 1.1, x: -3 }} whileTap={{ scale: 0.9 }} onClick={() => navigate('/')} className="p-2 hover:bg-slate-800 rounded-xl text-slate-400 hover:text-white border border-slate-800">
              <ArrowLeft className="w-5 h-5" />
            </motion.button>
            <div>
              <h1 className="text-2xl font-black text-white flex items-center gap-2">
                <ImageIcon className="w-6 h-6 text-indigo-400" /> Photo Gallery
              </h1>
              <p className="text-sm text-slate-400 mt-0.5">All your captured photos across cameras</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={fetchAll} className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm border border-slate-700">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </motion.button>
            <div className="flex gap-1 p-0.5 rounded-lg bg-slate-800/50">
              <button onClick={() => setView('grid')} className={`p-1.5 rounded ${view === 'grid' ? 'bg-indigo-500/80 text-white' : 'text-slate-400'}`} title="Grid view"><LayoutGrid className="w-4 h-4" /></button>
              <button onClick={() => setView('list')} className={`p-1.5 rounded ${view === 'list' ? 'bg-indigo-500/80 text-white' : 'text-slate-400'}`} title="List view"><Grid3x3 className="w-4 h-4" /></button>
            </div>
          </div>
        </motion.div>

        {/* Stats cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Total Photos', value: stats.total, color: 'text-indigo-400' },
            { label: 'Last 24h', value: stats.last24h, color: 'text-emerald-400' },
            { label: 'Cameras', value: stats.byCamera.length, color: 'text-cyan-400' },
            { label: 'Showing', value: filtered.length, color: 'text-amber-400' },
          ].map((s, i) => (
            <motion.div key={s.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className="glass rounded-xl p-3 border border-slate-800/50">
              <div className="text-xs text-slate-400">{s.label}</div>
              <div className={`text-2xl font-black ${s.color} mt-0.5`}>{s.value}</div>
            </motion.div>
          ))}
        </div>

        {/* Filters */}
        <div className="glass rounded-2xl p-4 mb-6 border border-slate-800/50 flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={filter.search}
              onChange={(e) => setFilter(f => ({ ...f, search: e.target.value }))}
              placeholder="Search by camera name…"
              className="w-full pl-9 pr-3 py-2 bg-slate-900/80 border border-slate-700 rounded-xl text-sm text-slate-200 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <select
            value={filter.camera}
            onChange={(e) => setFilter(f => ({ ...f, camera: e.target.value }))}
            className="px-3 py-2 bg-slate-900/80 border border-slate-700 rounded-xl text-sm text-slate-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="all">All cameras ({stats.total})</option>
            {cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select
            value={filter.sort}
            onChange={(e) => setFilter(f => ({ ...f, sort: e.target.value }))}
            className="px-3 py-2 bg-slate-900/80 border border-slate-700 rounded-xl text-sm text-slate-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="size">Largest first</option>
          </select>
        </div>

        {/* Gallery */}
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64">
            <div className="animate-spin rounded-full h-10 w-10 border-2 border-indigo-500 border-t-transparent mb-3" />
            <p className="text-sm text-slate-400">Loading photos…</p>
          </div>
        ) : filtered.length === 0 ? (
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="glass rounded-2xl p-12 text-center border border-slate-800/50">
            <motion.div animate={{ y: [0, -6, 0] }} transition={{ duration: 2, repeat: Infinity }} className="w-20 h-20 mx-auto mb-4 rounded-2xl bg-slate-800/60 flex items-center justify-center border border-slate-700/50">
              <Camera className="w-10 h-10 text-slate-600" />
            </motion.div>
            <h3 className="text-lg font-bold text-white mb-2">No photos yet</h3>
            <p className="text-sm text-slate-400 mb-6">Open any camera view and press <kbd className="px-1.5 py-0.5 bg-slate-700 rounded font-mono text-xs">P</kbd> to capture a photo</p>
            <button onClick={() => navigate('/')} className="px-4 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl text-sm font-semibold">Go to cameras</button>
          </motion.div>
        ) : view === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {filtered.map((p, i) => (
              <motion.div
                key={p.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: Math.min(i * 0.015, 0.4) }}
                className="photo-card group aspect-video cursor-pointer"
                onClick={() => setLightboxIdx(i)}
              >
                <img
                  src={p.url.startsWith('http') ? p.url : `${API_BASE}${p.url}`}
                  alt={p.cameraName}
                  loading="lazy"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between">
                    <span className="text-[10px] text-white truncate">{p.cameraName}</span>
                    <span className="text-[9px] text-slate-300 font-mono">{new Date(p.capturedAt).toLocaleDateString()}</span>
                  </div>
                  <div className="absolute top-1.5 right-1.5 flex gap-1">
                    <button onClick={(e) => { e.stopPropagation(); handleDownload(p); }} className="p-1 rounded bg-slate-800/80 hover:bg-indigo-500/80 text-white"><Download className="w-3 h-3" /></button>
                    <button onClick={(e) => { e.stopPropagation(); handleDelete(p); }} className="p-1 rounded bg-slate-800/80 hover:bg-rose-500/80 text-white"><Trash2 className="w-3 h-3" /></button>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(p => (
              <motion.div key={p.id} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="glass rounded-xl p-3 flex items-center gap-4 border border-slate-800/50 hover:border-indigo-500/50 cursor-pointer" onClick={() => setLightboxIdx(filtered.indexOf(p))}>
                <img src={p.url.startsWith('http') ? p.url : `${API_BASE}${p.url}`} alt={p.cameraName} loading="lazy" className="w-24 h-14 object-cover rounded-lg" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-white truncate">{p.cameraName}</div>
                  <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-3">
                    <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(p.capturedAt).toLocaleString()}</span>
                    <span>{(p.size / 1024).toFixed(0)} KB</span>
                    {p.width && <span>{p.width}×{p.height}</span>}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={(e) => { e.stopPropagation(); handleDownload(p); }} className="p-2 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white"><Download className="w-4 h-4" /></button>
                  <button onClick={(e) => { e.stopPropagation(); handleDelete(p); }} className="p-2 rounded-lg hover:bg-rose-500/20 text-slate-400 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>
                </div>
              </motion.div>
            ))}
          </div>
        )}

        {/* Lightbox */}
        <AnimatePresence>
          {lightboxIdx !== null && filtered[lightboxIdx] && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-6"
              onClick={() => setLightboxIdx(null)}
            >
              <button onClick={() => setLightboxIdx(null)} className="absolute top-4 right-4 p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-white"><X className="w-5 h-5" /></button>
              <button onClick={(e) => { e.stopPropagation(); handleDownload(filtered[lightboxIdx]); }} className="absolute top-4 right-16 p-2 rounded-lg bg-slate-800/80 hover:bg-indigo-500/80 text-white"><Download className="w-5 h-5" /></button>
              <button onClick={(e) => { e.stopPropagation(); handleDelete(filtered[lightboxIdx]); setLightboxIdx(i => i >= filtered.length - 1 ? null : i); }} className="absolute top-4 right-28 p-2 rounded-lg bg-slate-800/80 hover:bg-rose-500/80 text-white"><Trash2 className="w-5 h-5" /></button>
              {lightboxIdx > 0 && (
                <button onClick={(e) => { e.stopPropagation(); setLightboxIdx(i => i - 1); }} className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-slate-800/80 hover:bg-indigo-500/80 text-white"><ChevronLeft className="w-5 h-5" /></button>
              )}
              {lightboxIdx < filtered.length - 1 && (
                <button onClick={(e) => { e.stopPropagation(); setLightboxIdx(i => i + 1); }} className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-slate-800/80 hover:bg-indigo-500/80 text-white"><ChevronRight className="w-5 h-5" /></button>
              )}
              <motion.img
                key={filtered[lightboxIdx].id}
                initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                src={filtered[lightboxIdx].url.startsWith('http') ? filtered[lightboxIdx].url : `${API_BASE}${filtered[lightboxIdx].url}`}
                alt="full"
                className="max-w-full max-h-full object-contain shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              />
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-slate-300 bg-slate-900/80 px-4 py-1.5 rounded-full">
                {filtered[lightboxIdx].cameraName} • {new Date(filtered[lightboxIdx].capturedAt).toLocaleString()} • {lightboxIdx + 1}/{filtered.length}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
