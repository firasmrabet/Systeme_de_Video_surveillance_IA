"""
ai_engine_sv.py
============
Moteur d'IA Sentinel — version "Supervision" Optimisée (100% YOLO)

Cette version a été entièrement réécrite pour garantir :
1. Zéro Lag : Suppression de l'extracteur de posture et du LSTM lourds.
2. Détection de Violence Directe : Utilisation d'un modèle YOLOv8 spécialisé "Fight/Violence".
3. Détection d'Armes avec Double Vérification : Filtre anti faux-positifs via COCO.
4. Tracking Ultra-Rapide : ByteTrack optimisé.
"""

import sys
import os

# LIMITER L'UTILISATION CPU GLOBALE
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"
os.environ["VECLIB_MAXIMUM_THREADS"] = "2"
os.environ["NUMEXPR_NUM_THREADS"] = "2"

import json
import base64
import time
import threading
from collections import deque
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import torch
from ultralytics import YOLO
import supervision as sv

torch.set_num_threads(2)

# ==============================================================================
# CONFIG & PATHS
# ==============================================================================
ROOT_DIR    = Path(__file__).resolve().parent.parent
MODEL_DIR   = ROOT_DIR / "ai_models"
CLIPS_DIR   = ROOT_DIR / "server" / "clips"

CONFIG = {
    "model_person":   str(MODEL_DIR / "yolo11n.pt"),
    "model_violence": str(MODEL_DIR / "yolov8_violence_small.pt"),
    "model_weapon":   str(MODEL_DIR / "weapons_yolov8n_community.pt"),

    "conf_person":   0.50,
    "conf_weapon":   0.70,
    "conf_violence": 0.60,

    "frames_weapon":     6,
    "frames_violence":   4,
    
    "clip_buffer_sec": 10,
    "cooldown_weapon":    120,
    "cooldown_violence":  30,

    "clips_dir": str(CLIPS_DIR),
}

os.makedirs(CONFIG["clips_dir"], exist_ok=True)

# Classes inoffensives (double check armes)
HARMLESS_COCO_CLASSES = {
    39: "bottle", 41: "cup", 43: "fork", 44: "knife_kitchen",  
    45: "spoon", 46: "bowl", 47: "banana", 63: "laptop",
    64: "mouse", 65: "remote", 66: "keyboard", 67: "cell phone",
    73: "book", 74: "clock", 75: "vase", 76: "scissors",
    77: "teddy bear", 78: "hair drier", 79: "toothbrush"
}

# ==============================================================================
# CLASSES UTILITAIRES
# ==============================================================================
class VideoBuffer:
    def __init__(self, fps=8, seconds=10):
        self.buffer = deque(maxlen=int(fps * seconds))
        self.fps = fps

    def add(self, frame: np.ndarray):
        self.buffer.append(frame.copy())

    def save_clip(self, alert_type: str, after_frames=None) -> str:
        after_frames = after_frames or []
        subfolder = os.path.join(CONFIG["clips_dir"], alert_type.upper())
        os.makedirs(subfolder, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{alert_type.upper()}_{timestamp}.mp4"
        filepath = os.path.join(subfolder, filename)
        frames = list(self.buffer) + after_frames
        if not frames:
            return ""
            
        def _encode_clip(frames_to_encode, out_path):
            print(f"[CLIP] Encodage de {len(frames_to_encode)} frames vers {out_path}", file=sys.stderr)
            temp_path = out_path.replace(".mp4", "_tmp.mp4")
            try:
                target_w, target_h = 640, 480
                fourcc = cv2.VideoWriter_fourcc(*'avc1')
                writer = cv2.VideoWriter(temp_path, fourcc, self.fps, (target_w, target_h))
                if not writer.isOpened():
                    print(f"[CLIP] ERREUR: cv2.VideoWriter n'a pas pu s'ouvrir pour {temp_path}", file=sys.stderr)
                for f in frames_to_encode:
                    resized = cv2.resize(f, (target_w, target_h))
                    writer.write(resized)
                writer.release()
                if os.path.exists(temp_path) and os.path.getsize(temp_path) > 0:
                    os.rename(temp_path, out_path)
                    print(f"[CLIP] Sauvegardé : {out_path} ({os.path.getsize(out_path)} bytes)", file=sys.stderr)
                else:
                    print(f"[CLIP] ERREUR: Le fichier temporaire est vide ou n'existe pas !", file=sys.stderr)
            except Exception as e:
                print(f"[CLIP] Erreur sauvegarde: {e}", file=sys.stderr)
                if os.path.exists(temp_path):
                    os.remove(temp_path)

        t = threading.Thread(target=_encode_clip, args=(frames, filepath))
        t.daemon = True
        t.start()
        
        return f"/clips/{alert_type.upper()}/{filename}"

class StrictTemporalFilter:
    def __init__(self):
        self.counters   = {}
        self.last_seen  = {}
        self.last_alert = {}

    def update(self, event: str, detected: bool, threshold: int, cooldown: int) -> bool:
        now = time.time()
        if not detected:
            self.counters[event] = 0
            return False
        if now - self.last_seen.get(event, 0) > 10.0:
            self.counters[event] = 0
        self.counters[event] = self.counters.get(event, 0) + 1
        self.last_seen[event] = now
        if now - self.last_alert.get(event, 0) < cooldown:
            return False
        if self.counters[event] >= threshold:
            self.last_alert[event] = now
            self.counters[event] = 0
            return True
        return False

# ==============================================================================
# MOTEUR PRINCIPAL
# ==============================================================================
class SentinelSupervisionEngine:
    def __init__(self):
        print("[AI] Initialisation du moteur Sentinel V3 (100% YOLO Optimisé)...", file=sys.stderr)
        
        self.yolo_person = YOLO(CONFIG["model_person"])
        
        try:
            self.yolo_violence = YOLO(CONFIG["model_violence"])
        except Exception as e:
            print(f"[AI] Erreur modèle violence: {e}", file=sys.stderr)
            self.yolo_violence = None
            
        try:
            self.yolo_weapon = YOLO(CONFIG["model_weapon"])
        except Exception:
            self.yolo_weapon = None

        self.tracker = sv.ByteTrack(track_activation_threshold=0.25, lost_track_buffer=30, minimum_matching_threshold=0.8, frame_rate=8)
        self.smoother = sv.DetectionsSmoother()

        self.color_palette = sv.ColorPalette.from_hex(["#00E676", "#00B0FF", "#E040FB", "#FF3D00"])
        self.box_annotator = sv.BoxCornerAnnotator(color=self.color_palette, thickness=3, corner_length=20)
        self.label_annotator = sv.LabelAnnotator(color=self.color_palette, text_scale=0.5, text_thickness=1, text_padding=6, text_position=sv.Position.TOP_LEFT)
        
        self.danger_annotator = sv.BoxCornerAnnotator(color=sv.ColorPalette.from_hex(["#FF0000"]), thickness=4, corner_length=30)
        self.danger_label_annotator = sv.LabelAnnotator(color=sv.ColorPalette.from_hex(["#FF0000"]), text_scale=0.6, text_color=sv.Color.WHITE)

        self.temporal = StrictTemporalFilter()
        self.buffers  = {}
        self.frame_id = 0
        
        # Reconnaissance faciale temporairement désactivée pour zéro lag
        self.faces_enabled = False

        print("[AI] ✅ Moteur prêt (V3 Zéro-Lag)", file=sys.stderr)

    def process(self, camera_id: str, frame: np.ndarray, known_faces_data=None) -> dict:
        self.frame_id += 1

        if camera_id not in self.buffers:
            self.buffers[camera_id] = VideoBuffer(fps=8, seconds=CONFIG["clip_buffer_sec"])
        vid_buffer = self.buffers[camera_id]
        
        annotated_frame = frame.copy()
        vid_buffer.add(frame)

        h, w = frame.shape[:2]
        result = {
            "frame_id":   self.frame_id,
            "timestamp":  datetime.now().isoformat(),
            "frame_size": [w, h],
            "persons":    [],
            "weapons":    [],
            "poses":      [], # Laissé vide pour compatibilité React
            "faces":      [],
            "alerts":     [],
        }

        # ── 1. PERSONNES (YOLO + Tracker) ────────
        yolo_res = self.yolo_person(frame, conf=CONFIG["conf_person"], classes=[0], verbose=False, imgsz=320)[0]
        sv_detections = sv.Detections.from_ultralytics(yolo_res)
        sv_detections = self.tracker.update_with_detections(sv_detections)
        sv_detections = self.smoother.update_with_detections(sv_detections)

        persons = []
        labels = []
        for xyxy, mask, confidence, class_id, tracker_id, data in sv_detections:
            if tracker_id is None: continue
            x1, y1, x2, y2 = map(int, xyxy)
            persons.append({"track_id": int(tracker_id), "bbox": [x1, y1, x2, y2], "conf": round(float(confidence), 3)})
            labels.append(f"Person {int(confidence*100)}%")
        
        result["persons"] = persons
        
        annotated_frame = self.box_annotator.annotate(scene=annotated_frame, detections=sv_detections)
        annotated_frame = self.label_annotator.annotate(scene=annotated_frame, detections=sv_detections, labels=labels)

        # ── 2. VIOLENCE (Nouveau modèle YOLO Direct) ────────
        if self.yolo_violence and len(persons) > 0:
            v_det = self.yolo_violence(frame, conf=CONFIG["conf_violence"], verbose=False, imgsz=320)[0]
            violence_sv = sv.Detections.from_ultralytics(v_det)
            
            valid_violence = []
            violence_labels = []
            
            for v_xyxy, v_mask, v_conf, v_cid, _, _ in violence_sv:
                cls_name = self.yolo_violence.names[int(v_cid)].lower()
                # Must contain violence/fight but NOT contain 'non' or 'no'
                if ("violence" in cls_name or "fight" in cls_name) and "non" not in cls_name and "no" not in cls_name:
                    valid_violence.append([v_xyxy, v_mask, v_conf, v_cid, None, None])
                    violence_labels.append(f"VIOLENCE: {v_conf:.0%}")
                    
            if self.temporal.update(f"violence_{camera_id}", len(valid_violence) > 0, CONFIG["frames_violence"], CONFIG["cooldown_violence"]):
                clip = vid_buffer.save_clip("BEHAVIOR_VIOLENCE")
                result["alerts"].append({"type": "behavior_violence", "severity": "critical", "clip_path": clip})
                
            if valid_violence:
                v_boxes = np.array([v[0] for v in valid_violence])
                v_confs = np.array([v[2] for v in valid_violence])
                v_class = np.array([v[3] for v in valid_violence])
                v_sv_det = sv.Detections(xyxy=v_boxes, confidence=v_confs, class_id=v_class)
                annotated_frame = self.danger_annotator.annotate(scene=annotated_frame, detections=v_sv_det)
                annotated_frame = self.danger_label_annotator.annotate(scene=annotated_frame, detections=v_sv_det, labels=violence_labels)

        # ── 3. ARMES (YOLO + Double-Vérification COCO) ────────
        if len(persons) > 0 and self.yolo_weapon:
            w_det = self.yolo_weapon(frame, conf=CONFIG["conf_weapon"], verbose=False, imgsz=320)[0]
            weapons_sv = sv.Detections.from_ultralytics(w_det)
            
            valid_weapons = []
            weapon_labels = []
            for w_xyxy, w_mask, w_conf, w_cid, _, _ in weapons_sv:
                wx1, wy1, wx2, wy2 = map(int, w_xyxy)
                wcx, wcy = (wx1+wx2)/2, (wy1+wy2)/2
                cls_name = self.yolo_weapon.names[int(w_cid)]
                
                near = any(p["bbox"][0]-80 < wcx < p["bbox"][2]+80 and p["bbox"][1]-80 < wcy < p["bbox"][3]+80 for p in persons)
                if not near: continue
                
                # Double vérification COCO
                is_harmless = False
                pad = 20
                crop_x1 = max(0, wx1 - pad)
                crop_y1 = max(0, wy1 - pad)
                crop_x2 = min(w, wx2 + pad)
                crop_y2 = min(h, wy2 + pad)
                crop = frame[crop_y1:crop_y2, crop_x1:crop_x2]
                
                if crop.size > 0:
                    try:
                        coco_res = self.yolo_person(crop, conf=0.30, verbose=False, imgsz=320)[0]
                        for coco_box in coco_res.boxes:
                            coco_cls = int(coco_box.cls[0])
                            coco_conf = float(coco_box.conf[0])
                            if coco_cls in HARMLESS_COCO_CLASSES and coco_conf > 0.25:
                                is_harmless = True
                                break
                    except Exception: pass
                
                if is_harmless: continue
                
                valid_weapons.append([w_xyxy, w_mask, w_conf, w_cid, None, None])
                weapon_labels.append(f"DANGER: {cls_name.upper()}")
                result["weapons"].append({"class": cls_name, "bbox": [wx1, wy1, wx2, wy2], "confidence": round(float(w_conf), 3)})
                    
            if self.temporal.update(f"weapon_{camera_id}", len(valid_weapons) > 0, CONFIG["frames_weapon"], CONFIG["cooldown_weapon"]):
                clip = vid_buffer.save_clip("WEAPON")
                result["alerts"].append({"type": "weapon_detected", "severity": "critical", "clip_path": clip})

            if valid_weapons:
                w_boxes = np.array([w[0] for w in valid_weapons])
                w_confs = np.array([w[2] for w in valid_weapons])
                w_class = np.array([w[3] for w in valid_weapons])
                w_sv_det = sv.Detections(xyxy=w_boxes, confidence=w_confs, class_id=w_class)
                annotated_frame = self.danger_annotator.annotate(scene=annotated_frame, detections=w_sv_det)
                annotated_frame = self.danger_label_annotator.annotate(scene=annotated_frame, detections=w_sv_det, labels=weapon_labels)

        if len(result["alerts"]) > 0:
            cv2.putText(annotated_frame, "ALERTE EN COURS", (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 255), 3)

        temp_dir = os.path.join(ROOT_DIR, "server", "temp")
        os.makedirs(temp_dir, exist_ok=True)
        tmp_path = os.path.join(temp_dir, f"annotated_{camera_id}.tmp.jpg")
        out_path = os.path.join(temp_dir, f"annotated_{camera_id}.jpg")
        
        cv2.imwrite(tmp_path, annotated_frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        os.replace(tmp_path, out_path) # Atomic rename prevents Node.js from reading partial files
        
        result["annotated_frame_path"] = f"temp/annotated_{camera_id}.jpg"

        return result

# ==============================================================================
# BRIDGE — Node.js ↔ Python
# ==============================================================================
_engine = None
_engine_lock = threading.Lock()

def _handle(payload: dict) -> dict:
    global _engine
    cmd = payload.get("cmd")
    if cmd == "init":
        with _engine_lock:
            if _engine is None: _engine = SentinelSupervisionEngine()
        return {"status": "ready"}
    if cmd == "extract_embedding":
        return {"id": payload.get("id"), "result": {"faces": []}}

    req_id = payload.get("id")
    try:
        with _engine_lock:
            if _engine is None: _engine = SentinelSupervisionEngine()
            b64 = payload.get("image", "")
            if "," in b64: b64 = b64.split(",", 1)[1]
            nparr = np.frombuffer(base64.b64decode(b64), np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if frame is None: return {"id": req_id, "error": "decode_failed"}
            cam_id = payload.get("camera_id", "cam_default")
            result = _engine.process(cam_id, frame)
            return {"id": req_id, "result": result}
    except Exception as e:
        import traceback
        return {"id": req_id, "error": str(e), "trace": traceback.format_exc()}

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--init":
        _handle({"cmd": "init"})
        return
    print("[AI] Sentinel V3 (Optimisé Zéro Lag) — prêt", file=sys.stderr)
    for line in sys.stdin:
        if line.startswith("\ufeff"): line = line[1:]
        line = line.strip()
        if not line: continue
        try: payload = json.loads(line)
        except Exception as e:
            print(json.dumps({"error": f"bad_json: {e}"}))
            sys.stdout.flush()
            continue
        out = _handle(payload)
        print(json.dumps(out))
        sys.stdout.flush()

if __name__ == "__main__":
    main()
