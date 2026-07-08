import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import Navbar from '../components/Navbar';
import { motion } from 'framer-motion';
import {
  Settings as SettingsIcon, Bell, Shield, Eye, Smartphone,
  Save, Mail, Send, MessageSquare, Lock, Clock, Gauge, Plus, Trash2
} from 'lucide-react';
import toast from 'react-hot-toast';

export default function Settings() {
  const { api, user, updateProfile } = useAuth();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('notifications');

  const fetchSettings = useCallback(async () => {
    try {
      const response = await api.get('/settings');
      setSettings(response.data);
    } catch (error) {
      if (error.response?.status === 401) return;
    } finally { setLoading(false); }
  }, [api]);

  useEffect(() => { fetchSettings(); }, []);

  const updateSettings = async (category, updates) => {
    try {
      setSaving(true);
      await api.put(`/settings/${category}`, updates);
      setSettings(prev => ({ ...prev, [category]: { ...prev[category], ...updates } }));
      toast.success('Settings updated');
    } catch (error) { toast.error('Failed to update'); }
    finally { setSaving(false); }
  };

  const tabs = [
    { key: 'notifications', label: 'Notifications', icon: Bell },
    { key: 'detection', label: 'AI Detection', icon: Eye },
    { key: 'security', label: 'Security', icon: Shield },
    { key: 'profile', label: 'Profile', icon: SettingsIcon },
  ];

  if (loading) return (
    <div className="min-h-screen bg-[#030712]">
      <Navbar />
      <div className="flex items-center justify-center py-32">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500" />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#030712]">
      <Navbar />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-10">
          <h1 className="text-4xl font-black text-white tracking-tight">
            System <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">Settings</span>
          </h1>
          <p className="text-slate-400 mt-2 text-lg">Configure your security system preferences</p>
        </motion.div>

        <div className="flex flex-col lg:flex-row gap-6">
          <div className="lg:w-64 flex-shrink-0">
            <div className="glass rounded-2xl p-2 space-y-1 border border-slate-800/50">
              {tabs.map(tab => {
                const Icon = tab.icon;
                return (
                  <motion.button
                    key={tab.key}
                    whileHover={{ x: 3 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => setActiveTab(tab.key)}
                    className={`w-full flex items-center px-4 py-3 rounded-xl text-sm font-semibold transition-all ${
                      activeTab === tab.key
                        ? 'bg-gradient-to-r from-indigo-600/20 to-purple-600/20 text-indigo-400 border border-indigo-500/20'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                    }`}
                  >
                    <Icon className="w-5 h-5 mr-3" />
                    {tab.label}
                  </motion.button>
                );
              })}
            </div>
          </div>

          <div className="flex-1">
            {/* Notifications */}
            {activeTab === 'notifications' && (
              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="glass rounded-2xl p-6 border border-slate-800/50">
                <h2 className="text-xl font-bold text-white mb-6 flex items-center"><Bell className="w-5 h-5 mr-2 text-indigo-400" />Notification Preferences</h2>
                <div className="space-y-4">
                  {[
                    { key: 'telegram', label: 'Telegram Alerts', desc: 'Encrypted real-time alerts with photos', icon: Send, color: 'blue' },
                    { key: 'email', label: 'Email Alerts', desc: 'Receive alerts via email with captured photos', icon: Mail, color: 'blue' },
                    { key: 'push', label: 'Push Notifications', desc: 'Real-time browser notifications', icon: Smartphone, color: 'purple' },
                  ].map(item => {
                    const Icon = item.icon;
                    return (
                      <div key={item.key} className="p-4 bg-slate-800/30 rounded-xl border border-slate-700/30 hover:border-slate-600/50 transition-all">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div className={`w-10 h-10 rounded-xl bg-${item.color}-500/10 flex items-center justify-center border border-${item.color}-500/20`}>
                              <Icon className={`w-5 h-5 text-${item.color}-400`} />
                            </div>
                            <div>
                              <p className="text-sm font-bold text-white">{item.label}</p>
                              <p className="text-xs text-slate-400">{item.desc}</p>
                            </div>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={settings?.notifications?.[item.key] || false}
                              onChange={(e) => updateSettings('notifications', { [item.key]: e.target.checked })}
                              className="sr-only peer"
                            />
                            <div className="w-11 h-6 bg-slate-700 peer-focus:ring-2 peer-focus:ring-indigo-500 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600" />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                  
                  {settings?.notifications?.telegram && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="p-4 bg-slate-800/50 rounded-xl border border-blue-500/30">
                      <label className="block text-sm font-semibold text-white mb-2 flex items-center">
                        <Send className="w-4 h-4 mr-2 text-blue-400" />
                        Telegram Chat ID
                      </label>
                      <input
                        type="text"
                        value={settings?.notifications?.telegramChatId || ''}
                        onChange={(e) => updateSettings('notifications', { telegramChatId: e.target.value })}
                        placeholder="e.g. 123456789"
                        className="input-3d w-full mb-2"
                      />
                      <p className="text-xs text-slate-400">
                        To get your Chat ID, start a conversation with your bot <strong>@SentinelAiCamBot</strong>, then forward any message from it to <strong>@userinfobot</strong>.
                      </p>
                    </motion.div>
                  )}

                  <div className="p-4 bg-slate-800/30 rounded-xl border border-slate-700/30">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center border border-amber-500/20">
                          <Clock className="w-5 h-5 text-amber-400" />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-white">Alert Cooldown</p>
                          <p className="text-xs text-slate-400">Minimum time between alerts</p>
                        </div>
                      </div>
                      <span className="text-lg font-black text-amber-400">{settings?.notifications?.cooldownSeconds || 30}s</span>
                    </div>
                    <input type="range" min="5" max="300" value={settings?.notifications?.cooldownSeconds || 30}
                      onChange={(e) => updateSettings('notifications', { cooldownSeconds: parseInt(e.target.value) })}
                      className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500" />
                  </div>
                </div>
              </motion.div>
            )}

            {/* Detection */}
            {activeTab === 'detection' && (
              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="glass rounded-2xl p-6 border border-slate-800/50">
                <h2 className="text-xl font-bold text-white mb-6 flex items-center"><Eye className="w-5 h-5 mr-2 text-indigo-400" />AI Detection Settings</h2>
                <div className="space-y-4">
                  <div className="p-4 bg-slate-800/30 rounded-xl border border-slate-700/30">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20">
                          <Gauge className="w-5 h-5 text-indigo-400" />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-white">Confidence Threshold</p>
                          <p className="text-xs text-slate-400">Minimum confidence to trigger alert</p>
                        </div>
                      </div>
                      <span className="text-lg font-black text-indigo-400">{((settings?.detection?.confidenceThreshold || 0.6) * 100).toFixed(0)}%</span>
                    </div>
                    <input type="range" min="10" max="100" value={(settings?.detection?.confidenceThreshold || 0.6) * 100}
                      onChange={(e) => updateSettings('detection', { confidenceThreshold: parseInt(e.target.value) / 100 })}
                      className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {[
                      { key: 'objectDetection', label: 'Object Detection', icon: '\u{1F3AF}' },
                      { key: 'faceDetection', label: 'Face Detection', icon: '\u{1F464}' },
                      { key: 'motionDetection', label: 'Motion Detection', icon: '\u{1F3C3}' },
                      { key: 'behaviorAnalysis', label: 'Behavior Analysis', icon: '\u{1F9E0}' },
                      { key: 'intrusionDetection', label: 'Intrusion Detection', icon: '\u{1F6A8}' },
                      { key: 'loiteringDetection', label: 'Loitering Detection', icon: '\u23F1\uFE0F' },
                      { key: 'unattendedObject', label: 'Unattended Objects', icon: '\u{1F4E6}' },
                    ].map(feature => (
                      <motion.div key={feature.key} whileHover={{ scale: 1.02 }} className="flex items-center justify-between p-3 bg-slate-800/30 rounded-xl border border-slate-700/30">
                        <div className="flex items-center space-x-3">
                          <span className="text-xl">{feature.icon}</span>
                          <span className="text-sm font-semibold text-white">{feature.label}</span>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={settings?.detection?.[feature.key] || false}
                            onChange={(e) => updateSettings('detection', { [feature.key]: e.target.checked })} className="sr-only peer" />
                          <div className="w-9 h-5 bg-slate-700 peer-focus:ring-2 peer-focus:ring-indigo-500 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600" />
                        </label>
                      </motion.div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {/* Security */}
            {activeTab === 'security' && (
              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="glass rounded-2xl p-6 border border-slate-800/50">
                <h2 className="text-xl font-bold text-white mb-6 flex items-center"><Shield className="w-5 h-5 mr-2 text-indigo-400" />Security Settings</h2>
                <div className="space-y-4">
                  <div className="p-4 bg-slate-800/30 rounded-xl border border-slate-700/30">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center border border-red-500/20">
                          <Lock className="w-5 h-5 text-red-400" />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-white">Two-Factor Authentication</p>
                          <p className="text-xs text-slate-400">Add extra security to your account</p>
                        </div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" checked={settings?.security?.twoFactorEnabled || false}
                          onChange={(e) => updateSettings('security', { twoFactorEnabled: e.target.checked })} className="sr-only peer" />
                        <div className="w-11 h-6 bg-slate-700 peer-focus:ring-2 peer-focus:ring-indigo-500 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600" />
                      </label>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Profile */}
            {activeTab === 'profile' && (
              <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="glass rounded-2xl p-6 border border-slate-800/50">
                <h2 className="text-xl font-bold text-white mb-6 flex items-center"><SettingsIcon className="w-5 h-5 mr-2 text-indigo-400" />Profile Settings</h2>
                <ProfileForm user={user} onSave={updateProfile} />
              </motion.div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function ProfileForm({ user, onSave }) {
  const [formData, setFormData] = useState({ name: user?.name || '' });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const result = await onSave(formData);
    setSaving(false);
    if (result.success) toast.success('Profile updated');
    else toast.error(result.error);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="p-4 bg-slate-800/30 rounded-xl border border-slate-700/30">
        <label className="block text-sm font-semibold text-slate-300 mb-2">Full Name</label>
        <input type="text" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className="input-3d w-full" />
      </div>
      <div className="p-4 bg-slate-800/30 rounded-xl border border-slate-700/30">
        <label className="block text-sm font-semibold text-slate-300 mb-2">Email</label>
        <input type="email" value={user?.email || ''} disabled className="input-3d w-full opacity-60 cursor-not-allowed" />
        <p className="text-xs text-slate-500 mt-1.5">Managed by Google account</p>
      </div>
      <motion.button type="submit" disabled={saving} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
        className="flex items-center px-6 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl font-bold shadow-lg shadow-indigo-500/20 disabled:opacity-50">
        <Save className="w-4 h-4 mr-2" />
        {saving ? 'Saving...' : 'Save Changes'}
      </motion.button>
    </form>
  );
}
