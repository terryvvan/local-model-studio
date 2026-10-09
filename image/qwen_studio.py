#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Qwen Studio - 给 ComfyUI + Qwen-Image-2.1 套一个"一句话出图"的外壳。

默认交互只有两件事：
  1. 打字（描述你要的画面）
  2. 可选地丢一张图进来（那就是"改图"）
其他参数全部折叠在「高级参数」里，不看也不影响出图。

启动: 双击 Qwen Studio.bat，或直接跑本文件。
"""

import ctypes
import hashlib
import io
import json
import math
import mimetypes
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------- 路径常量
APP_DIR = os.path.dirname(os.path.abspath(__file__))
UI_DIR = os.path.join(APP_DIR, "ui")
CACHE_DIR = os.path.join(APP_DIR, "cache")
URL_FILE = os.path.join(APP_DIR, "studio-url.txt")   # 单实例保护用：当前实例地址


# 融合版（local-model）把 Bonsai 与 Qwen Studio 放进同一个项目，ComfyUI 便携版
# 仍在 E 盘；它的位置由 <项目根>/config.json 提供。单独跑这份 qwen_studio.py 时
# 回落到原来的硬编码值，行为与以前完全一致。
def _load_project_config():
    here = os.path.dirname(APP_DIR)          # 项目根（app/ 的上一层）
    for cand in (os.path.join(here, "config.json"),
                 os.path.join(APP_DIR, "config.json")):
        try:
            with open(cand, "r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                return d
        except Exception:
            continue
    return {}


_CFG = _load_project_config()
_IMG_CFG = _CFG.get("image") if isinstance(_CFG.get("image"), dict) else {}

PORTABLE = str(_IMG_CFG.get("portable") or r"E:\ComfyUI_windows_portable")
PY_EXE = os.path.join(PORTABLE, "python_embeded", "python.exe")
COMFY_DIR = os.path.join(PORTABLE, "ComfyUI")
COMFY_OUTPUT = os.path.join(COMFY_DIR, "output")   # ComfyUI 只往这里写图，改不了
SETTINGS_FILE = os.path.join(APP_DIR, "settings.json")

HOST, PORT = "127.0.0.1", 8188
BASE = "http://%s:%d" % (HOST, PORT)


# ------------------------------------------------------- 设置（输出目录可改）
# ComfyUI 的 SaveImage 只会往它自己的 output 目录写，改不了。所以「输出目录」
# 是 studio 这边的事：图一出炉就从 ComfyUI 的 output 搬到这里，用户看到的
# 「打开输出文件夹」和「在文件夹中显示」指的都是它。
def load_settings():
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_settings(d):
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, SETTINGS_FILE)


def set_out_dir(path):
    """改输出目录（内存 + 落盘），返回规范化后的绝对路径。"""
    global OUT_DIR
    p = os.path.abspath(path)
    if not os.path.isdir(p):
        os.makedirs(p, exist_ok=True)
    OUT_DIR = p
    st = load_settings()
    st["output_dir"] = p
    try:
        save_settings(st)
    except Exception as e:
        log("save settings failed:", repr(e))
    log("output dir ->", p)
    return p


OUT_DIR = os.path.abspath(load_settings().get("output_dir") or COMFY_OUTPUT)


# ------------------------------------------------- 系统级负面提示词（一直生效）
# 和「输出目录」一样存在 settings.json 里，重启也还在。它是**全局**的：界面上
# 那个「负面提示词」框是每次生成各自填的，系统级这段自动拼在它前面，用户不用
# 每次重复写。图省事走服务端拼接（而不是前端拼好再发），这样命令行入口
# （draw.bat / qwen.py）也自动带上，不会出现「界面上生效、命令行没生效」。
SYS_NEG = str(load_settings().get("sys_negative") or "")


def compose_negative(user_neg):
    """系统级负面词排在最前面，用户自己写的那段接在后面。"""
    parts = []
    for s in (SYS_NEG, user_neg):
        s = (s or "").strip().strip(",").strip()
        if s:
            parts.append(s)
    return ", ".join(parts)


def api_set_sys_negative(body):
    """存系统级负面词（内存 + 落盘）。空字符串 = 关掉。"""
    global SYS_NEG
    SYS_NEG = str((body or {}).get("sys_negative") or "")[:16000]
    st = load_settings()
    st["sys_negative"] = SYS_NEG
    try:
        save_settings(st)
    except Exception as e:
        log("save settings failed:", repr(e))
        return {"ok": False, "error": "存不下来：%s" % e}
    log("sys negative -> %d chars" % len(SYS_NEG))
    return {"ok": True, "sys_negative": SYS_NEG}

DIFFUSION = "qwen_image_2.1_int8_convrot.safetensors"
ENCODER = "qwen3vl_8b_w4a8.safetensors"
VAE = "qwen_image_2.1_vae_bf16.safetensors"
LORA = "p_qwen_image_2.1_8step_v0.1.safetensors"

# 期望字节数（下载时逐个校验过，体检用它来判断权重有没有被破坏/截断）
DIFFUSION_BYTES = 7256783064
ENCODER_BYTES = 6312105364
VAE_BYTES = 675509688
LORA_BYTES = 335606104

# 权重实际所在的 models 根目录：staging 树 + 便携版自带目录（extra_model_paths.yaml
# 把前者挂进了后者，所以两个位置都要找）
MODEL_ROOTS = [str(_IMG_CFG.get("modelRoot") or r"E:\ComfyUI\ComfyUI\models"),
               os.path.join(COMFY_DIR, "models")]

os.makedirs(CACHE_DIR, exist_ok=True)

LOG_PATH = os.path.join(APP_DIR, "qwen-studio.log")
_log_lock = threading.Lock()

# pythonw 没有控制台，线程里出了没见过的事故（段错误 / 解释器级异常）什么都看不到。
# 把 traceback 落进日志文件，加一个「任务卡住 60 秒就 dump 所有线程栈」的看门狗，
# 下次再卡住就有证据可看。
try:
    import faulthandler
    _FAULT = open(os.path.join(APP_DIR, "qwen-studio-fault.log"), "a",
                  encoding="utf-8", buffering=1)
    faulthandler.enable(file=_FAULT)
except Exception:
    _FAULT = None


def watchdog_dump(tag="watchdog"):
    try:
        log("[%s] dumping all thread stacks" % tag)
        if _FAULT:
            faulthandler.dump_traceback(file=_FAULT, all_threads=True)
    except Exception:
        pass


def watchdog_start(seconds=60):
    """卡住就 dump 线程栈；每次任务开始时重置。"""
    try:
        if _FAULT:
            faulthandler.cancel_dump_traceback_later()
            faulthandler.dump_traceback_later(seconds, file=_FAULT,
                                              exit=False, repeat=True)
    except Exception:
        pass


def log(*parts):
    line = time.strftime("[%H:%M:%S] ") + " ".join(str(p) for p in parts)
    with _log_lock:
        try:
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass
    try:
        print(line, flush=True)
    except Exception:
        pass


# ---------------------------------------------------------------- 小工具
def http_json(path, payload=None, timeout=30):
    url = BASE + path
    if payload is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8")
    return json.loads(body) if body else {}


# ---- 带硬超时的请求：urllib 的 timeout 只管单个 socket 操作，遇到半死不活的
# ---- 连接可以无限期挂住。界面接口一律走这里，绝不把主流程卡死。
_HARD_POOL = ThreadPoolExecutor(max_workers=8)


def http_json_hard(path, payload=None, timeout=6, default=None):
    fut = _HARD_POOL.submit(http_json, path, payload, timeout)
    try:
        return fut.result(timeout=timeout + 1.0)
    except Exception as e:
        log("http_json_hard %s failed: %r" % (path, e))
        return default


# 状态接口要高频调用，绝对不能现问现等 —— 由一个后台线程每 1.5 秒刷一次
# ComfyUI 的队列/显存，/api/status 直接读这份缓存（读不到就当空）。
POLL_CACHE = {"queue_running": 0, "queue_pending": 0, "sys": {},
              "at": 0.0, "ok": False}


def comfy_monitor_loop():
    while True:
        try:
            q = http_json_hard("/queue", timeout=4, default=None)
            if q is not None:
                POLL_CACHE["queue_running"] = len(q.get("queue_running") or [])
                POLL_CACHE["queue_pending"] = len(q.get("queue_pending") or [])
                POLL_CACHE["ok"] = True
            else:
                POLL_CACHE["ok"] = False
            st = http_json_hard("/system_stats", timeout=4, default=None)
            if st:
                d = (st.get("devices") or [{}])[0]
                POLL_CACHE["sys"] = {"vram_total": d.get("vram_total"),
                                     "vram_free": d.get("vram_free")}
            POLL_CACHE["at"] = time.time()
        except Exception:
            pass
        time.sleep(1.5)


def comfy_alive(timeout=3):
    try:
        http_json("/system_stats", timeout=timeout)
        return True
    except Exception:
        return False


def wait_comfy(seconds=180, on_note=None):
    t0 = time.time()
    while time.time() - t0 < seconds:
        if comfy_alive():
            return True
        if on_note:
            on_note(int(time.time() - t0))
        time.sleep(2)
    return False


def free_port(port):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


# ---------------------------------------------------------------- 输出画幅
# 参考图走 TextEncodeQwenImage21 时，画布默认等于「第一张参考图按 resolution 缩放后」
# 的尺寸，所以出图比例被参考图锁死、像素也上不去。这里算出显式的目标画布，交给节点
# 的 width/height 输入（已给 nodes_qwen.py 打过补丁），实现「按原图比例 / 指定面积 /
# 指定比例 / 指定像素 / 扩图」。
CANVAS_MODES = ("follow", "origin", "scale", "area", "ratio", "custom")

RATIO_PRESETS = {
    "1:1": (1, 1), "4:3": (4, 3), "3:4": (3, 4), "3:2": (3, 2), "2:3": (2, 3),
    "16:9": (16, 9), "9:16": (9, 16), "21:9": (21, 9), "9:21": (9, 21),
    "5:4": (5, 4), "4:5": (4, 5),
}


def _round32(v, lo=256, hi=4096):
    """格点 = 32；VAE 是 16 倍下采样，所以 32 的倍数一定落在格点上。"""
    return min(hi, max(lo, int(round(float(v) / 32.0)) * 32))


def parse_ratio(text, dflt=(1, 1)):
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*[:xX*]\s*(\d+(?:\.\d+)?)\s*$", str(text or ""))
    if m:
        try:
            a, b = float(m.group(1)), float(m.group(2))
            if a > 0 and b > 0:
                return a, b
        except Exception:
            pass
    key = str(text or "").strip()
    if key in RATIO_PRESETS:
        a, b = RATIO_PRESETS[key]
        return float(a), float(b)
    return float(dflt[0]), float(dflt[1])


def _fit_box(w, h, ratio, lo=256, hi=4096):
    """按 ratio 取面积约 w*h 的框，再往内缩到 <=512 的宽高比（粗调），交给 _round32 精调。"""
    r = float(ratio) if ratio > 0 else 1.0
    tw, th = math.sqrt(float(w) * float(h) * r), math.sqrt(float(w) * float(h) / r)
    for _ in range(500):
        cw, ch = _round32(tw), _round32(th)
        if cw / float(ch) <= r:
            break
        tw *= 0.999
    return cw, ch


def image_size_from_bytes(blob):
    """零依赖读 PNG/JPEG/WebP 头部拿原始尺寸；认不出来返回 None。"""
    try:
        if blob[:8] == b"\x89PNG\r\n\x1a\n":
            if blob[12:16] == b"IHDR":
                return int.from_bytes(blob[16:20], "big"), int.from_bytes(blob[20:24], "big")
        elif blob[:2] == b"\xff\xd8":
            i, n = 2, len(blob)
            while i + 9 < n:
                if blob[i] != 0xFF:
                    i += 1
                    continue
                mark = blob[i + 1]
                if mark in (0xD8, 0x01) or 0xD0 <= mark <= 0xD7:
                    i += 2
                    continue
                seg = int.from_bytes(blob[i + 2:i + 4], "big")
                if mark in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                            0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    return int.from_bytes(blob[i + 7:i + 9], "big"), int.from_bytes(blob[i + 5:i + 7], "big")
                i += 2 + seg
        elif blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
            ck = blob[12:16]
            if ck == b"VP8X":
                w = int.from_bytes(blob[24:27], "little") + 1
                h = int.from_bytes(blob[27:30], "little") + 1
                return w, h
            if ck == b"VP8L" and blob[20] == 0x2F:
                b = int.from_bytes(blob[21:25], "little")
                return (b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1
            if ck == b"VP8 " and blob[23:26] == b"\x9d\x01\x2a":
                return (int.from_bytes(blob[26:28], "little") & 0x3FFF,
                        int.from_bytes(blob[28:30], "little") & 0x3FFF)
    except Exception:
        pass
    return None


def canvas_size(p, ref_size=None):
    """算出这次请求的目标画布 (w, h)。ref_size = 第一张参考图的原始 (w, h) 或 None。

    返回 None 表示「跟随参考图」（不覆盖节点的默认画布）。
    """
    mode = str(p.get("canvas_mode") or "follow").strip().lower()
    if mode not in CANVAS_MODES:
        mode = "follow"
    if mode == "custom":
        return _round32(p.get("width", 0)), _round32(p.get("height", 0))
    if ref_size is None:
        return None
    rw, rh = float(ref_size[0]), float(ref_size[1])
    if rw <= 0 or rh <= 0:
        return None
    ratio = rw / rh
    if mode == "follow":
        return None
    if mode == "origin":
        return _round32(rw), _round32(rh)
    if mode == "scale":
        k = max(0.1, min(8.0, float(p.get("canvas_scale", 1.0) or 1.0)))
        return _fit_box(rw * k, rh * k, ratio, 256, 4096)
    if mode == "area":
        px = max(256 * 256, min(4096 * 4096, int(p.get("canvas_px", 0) or 0)))
        side = math.sqrt(px)
        return _fit_box(side, side, ratio, 256, 4096)
    if mode == "ratio":
        a, b = parse_ratio(p.get("canvas_ratio", "1:1"))
        r = a / b
        mp = max(0.1, min(16.0, float(p.get("canvas_mp", 1.0) or 1.0)))
        area = mp * 1024.0 * 1024.0
        tw, th = math.sqrt(area * r), math.sqrt(area / r)
        return _fit_box(tw, th, r, 256, 4096)
    return None


def is_admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


# ---------------------------------------------------------------- 工作流构建
def build_workflow(p):
    """p 是前端传来的参数字典。"""
    prompt = (p.get("prompt") or "").strip()
    images = p.get("images") or []
    steps = int(p.get("steps", 25))
    cfg = float(p.get("cfg", 1.0))
    seed = p.get("seed")
    if seed in (None, "", "random"):
        seed = random.randint(0, 2 ** 31 - 1)
    seed = int(seed)
    width = int(p.get("width", 1024))
    height = int(p.get("height", 1024))
    canvas = p.get("canvas") or None
    batch = max(1, min(16, int(p.get("batch_size", 1))))
    use_lora = bool(p.get("use_lora", False))
    prefix = (p.get("prefix") or "qwen_out").strip() or "qwen_out"

    g = {}
    g["1"] = {"class_type": "UNETLoader",
              "inputs": {"unet_name": p.get("unet_name") or DIFFUSION,
                         "weight_dtype": p.get("weight_dtype", "default")}}

    if use_lora:
        g["2"] = {"class_type": "LoraLoaderModelOnly",
                  "inputs": {"model": ["1", 0],
                             "lora_name": p.get("lora_name") or LORA,
                             "strength_model": float(p.get("lora_strength", 1.0))}}
        model_src = ["2", 0]
    else:
        model_src = ["1", 0]

    g["3"] = {"class_type": "CLIPLoader",
              "inputs": {"clip_name": p.get("clip_name") or ENCODER,
                         "type": p.get("clip_type", "qwen_image"),
                         "device": p.get("clip_device", "default")}}
    g["4"] = {"class_type": "VAELoader",
              "inputs": {"vae_name": p.get("vae_name") or VAE}}
    g["5"] = {"class_type": "QwenImage21Cache",
              "inputs": {"model": model_src,
                         "device": p.get("cache_device", "auto"),
                         "dtype": p.get("cache_dtype", "default")}}

    te = {"clip": ["3", 0], "vae": ["4", 0], "prompt": prompt,
          "negative_prompt": compose_negative(p.get("negative")),
          "resolution": int(p.get("resolution", 1024))}

    if images:
        # 参考图必须走「点号键」形式：images.image_1。
        # 0.37 的 V3 输入转换只重建 images.*** 下的 autogrow 输入，嵌套的
        # {"images": {"image_1": ...}} 会被静默丢掉，参考图就完全不生效。
        for i, name in enumerate(images[:16], start=1):
            nid = "img%d" % i
            g[nid] = {"class_type": "LoadImage", "inputs": {"image": name}}
            te["images.image_%d" % i] = [nid, 0]
        # 显式画布（nodes_qwen.py 补丁新增的 width/height）：不传就跟随参考图。
        if canvas:
            te["width"], te["height"] = int(canvas[0]), int(canvas[1])
        g["7"] = {"class_type": "TextEncodeQwenImage21", "inputs": te}
        latent_src = ["7", 2]
    else:
        g["7"] = {"class_type": "TextEncodeQwenImage21", "inputs": te}
        g["8"] = {"class_type": "EmptyLatentImage",
                  "inputs": {"width": width, "height": height,
                             "batch_size": batch}}
        latent_src = ["8", 0]

    g["9"] = {"class_type": "KSampler",
              "inputs": {"model": ["5", 0], "positive": ["7", 0],
                         "negative": ["7", 1], "latent_image": latent_src,
                         "seed": seed, "steps": steps, "cfg": cfg,
                         "sampler_name": p.get("sampler_name", "euler"),
                         "scheduler": p.get("scheduler", "simple"),
                         "denoise": float(p.get("denoise", 1.0))}}
    g["10"] = {"class_type": "VAEDecode",
               "inputs": {"samples": ["9", 0], "vae": ["4", 0]}}
    g["11"] = {"class_type": "SaveImage",
               "inputs": {"images": ["10", 0], "filename_prefix": prefix}}
    return g, seed


def build_workflows(p):
    """把一次请求展开成 1..N 张工作流，用来「抽卡」。

    - 文生图：一个批次就够。EmptyLatentImage 的 batch_size=N，ComfyUI 会自动
      用 seed, seed+1, ... seed+N-1 出 N 张不同的图（同一句提示词，细微差别）。
    - 改图（带参考图）：latent 直接来自参考图，batch 出的是重复结果，所以拆成
      N 个单张任务、每张换一个种子，串行排队。
    """
    n = max(1, min(16, int(p.get("batch_size", 1))))
    has_ref = bool(p.get("images"))
    if (not has_ref) or n == 1:
        g, seed = build_workflow(dict(p, batch_size=n))
        return [(g, seed)]
    seed = p.get("seed")
    if seed in (None, "", "random"):
        seed = random.randint(0, 2 ** 31 - 1)
    seed = int(seed)
    out = []
    for i in range(n):
        g, s = build_workflow(dict(p, batch_size=1, seed=(seed + i) % (2 ** 31)))
        out.append((g, s))
    return out


# ---------------------------------------------------------------- 上传参考图
def upload_reference(local_bytes, filename):
    """上传参考图。

    文件名统一改成 <内容的 sha1 前 10 位>.<扩展名>：一是避开中文/空格文件名在
    LoadImage 里的编码问题，二是同名不同内容的图不会命中 ComfyUI 的缓存。
    """
    ext = os.path.splitext(os.path.basename(filename or ""))[1].lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"):
        ext = ".png"
    name = hashlib.sha1(local_bytes).hexdigest()[:10] + ext
    boundary = "----qs" + uuid.uuid4().hex
    body = b""
    body += ("--%s\r\n" % boundary).encode()
    body += ('Content-Disposition: form-data; name="image"; filename="%s"\r\n'
             % name).encode("utf-8")
    body += b"Content-Type: application/octet-stream\r\n\r\n"
    body += local_bytes
    body += ("\r\n--%s\r\n" % boundary).encode()
    body += b'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue'
    body += ("\r\n--%s--\r\n" % boundary).encode()

    req = urllib.request.Request(
        BASE + "/upload/image", data=body,
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=300) as r:
        res = json.loads(r.read().decode("utf-8"))
    sub = res.get("subfolder") or ""
    return (sub.replace("\\", "/") + "/" + res["name"]) if sub else res["name"]


# ---------------------------------------------------------------- 任务状态
class Job(object):
    def __init__(self):
        # 必须是可重入锁：同一段代码里会出现「先 with JOB.lock 再调 snapshot()」
        # 的写法，用普通 Lock 会自己把自己锁死（表现为 /api/status 永久卡住、
        # 生成完了却永远不写历史）。
        self.lock = threading.RLock()
        self.state = "idle"     # idle | running | done | error
        self.prompt_id = None
        self.gen = 0            # 第几次生成（每次点生成 +1，前端据此分批显示）
        self.started = None
        self.elapsed = 0.0
        self.node = None
        self.step = 0
        self.total_steps = 0
        self.images = []        # [{file, url, w, h, size}]
        self.error = None
        self.seed = None
        self.params = {}
        self.job_index = 0      # 本次请求里的第几张（抽卡时 1..N）
        self.job_total = 1

    def snapshot(self):
        with self.lock:
            d = self.__dict__.copy()
            d.pop("lock", None)
            return d


JOB = Job()


def comfy_queue_pos():
    try:
        q = http_json("/queue", timeout=5)
        return len(q.get("queue_running") or []), len(q.get("queue_pending") or [])
    except Exception:
        return 0, 0


def comfy_progress():
    """从 /prompt 的实时事件里拿进度是不可行的（那是 websocket），
    改用 /queue 里 running 项自带的节点信息 + 日志时间估算。"""
    try:
        q = http_json("/queue", timeout=5)
    except Exception:
        return None
    running = q.get("queue_running") or []
    if not running:
        return None
    item = running[0]
    info = {"node": None, "steps": None}
    try:
        extra = item[3] if len(item) > 3 else {}
        info["node"] = extra.get("extra_info", {}).get("node_id")
    except Exception:
        pass
    return info


def relocate_output(src, name):
    """把 ComfyUI 刚写出来的图搬到用户指定的输出目录。

    ComfyUI 的 SaveImage 节点路径是写死的，只能落到它自己的 output 里；搬过来
    是唯一不动 ComfyUI 就能改输出位置的办法。同盘 move 是瞬时的改名，跨盘
    shutil.move 会自己退化成拷贝+删除。搬失败就留在原处（图不能丢），
    历史记录里存的是绝对路径，所以两种位置都能显示。
    """
    out = os.path.abspath(OUT_DIR)
    if os.path.dirname(os.path.abspath(src)).lower() == out.lower():
        return src
    base, ext = os.path.splitext(name)
    dst = os.path.join(out, name)
    n = 1
    while os.path.exists(dst):
        dst = os.path.join(out, "%s_%d%s" % (base, n, ext))
        n += 1
    try:
        os.makedirs(out, exist_ok=True)
        shutil.move(src, dst)
        return dst
    except Exception as e:
        log("move to output dir failed, kept in comfy output:", repr(e))
        return src


def copy_outputs(hist_entry):
    """把 ComfyUI output 目录里的图拷进 cache，返回前端可用的 url 列表。

    同一批里内容完全相同的图只留一张：save 节点被复制过、或 batch 遇上
    完全相同的种子时会出现字节级重复，前端没必要显示两遍。
    """
    out = []
    seen = set()
    for node_id, node_out in (hist_entry.get("outputs") or {}).items():
        for img in (node_out.get("images") or []):
            src = os.path.join(COMFY_OUTPUT, img.get("subfolder") or "",
                               img["filename"])
            if not os.path.isfile(src):
                continue
            src = relocate_output(src, img["filename"])
            try:
                with open(src, "rb") as f:
                    digest = hashlib.sha1(f.read()).hexdigest()
            except Exception as e:
                log("hash failed", src, e)
                digest = src
            if digest in seen:
                log("skip duplicate output", img["filename"])
                continue
            seen.add(digest)
            dst_name = "%s_%s" % (uuid.uuid4().hex[:8], img["filename"])
            dst = os.path.join(CACHE_DIR, dst_name)
            try:
                shutil.copy2(src, dst)
            except Exception as e:
                log("copy failed", src, e)
                continue
            w = h = 0
            try:
                from PIL import Image
                with Image.open(dst) as im:
                    w, h = im.size
            except Exception:
                pass
            out.append({"file": src, "name": img["filename"],
                        "url": "/img/" + urllib.parse.quote(dst_name),
                        "rel": os.path.relpath(src, OUT_DIR).replace("\\", "/"),
                        "cache": dst_name,   # cache 里的副本：output 被清掉时还能显示历史
                        "w": w, "h": h,
                        "size": os.path.getsize(dst)})
    return out


# ---------------------------------------------------------------- 历史记录
# 结果只放在服务端内存里的话，一刷新页面就没了（而且同一批结果只下发一次，
# 被另一个窗口抢先看到后，当前窗口就永远看不到了）。所以每批结果都落一份
# 到磁盘，页面启动时先读回来，图走 /output/ 直接从输出目录读原图。
HISTORY_FILE = os.path.join(APP_DIR, "history.json")
HISTORY_MAX = 120         # 最多记住多少批

# 历史里要留哪些参数：够把一批结果「原样回填到界面上再改」就行。
# prompt / negative 单独存（前端要直接回显），参考图另外存一份副本。
HIST_PARAM_KEYS = ("steps", "cfg", "denoise", "sampler_name", "scheduler",
                   "resolution", "canvas_mode", "canvas_scale", "canvas_px",
                   "canvas_ratio", "canvas_mp", "width", "height",
                   "use_lora", "lora_name", "lora_strength", "batch_size",
                   "prefix")


def load_history():
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def store_reference(blob, filename):
    """把参考图在应用自己的 cache 里留一份。

    参考图以前只存在 ComfyUI 的 input 目录里，历史记录里只留下一个哈希文件名，
    用户在历史里既看不到「这张图是拿什么改的」，也没法「以这张图为参考再改一次」。
    存一份副本之后，前端可以直接用 /img/<name> 显示它，也能把它当新参考图再送。
    """
    try:
        digest = hashlib.sha1(blob).hexdigest()[:10]
        ext = os.path.splitext(filename or "")[1].lower()
        if ext not in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"):
            ext = ".png"
        name = "%s_ref%s" % (digest, ext)
        dst = os.path.join(CACHE_DIR, name)
        if not os.path.isfile(dst):
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(dst, "wb") as f:
                f.write(blob)
        wh = image_size_from_bytes(blob) or (0, 0)
        return {"name": filename or name, "cache": name,
                "url": "/img/" + urllib.parse.quote(name),
                "w": wh[0], "h": wh[1], "size": len(blob)}
    except Exception as e:
        log("store reference failed:", repr(e))
        return None


def save_history_entry(snap, images, params=None, refs=None, seeds=None):
    if not images:
        return
    p = params or {}
    keep = {}
    for k in HIST_PARAM_KEYS:
        if p.get(k) is not None:
            keep[k] = p[k]
    if p.get("canvas"):
        keep["canvas"] = list(p["canvas"])
    rec = {
        "gen": snap.get("gen"),
        "seed": snap.get("seed"),
        "steps": snap.get("total_steps"),
        "elapsed": snap.get("elapsed"),
        "at": time.time(),
        # 下面这几项是「历史里能看提示词 / 能一键拿去再改」的根据
        "prompt": p.get("prompt") or "",
        "negative": p.get("negative") or "",
        "params": keep,
        "seeds": list(seeds or []),
        "refs": [r for r in (refs or []) if r],
        "images": [{"name": i.get("name"), "rel": i.get("rel"),
                    "cache": i.get("cache"),
                    "w": i.get("w"), "h": i.get("h"), "size": i.get("size"),
                    "file": i.get("file")} for i in images],
    }
    hist = [h for h in load_history() if h.get("gen") != rec["gen"]]
    hist.append(rec)
    hist = hist[-HISTORY_MAX:]
    try:
        tmp = HISTORY_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(hist, f, ensure_ascii=False)
        os.replace(tmp, HISTORY_FILE)
    except Exception as e:
        log("history save failed:", repr(e))


def cache_lookup(name):
    """在 cache 里找某个输出文件的副本（文件名形如 <uuid8>_<原名>）。"""
    if not name:
        return None
    try:
        for fn in os.listdir(CACHE_DIR):
            if fn.endswith("_" + name) or fn == name:
                p = os.path.join(CACHE_DIR, fn)
                if os.path.isfile(p):
                    return fn
    except OSError:
        pass
    return None


def restore_missing_outputs():
    """把输出目录里丢了、但 cache 里还留着的图放回去。

    用户按「打开输出文件夹」看到的就是输出目录，历史里明明有、文件夹里却
    空着会让人以为图没生成。启动时对一遍，缺的就从 cache 副本拷回来。
    """
    fixed = 0
    for h in load_history():
        for i in h.get("images") or []:
            rel = i.get("rel") or ""
            dst = i.get("file") or ""
            if not dst and rel:
                dst = os.path.join(OUT_DIR, rel.replace("/", os.sep))
            if not dst:
                continue
            if os.path.isfile(dst):
                continue
            name = i.get("cache") or cache_lookup(i.get("name"))
            if not name:
                continue
            src = os.path.join(CACHE_DIR, name)
            if not os.path.isfile(src):
                continue
            try:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                fixed += 1
            except Exception as e:
                log("restore output failed", rel, e)
    if fixed:
        log("输出目录里缺了 %d 张图，已从 cache 副本放回" % fixed)
    return fixed


def api_history():
    """返回历史批次（含可直接访问的图片地址、提示词、参考图）。

    输出目录里的原图被人清掉以后（用户手动删、或清理脚本删），历史不能跟着
    一起消失：每张图在 cache 里都留着一份副本，原图没了就退回用副本显示。
    老的历史记录里没写 cache 字段，就按文件名去 cache 里找一遍。

    连副本都没了的批次也照样下发（missing=true），前端会显示一条「图片已被
    删除」的记录 —— 以前这里是整批丢掉，于是界面看起来像「历史全没了」，
    其实提示词和参数还在。
    """
    out = []
    for h in load_history():
        imgs = []
        for i in h.get("images") or []:
            rel = i.get("rel") or ""
            name = i.get("cache") or cache_lookup(i.get("name"))
            entry = None
            if rel or i.get("file"):
                # 图可能躺在 ComfyUI 的 output 里，也可能被搬到用户指定的输出
                # 目录（甚至搬去之后用户又改了目录）。绝对路径 file 最可信，
                # 没有才按 rel 去两个目录里找。/abs 是专门发这类图的通道。
                cand = []
                if i.get("file"):
                    cand.append(i["file"])
                for d in (OUT_DIR, COMFY_OUTPUT):
                    cand.append(os.path.join(d, rel.replace("/", os.sep)))
                for p in cand:
                    if os.path.isfile(p):
                        entry = {"name": i.get("name"), "file": p,
                                 "url": "/abs?" + urllib.parse.urlencode({"p": p}),
                                 "w": i.get("w"), "h": i.get("h"),
                                 "size": os.path.getsize(p), "cached": False}
                        break
            if entry is None and name and os.path.isfile(os.path.join(CACHE_DIR, name)):
                entry = {"name": i.get("name") or name,
                         "file": os.path.join(CACHE_DIR, name),
                         "url": "/img/" + urllib.parse.quote(name),
                         "w": i.get("w"), "h": i.get("h"),
                         "size": os.path.getsize(os.path.join(CACHE_DIR, name)),
                         "cached": True}
            if entry is None:
                continue
            imgs.append(entry)
        refs = []
        for r in h.get("refs") or []:
            name = r.get("cache") or ""
            if name and os.path.isfile(os.path.join(CACHE_DIR, name)):
                refs.append({"name": r.get("name"), "cache": name,
                             "url": "/img/" + urllib.parse.quote(name),
                             "w": r.get("w"), "h": r.get("h"),
                             "size": r.get("size"), "cached": True})
        out.append({"gen": h.get("gen"), "seed": h.get("seed"),
                    "steps": h.get("steps"), "elapsed": h.get("elapsed"),
                    "at": h.get("at"), "loaded": True,
                    "prompt": h.get("prompt") or "",
                    "negative": h.get("negative") or "",
                    "params": h.get("params") or {},
                    "seeds": h.get("seeds") or [],
                    "refs": refs,
                    "missing": not imgs and not refs,
                    "images": imgs})
    return {"ok": True, "batches": out}


def write_history(hist):
    """把历史整份写回去（先写 .tmp 再 replace，断电也不会留下半截文件）。"""
    try:
        tmp = HISTORY_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(list(hist), f, ensure_ascii=False)
        os.replace(tmp, HISTORY_FILE)
        return True
    except Exception as e:
        log("history write failed:", repr(e))
        return False


def _inside(path, root):
    try:
        return os.path.commonpath([os.path.realpath(path),
                                   os.path.realpath(root)]) == os.path.realpath(root)
    except Exception:
        return False


def output_dirs():
    """允许读/删/定位图片的目录白名单。

    除了当前的输出目录和 ComfyUI 自己的 output，还要认历史记录里出现过的
    目录：用户改过输出位置以后，老图还躺在老地方，不该因此打不开。
    """
    dirs = [os.path.abspath(OUT_DIR), os.path.abspath(COMFY_OUTPUT)]
    try:
        for h in load_history():
            for i in h.get("images") or []:
                f = i.get("file") or ""
                if f:
                    dirs.append(os.path.abspath(os.path.dirname(f)))
    except Exception:
        pass
    return dirs


def resolve_output_file(path):
    """把一个绝对路径解析成白名单内的真实图片文件，否则返回 None。"""
    if not path:
        return None
    try:
        p = os.path.abspath(path)
    except Exception:
        return None
    if not os.path.isfile(p):
        return None
    for d in output_dirs():
        if _inside(p, d):
            return p
    log("refuse to serve outside output dirs:", p)
    return None


def drop_file(path):
    """删除一个我们自己管的文件。

    只允许删输出目录和 cache 目录里的东西 —— 历史记录里的 file 字段是从
    ComfyUI 那边抄过来的绝对路径，万一被人改过，这里也绝不能跟着删别处。
    """
    if not path:
        return 0
    if not (_inside(path, OUT_DIR) or _inside(path, COMFY_OUTPUT)
            or _inside(path, CACHE_DIR)):
        log("refuse to delete outside our dirs:", path)
        return 0
    try:
        if os.path.isfile(path):
            os.remove(path)
            return 1
    except OSError as e:
        log("delete failed:", path, repr(e))
    return 0


def refs_in_use(hist, excluding=None):
    """还有哪些参考图副本被别人用着（同一张参考图被多次生成共用一份副本）。"""
    keep = set()
    for h in hist:
        if excluding is not None and h is excluding:
            continue
        for r in h.get("refs") or []:
            if r.get("cache"):
                keep.add(r["cache"])
    return keep


def record_files(h, keep_refs, only_name=None):
    """一条历史记录牵涉到的文件：输出原图 + cache 副本 + 只归它的参考图副本。"""
    out = []
    imgs = h.get("images") or []
    for i in imgs:
        if only_name is not None and (i.get("name") or "") != only_name:
            continue
        rel = i.get("rel") or ""
        if i.get("file"):
            out.append(i["file"])
        elif rel:
            out.append(os.path.join(OUT_DIR, rel.replace("/", os.sep)))
        nm = i.get("cache") or cache_lookup(i.get("name"))
        if nm:
            out.append(os.path.join(CACHE_DIR, nm))
    # 只删掉这张图时，参考图副本要留着给同一批剩下的图用
    drop_refs = only_name is None or not [i for i in imgs
                                          if (i.get("name") or "") != only_name]
    if drop_refs:
        for r in h.get("refs") or []:
            nm = r.get("cache") or ""
            if nm and nm not in keep_refs:
                out.append(os.path.join(CACHE_DIR, nm))
    return out


def api_history_delete(body):
    """删掉一条历史记录，或者只删其中一张图。files=true 时连文件一起删。

    默认只删记录、不动文件 —— 用户投诉过「图自己没了」，所以删文件必须是他
    明确勾选的动作，而不是删除记录的副作用。
    """
    hist = load_history()
    gen = body.get("gen")
    name = body.get("name") or None
    with_files = bool(body.get("files"))
    target = None
    for h in hist:
        if h.get("gen") == gen:
            target = h
            break
    if target is None:
        return {"ok": False, "error": "历史里没有第 %s 次" % gen}

    deleted = 0
    if name:
        imgs = target.get("images") or []
        if not any((i.get("name") or "") == name for i in imgs):
            return {"ok": False, "error": "第 %s 次里没有 %s" % (gen, name)}
        if with_files:
            for p in record_files(target, refs_in_use(hist, target), only_name=name):
                deleted += drop_file(p)
        keep = [i for i in imgs if (i.get("name") or "") != name]
        target["images"] = keep
        if not keep:
            hist = [h for h in hist if h is not target]
    else:
        if with_files:
            for p in record_files(target, refs_in_use(hist, target)):
                deleted += drop_file(p)
        hist = [h for h in hist if h is not target]

    write_history(hist)
    log("history delete gen=%s name=%s files=%s removed_files=%d"
        % (gen, name, with_files, deleted))
    return {"ok": True, "removed": 1, "files": deleted, "left": len(hist)}


def api_history_clear(body):
    """清空历史。files=true 时连所有图片/参考图副本一起删。"""
    hist = load_history()
    with_files = bool(body.get("files"))
    deleted = 0
    if with_files:
        empty = set()
        for h in hist:
            for p in record_files(h, empty):
                deleted += drop_file(p)
    write_history([])
    log("history clear batches=%d files=%s removed_files=%d"
        % (len(hist), with_files, deleted))
    return {"ok": True, "removed": len(hist), "files": deleted, "left": 0}


def run_job(params, uploaded):
    """后台线程：提交 -> 轮询 -> 收集结果。"""
    watchdog_start(60)
    with JOB.lock:
        JOB.state = "running"
        JOB.error = None
        JOB.images = []
        JOB.started = time.time()
        JOB.node = None
        JOB.params = params
        JOB.seed = None
        JOB.gen += 1        # 本次生成的批次号，前端用它把结果分成一坨一坨
        gen = JOB.gen

    try:
        refs = []
        ref_recs = []          # 参考图的本地副本（历史里要能重新看到它）
        ref_size = None
        for blob, fn in uploaded:
            refs.append(upload_reference(blob, fn))
            rec = store_reference(blob, fn)
            if rec:
                ref_recs.append(rec)
            if ref_size is None:
                ref_size = image_size_from_bytes(blob)

        # 输出画幅：参考图锁死比例时靠这里给出显式目标画布（扩图 / 指定比例 / 指定像素）
        if refs:
            if ref_size is None:
                try:
                    fw, fh = int(params.get("ref_w") or 0), int(params.get("ref_h") or 0)
                    if fw > 0 and fh > 0:
                        ref_size = (fw, fh)
                except Exception:
                    ref_size = None
            canvas = canvas_size(params, ref_size)
            if canvas:
                log("canvas", "%dx%d" % canvas, "mode=%s" % params.get("canvas_mode"),
                    "ref=%s" % (("%dx%d" % ref_size) if ref_size else "?"))
                params = dict(params, canvas=canvas)
        else:
            canvas = None

        # 一次请求可能展开成多张（改图抽卡时会拆成 N 个单张任务）
        jobs = build_workflows(dict(params, images=refs))
        total_jobs = len(jobs)
        all_imgs = []
        seeds = []
        with JOB.lock:
            JOB.seed = jobs[0][1]
            JOB.total_steps = int(params.get("steps", 25))
            JOB.job_index = 0
            JOB.job_total = total_jobs

        for idx, (graph, seed) in enumerate(jobs, start=1):
            seeds.append(seed)
            with JOB.lock:
                JOB.job_index = idx
                JOB.seed = seed
            res = http_json("/prompt", {"prompt": graph})
            errs = res.get("node_errors") or {}
            if errs:
                raise RuntimeError("服务器拒绝了工作流: " + json.dumps(errs,
                                                                    ensure_ascii=False))
            pid = res["prompt_id"]
            with JOB.lock:
                JOB.prompt_id = pid
            log("submitted", pid, "seed=%s" % seed,
                "steps=%s" % params.get("steps"), "gen=%d" % gen,
                "(%d/%d)" % (idx, total_jobs))

            while True:
                with JOB.lock:
                    JOB.elapsed = time.time() - JOB.started
                try:
                    hist = http_json("/history/" + pid, timeout=10)
                except Exception:
                    hist = {}

                if pid in hist:
                    entry = hist[pid]
                    st = entry.get("status", {})
                    if st.get("status_str") == "error":
                        msgs = []
                        for m in st.get("messages") or []:
                            msgs.append(json.dumps(m, ensure_ascii=False))
                        raise RuntimeError("执行出错:\n" + "\n".join(msgs)[:2000])
                    if st.get("completed"):
                        all_imgs.extend(copy_outputs(entry))
                        break

                info = comfy_progress()
                if info and info.get("node"):
                    with JOB.lock:
                        JOB.node = str(info["node"])
                time.sleep(1.0)

        seen = set()
        imgs = []
        for im in all_imgs:                 # 多个任务之间也可能撞出同一张
            key = im.get("name")
            if key in seen:
                continue
            seen.add(key)
            imgs.append(im)
        log("collected gen=%d %d image(s)" % (gen, len(imgs)))
        # 先把结果挂上去（锁里只做赋值，别在锁里做文件 IO：万一目录被占住，
        # 状态接口就会跟着卡死）
        with JOB.lock:
            JOB.images = imgs
            JOB.state = "done"
            JOB.elapsed = time.time() - JOB.started
            snap_done = JOB.snapshot()
        log("state=done gen=%d" % gen)
        try:
            save_history_entry(snap_done, imgs, params, ref_recs, seeds)
            log("history saved gen=%d" % gen)
        except Exception as e:
            log("history save failed: %r" % (e,))
        log("done", "gen=%d" % gen, "%.1fs" % JOB.elapsed,
            "%d image(s)" % len(imgs))

    except Exception as e:
        log("ERROR", repr(e))
        log(traceback.format_exc()[-2000:])
        with JOB.lock:
            JOB.state = "error"
            JOB.error = str(e)
            JOB.elapsed = time.time() - (JOB.started or time.time())


# ---------------------------------------------------------------- HTTP 服务
class Handler(BaseHTTPRequestHandler):
    server_version = "QwenStudio"

    def log_message(self, fmt, *args):
        pass  # 静音

    # -------- helpers
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _read_json(self):
        raw = self._read_body()
        return json.loads(raw.decode("utf-8")) if raw else {}

    # -------- GET
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path in ("/", "/index.html"):
                return self._serve_file(os.path.join(UI_DIR, "index.html"))
            if path == "/favicon.ico":
                return self._send(204, b"", "image/x-icon")
            if path.startswith("/img/"):
                name = urllib.parse.unquote(path[5:])
                if "/" in name or "\\" in name or ".." in name:
                    return self._send(400, "bad name", "text/plain")
                return self._serve_file(os.path.join(CACHE_DIR, name))
            if path.startswith("/output/"):
                rel = urllib.parse.unquote(path[8:])
                target = os.path.abspath(os.path.join(COMFY_OUTPUT, rel.replace("/", os.sep)))
                root = os.path.abspath(COMFY_OUTPUT)
                if not target.startswith(root + os.sep):
                    return self._send(400, "bad path", "text/plain")
                return self._serve_file(target)
            if path == "/abs":
                # 按绝对路径发图：输出目录可以被用户改来改去，历史里的图可能
                # 散在好几个目录里，只有绝对路径是一直可靠的。
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                target = resolve_output_file((q.get("p") or [""])[0])
                if not target:
                    return self._send(404, "not found", "text/plain")
                return self._serve_file(target)
            if path == "/api/bootstrap":
                return self._json(api_bootstrap())
            if path == "/api/history":
                return self._json(api_history())
            if path == "/api/status":
                return self._json(api_status())
            if path == "/api/health":
                return self._json(api_health())
            if path == "/api/selftest":
                return self._json(api_selftest())
            if path == "/api/job":
                snap = JOB.snapshot()
                snap.pop("params", None)
                return self._json(snap)
            return self._send(404, "not found", "text/plain")
        except BrokenPipeError:
            pass
        except Exception as e:
            log("GET", path, "failed:", repr(e))
            try:
                self._json({"ok": False, "error": str(e)}, 500)
            except Exception:
                pass

    # -------- POST
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            raw = self._read_body()
            if path == "/api/generate":
                body = json.loads(raw.decode("utf-8")) if raw else {}
                return self._json(api_generate(body))
            if path == "/api/cancel":
                try:
                    http_json("/interrupt", {})
                except Exception as e:
                    log("interrupt failed:", repr(e))
                with JOB.lock:
                    if JOB.state == "running":
                        JOB.state = "error"
                        JOB.error = "已取消"
                return self._json({"ok": True})
            if path == "/api/quit":
                def _bye():
                    time.sleep(0.15)
                    try:
                        self.server.shutdown()
                    except Exception:
                        pass
                    STOP.set()
                threading.Thread(target=_bye, daemon=True).start()
                return self._json({"ok": True})
            if path == "/api/open-path":
                body = json.loads(raw.decode("utf-8")) if raw else {}
                return self._json(api_open_path(body.get("file") or "",
                                                body.get("kind") or "select"))
            if path == "/api/history/delete":
                body = json.loads(raw.decode("utf-8")) if raw else {}
                return self._json(api_history_delete(body))
            if path == "/api/history/clear":
                body = json.loads(raw.decode("utf-8")) if raw else {}
                return self._json(api_history_clear(body))
            if path == "/api/pick-output-dir":
                body = json.loads(raw.decode("utf-8")) if raw else {}
                return self._json(api_pick_output_dir(body))
            if path == "/api/sys-negative":
                body = json.loads(raw.decode("utf-8")) if raw else {}
                return self._json(api_set_sys_negative(body))
            if path == "/api/client-log":
                # 浏览器那边报上来的错误：页面里出了问题只会在控制台里，用户看不到，
                # 写进同一个日志文件才查得动（前端 window.onerror / 未处理的 Promise）
                body = json.loads(raw.decode("utf-8")) if raw else {}
                log("[client] %s" % (body.get("msg") or "")[:600])
                return self._json({"ok": True})
            if path == "/api/check-updates":
                return self._json(api_check_updates())
            if path == "/api/start-env":
                with ENV_LOCK:
                    busy = ENV_STATE["state"] == "starting"
                if busy:
                    return self._json({"ok": True, "already": True})
                ENV_STATE["started"] = time.time()
                threading.Thread(target=start_env_worker, daemon=True).start()
                return self._json({"ok": True})
            return self._send(404, "not found", "text/plain")
        except BrokenPipeError:
            pass
        except Exception as e:
            log("POST", path, "failed:", repr(e))
            try:
                self._json({"ok": False, "error": str(e)}, 500)
            except Exception:
                pass

    def _serve_file(self, fs_path):
        if not os.path.isfile(fs_path):
            return self._send(404, "not found: " + os.path.basename(fs_path),
                              "text/plain; charset=utf-8")
        ctype = mimetypes.guess_type(fs_path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",
                                                  "application/json"):
            ctype += "; charset=utf-8"
        with open(fs_path, "rb") as f:
            data = f.read()
        self._send(200, data, ctype)


# ---------------------------------------------------------------- API 实现
def api_bootstrap():
    """把"服务器实际支持什么"整体交给前端，前端据此生成控件。"""
    info = {}
    try:
        info = http_json("/object_info", timeout=60)
    except Exception as e:
        log("object_info failed:", repr(e))

    def _unwrap(v):
        """ComfyUI 的 COMBO 有时是 [opts, meta]，有时是 [[opts, meta]]，统一成 list。"""
        while isinstance(v, list) and len(v) == 1 and isinstance(v[0], list):
            v = v[0]
        return v

    def opts(node, key, required=True):
        try:
            sec = info[node]["input"]["required" if required else "optional"]
            spec = sec[key]
            if len(spec) > 1 and isinstance(spec[1], dict) and "options" in spec[1]:
                return _unwrap(spec[1]["options"])
            if isinstance(spec, list) and spec and isinstance(spec[0], list):
                return _unwrap(spec[0])
            return None
        except Exception:
            return None

    stats = {}
    try:
        stats = http_json("/system_stats", timeout=10)
    except Exception:
        pass

    def files(node, key, required=True):
        o = opts(node, key, required)
        return _unwrap(o) if o else []

    return {
        "ok": True,
        "defaults": {
            "unet_name": DIFFUSION, "clip_name": ENCODER, "vae_name": VAE,
            "lora_name": LORA, "clip_type": "qwen_image",
        },
        "available": {
            "diffusion_models": files("UNETLoader", "unet_name"),
            "text_encoders": files("CLIPLoader", "clip_name"),
            "vaes": files("VAELoader", "vae_name"),
            "loras": files("LoraLoaderModelOnly", "lora_name"),
        },
        "options": {
            "sampler_name": opts("KSampler", "sampler_name"),
            "scheduler": opts("KSampler", "scheduler"),
            "weight_dtype": opts("UNETLoader", "weight_dtype"),
            "clip_device": opts("CLIPLoader", "device", required=False),
            "cache_device": opts("QwenImage21Cache", "device"),
            "cache_dtype": opts("QwenImage21Cache", "dtype"),
        },
        "limits": {
            "steps": [1, 200], "cfg": [0.0, 20.0], "denoise": [0.0, 1.0],
            "width": [256, 4096], "height": [256, 4096], "batch_size": [1, 16],
            "resolution": [512, 4096], "lora_strength": [0.0, 2.0],
        },
        "system": {
            "comfyui_version": (stats.get("system") or {}).get("comfyui_version"),
            "devices": [{"name": d.get("name"), "type": d.get("type"),
                         "vram_total": d.get("vram_total"),
                         "vram_free": d.get("vram_free"),
                         "torch_free": d.get("torch_free")}
                        for d in (stats.get("devices") or [])],
            "python": sys.version.split()[0],
            "admin": is_admin(),
            "ui_version": ui_version(),
            "output_dir": OUT_DIR,
            "comfy_output": COMFY_OUTPUT,
            "sys_negative": SYS_NEG,
        },
    }


_UI_VER = {"stamp": None, "ver": "0"}


def ui_version():
    """界面文件的版本号（内容哈希）。前端每次 /api/status（1.5 秒一次）都对
    一遍，对不上就自动刷新页面 —— 用户看不到「关掉再打开还是旧的」那种事了。
    按 mtime 缓存，不用每次都重算 35KB 的 sha1。"""
    try:
        p = os.path.join(UI_DIR, "index.html")
        st = os.stat(p)
        stamp = (st.st_mtime, st.st_size)
        if _UI_VER["stamp"] == stamp:
            return _UI_VER["ver"]
        with open(p, "rb") as f:
            ver = hashlib.sha1(f.read()).hexdigest()[:12]
        _UI_VER["stamp"] = stamp
        _UI_VER["ver"] = ver
        return ver
    except Exception:
        return "0"


def api_status():
    # 队列/显存读后台线程刷好的缓存，状态接口永远秒回，不会被 ComfyUI 拖住
    snap = JOB.snapshot()          # snapshot 自己加锁，别再套一层（Lock 不可重入）
    # 图始终带着下发：前端用 gen 号自己判重（同一批只画一次）。之前这里是
    # 「只下发一次」，结果第二个窗口/刷新后的页面就再也拿不到那一批图了。
    snap.pop("params", None)
    snap["queue_running"] = POLL_CACHE["queue_running"]
    snap["queue_pending"] = POLL_CACHE["queue_pending"]
    snap["sys"] = POLL_CACHE["sys"]
    snap["monitor_age"] = round(time.time() - POLL_CACHE["at"], 1) \
        if POLL_CACHE["at"] else None
    # 界面的版本号跟着状态一起下发：前端 1.5 秒问一次状态，顺手就能发现自己
    # 是旧页面（服务端换了 index.html 而窗口一直开着），然后自动刷新。
    snap["ui"] = ui_version()
    return snap


def api_generate(body):
    params = body.get("params") or {}
    files_in = body.get("files") or []
    uploaded = []
    for f in files_in:
        data = f.get("data") or ""
        if "," in data:
            data = data.split(",", 1)[1]
        import base64
        uploaded.append((base64.b64decode(data), f.get("name") or "ref.png"))

    with ENV_LOCK:
        env = ENV_STATE["state"]
    if env != "ready" and not comfy_alive():
        return {"ok": False, "error": "绘图内核还没就绪，等一下再点。",
                "starting": True}

    with JOB.lock:
        if JOB.state == "running":
            return {"ok": False, "error": "上一张还在画，等它画完或者点取消。",
                    "busy": True}
    t = threading.Thread(target=run_job, args=(params, uploaded), daemon=True)
    t.start()
    return {"ok": True, "started": True}


def api_open_path(path, kind="select"):
    """用资源管理器定位/打开一个路径。

    浏览器里的 file:// 链接从 http 页面打开会被 Edge 拦掉，所以交给服务端调
    explorer。kind="folder" 时不传路径，默认打开 ComfyUI 输出目录。
    """
    if kind == "folder":
        target = os.path.abspath(path) if path else OUT_DIR
        if not os.path.isdir(target):
            return {"ok": False, "error": "不是文件夹: " + target}
        os.startfile(target)
        return {"ok": True, "path": target}
    if not path:
        return {"ok": False, "error": "空路径"}
    target = os.path.abspath(path)
    allowed = [os.path.abspath(CACHE_DIR)] + output_dirs()
    if not any(target.lower().startswith(a.lower()) for a in allowed):
        return {"ok": False, "error": "只允许打开输出目录里的文件"}
    if not os.path.isfile(target):
        return {"ok": False, "error": "文件不存在: " + target}
    subprocess.Popen(["explorer", "/select,", target])
    return {"ok": True, "path": target}


def api_pick_output_dir(body):
    """弹一个 Windows 文件夹选择框，把输出目录改到用户挑的地方。

    嵌入式 Python 里没有 tkinter（`import tkinter` 直接 ModuleNotFoundError），
    服务端自己也开不了文件框，只能借 PowerShell 的 WinForms FolderBrowserDialog。
    必须 -STA（COM 对话框要求单线程单元），[Console]::OutputEncoding 也要强制
    UTF-8，否则中文路径经管道回来会变成乱码。
    """
    want = (body or {}).get("path")
    if want:
        try:
            return {"ok": True, "dir": set_out_dir(want)}
        except Exception as e:
            return {"ok": False, "error": "改不了这个目录：%s" % e}
    tmp = os.path.join(APP_DIR, "pick-dir.tmp")
    try:
        os.remove(tmp)
    except OSError:
        pass
    ps = ("Add-Type -AssemblyName System.Windows.Forms | Out-Null;"
          "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
          "$d.Description = '选择出图的保存文件夹';"
          "$d.SelectedPath = $env:QWEN_OUT_DIR;"
          "$d.ShowNewFolderButton = $true;"
          "$r = '';"
          "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)"
          " { $r = $d.SelectedPath };"
          "[System.IO.File]::WriteAllText($env:QWEN_PICK_OUT, $r,"
          " [System.Text.Encoding]::UTF8)")
    env = dict(os.environ, QWEN_OUT_DIR=OUT_DIR, QWEN_PICK_OUT=tmp)
    try:
        p = subprocess.run(["powershell.exe", "-NoProfile", "-STA", "-Command", ps],
                           capture_output=True, timeout=300, env=env)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "文件夹选择框没有响应（超时）"}
    except Exception as e:
        return {"ok": False, "error": "打不开文件夹选择框：%s" % e}
    sel = ""
    try:
        with open(tmp, "r", encoding="utf-8-sig") as f:
            sel = f.read().strip()
    except Exception:
        pass
    try:
        os.remove(tmp)
    except OSError:
        pass
    if not sel:
        err = (p.stderr or b"").decode("utf-8", "replace").strip()
        if err:
            log("folder picker stderr:", err[:400])
            return {"ok": False, "error": "文件夹选择框出错：" + err.splitlines()[0][:200]}
        return {"ok": True, "cancelled": True, "dir": OUT_DIR}
    if not os.path.isdir(sel):
        return {"ok": False, "error": "不是文件夹：" + sel}
    try:
        return {"ok": True, "dir": set_out_dir(sel)}
    except Exception as e:
        return {"ok": False, "error": "改不了这个目录：%s" % e}


def api_selftest():
    """体检：服务、权重、节点、工作流五关，全部在内存里做，不占用显卡。"""
    checks = []

    def add(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})

    try:
        stats = http_json("/system_stats", timeout=10)
        ver = (stats.get("system") or {}).get("comfyui_version")
        add("ComfyUI 服务", bool(ver), "版本 " + str(ver))
    except Exception as e:
        add("ComfyUI 服务", False, repr(e))
        return {"ok": False, "checks": checks}

    sizes = {DIFFUSION: ("diffusion_models", DIFFUSION_BYTES),
             ENCODER: ("text_encoders", ENCODER_BYTES),
             VAE: ("vae", VAE_BYTES),
             LORA: ("loras", LORA_BYTES)}
    missing = []
    for fn, (sub, want) in sizes.items():
        hits = [os.path.join(root, sub, fn) for root in MODEL_ROOTS
                if os.path.isfile(os.path.join(root, sub, fn))]
        if not hits:
            missing.append("%s 找不到" % fn)
        elif os.path.getsize(hits[0]) != want:
            missing.append("%s 大小不符 (%d != %d)" % (fn, os.path.getsize(hits[0]),
                                                        want))
    add("模型权重", not missing,
        ("四个文件齐全、字节数正确，位于 " + hits[0]) if not missing
        else "；".join(missing))

    graph, seed = build_workflow({"prompt": "selftest", "images": [],
                                  "use_lora": True, "steps": 8})
    add("工作流构建", bool(graph), "%d 个节点，seed=%s" % (len(graph), seed))

    info = {}
    try:
        info = http_json("/object_info", timeout=60)
    except Exception as e:
        add("节点定义", False, repr(e))
        info = {}
    if info:
        need = sorted({v["class_type"] for v in graph.values()})
        bad = [c for c in need if c not in info]
        add("节点定义", not bad,
            "全部存在" if not bad else "服务器不认识: " + ", ".join(bad))

    # 逐项对照 object_info 校验输入名与枚举取值（等同服务器端校验，不排队）
    if info:
        problems = []
        for nid, node in graph.items():
            ct = node["class_type"]
            spec = info.get(ct, {}).get("input", {})
            req = spec.get("required", {})
            opt = spec.get("optional", {})
            for key, val in (node.get("inputs") or {}).items():
                if isinstance(val, list) and len(val) == 2 and \
                        str(val[0]) in graph:
                    continue
                if key in opt and key not in req:
                    continue
                if key not in req and key not in opt:
                    problems.append("%s(%s) 多了输入 %s" % (nid, ct, key))
                    continue
                s = req.get(key) or opt.get(key)
                if len(s) > 1 and isinstance(s[1], dict):
                    enum = s[1].get("options")
                    if isinstance(enum, list) and enum and isinstance(enum[0], str) \
                            and isinstance(val, str) and val not in enum:
                        problems.append("%s(%s).%s=%r 不在可选值里" % (nid, ct, key, val))
        add("输入与枚举", not problems,
            "全部合法" if not problems else "；".join(problems[:6]))

    return {"ok": all(c["ok"] for c in checks), "checks": checks}


def api_check_updates():
    """比对本地权重与 Comfy-Org 仓库的文件清单（同名同大小即视为最新）。"""
    import hashlib
    repo = "Comfy-Org/Qwen-Image-2.1"
    paths = {
        "diffusion_models/" + DIFFUSION: os.path.join(COMFY_DIR, "models",
                                                      "diffusion_models", DIFFUSION),
        "text_encoders/" + ENCODER: os.path.join(COMFY_DIR, "models",
                                                 "text_encoders", ENCODER),
        "vae/" + VAE: os.path.join(COMFY_DIR, "models", "vae", VAE),
    }
    out = []
    for rel, local in paths.items():
        item = {"file": rel, "local": os.path.isfile(local)}
        if item["local"]:
            item["local_size"] = os.path.getsize(local)
        try:
            url = ("https://modelscope.cn/api/v1/models/%s/repo?"
                   "Revision=master&FilePath=%s" % (repo, urllib.parse.quote(rel)))
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=15) as r:
                item["remote_size"] = int(r.headers.get("Content-Length") or 0)
        except Exception as e:
            item["remote_error"] = str(e)[:120]
        if item.get("local_size") and item.get("remote_size"):
            item["up_to_date"] = item["local_size"] == item["remote_size"]
        out.append(item)
    return {"ok": True, "repo": repo, "files": out,
            "model_last_modified": None}


# ---------------------------------------------------------------- 启动
COMFY_PROC = {"proc": None, "spawned": False}
STOP = threading.Event()
COMFY_VER = "0.37.0"

# 内核启动状态，前端轮询 /api/health 拿它来显示「正在启动内核…」
ENV_STATE = {
    "state": "starting",     # starting | ready | failed
    "message": "正在检查绘图内核…",
    "started": time.time(),
    "error": None,
}
ENV_LOCK = threading.Lock()


def env_set(state, message, error=None):
    with ENV_LOCK:
        ENV_STATE["state"] = state
        ENV_STATE["message"] = message
        ENV_STATE["error"] = error
    log("[env] %s - %s" % (state, message))


def api_health():
    with ENV_LOCK:
        d = dict(ENV_STATE)
    d["elapsed"] = time.time() - d.get("started", time.time())
    d["comfy_alive"] = comfy_alive()
    return d


def missing_weights():
    """返回缺失/尺寸不对的权重文件列表（空列表 = 环境完整）。"""
    found = {}
    for root in MODEL_ROOTS:
        for sub, name, want in (("diffusion_models", DIFFUSION, DIFFUSION_BYTES),
                                ("text_encoders", ENCODER, ENCODER_BYTES),
                                ("vae", VAE, VAE_BYTES),
                                ("loras", LORA, LORA_BYTES)):
            p = os.path.join(root, sub, name)
            if os.path.isfile(p):
                found[name] = (p, want)
    bad = []
    for name, want in ((DIFFUSION, DIFFUSION_BYTES), (ENCODER, ENCODER_BYTES),
                       (VAE, VAE_BYTES), (LORA, LORA_BYTES)):
        if name not in found:
            bad.append(name + "（没找到）")
        else:
            p, w = found[name]
            if w and os.path.getsize(p) != w:
                bad.append("%s（大小不对 %d）" % (name, os.path.getsize(p)))
    return bad



def shutdown_all(reason="退出"):
    """关掉自己拉起来的 ComfyUI，然后退出进程。"""
    log(reason + "：正在关闭后端…")
    if COMFY_PROC["spawned"] and COMFY_PROC["proc"] is not None:
        try:
            http_json("/interrupt", {}, timeout=5)
        except Exception:
            pass
        try:
            COMFY_PROC["proc"].terminate()
            log("已关闭 ComfyUI (pid=%d)" % COMFY_PROC["proc"].pid)
        except Exception as e:
            log("关闭 ComfyUI 失败:", repr(e))
    else:
        log("ComfyUI 不是本程序启动的，保持运行")
    os._exit(0)


def start_comfyui_if_needed(on_note=None):
    if comfy_alive():
        log("ComfyUI 已在运行")
        return True, None
    log("ComfyUI 没在跑，正在后台启动…")
    main_py = os.path.join(COMFY_DIR, "main.py")
    if not os.path.isfile(main_py):
        return False, "找不到 %s" % main_py
    creation = 0x08000000  # CREATE_NO_WINDOW
    try:
        proc = subprocess.Popen(
            [PY_EXE, "-s", main_py, "--listen", HOST, "--port", str(PORT)],
            cwd=COMFY_DIR,
            stdout=open(os.path.join(APP_DIR, "comfyui.log"), "ab"),
            stderr=subprocess.STDOUT,
            creationflags=creation)
    except Exception as e:
        return False, "启动失败: %r" % (e,)
    COMFY_PROC["proc"] = proc
    COMFY_PROC["spawned"] = True
    log("ComfyUI pid=%d，等它加载模型…" % proc.pid)
    ok = wait_comfy(240, on_note=on_note)
    return (True, None) if ok else (False, "ComfyUI 启动超时（4 分钟）")


def start_env_worker():
    """后台线程：体检权重 -> 必要时拉起 ComfyUI -> 更新启动状态。

    注意：整个过程放到线程里，界面和浏览器窗口先开出来，
    前端靠轮询 /api/health 显示「正在启动绘图内核…（已 Ns）」。
    """
    env_set("starting", "正在检查模型文件…")
    try:
        bad = missing_weights()
        if bad:
            env_set("failed", "模型文件不完整：" + "、".join(bad),
                    error="missing weights")
            return
        env_set("starting", "正在启动绘图内核…（首次要加载 7GB 权重，约 30 秒）")
        ok, err = start_comfyui_if_needed(
            on_note=lambda s: env_set("starting",
                                      "正在启动绘图内核…（已 %d 秒）" % s)
            if s % 10 == 0 else None)
        if not ok:
            env_set("failed", err or "内核启动失败", error="start failed")
            return
        env_set("ready", "绘图内核已就绪")
    except Exception as e:
        log("[env] ERROR " + repr(e))
        log(traceback.format_exc()[-1500:])
        env_set("failed", "启动过程出错: %s" % (e,), error="exception")


def open_window(url):
    """优先用 Edge 的 app 模式开一个没有地址栏的独立窗口。"""
    edge = None
    for p in (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"):
        if os.path.isfile(p):
            edge = p
            break
    profile = os.path.join(APP_DIR, "edge-profile")
    if edge:
        try:
            subprocess.Popen([edge, "--app=" + url,
                              "--user-data-dir=" + profile,
                              "--window-size=1500,950",
                              "--no-first-run", "--no-default-browser-check"])
            log("用 Edge app 模式打开窗口")
            return True
        except Exception as e:
            log("Edge 打开失败:", repr(e))
    try:
        os.startfile(url)
        log("用默认浏览器打开")
        return True
    except Exception as e:
        log("打开浏览器失败:", repr(e))
        return False


def find_port(start=8801, tries=20):
    for p in range(start, start + tries):
        if free_port(p):
            return p
    return start


def instance_alive():
    """另一个 Qwen Studio 还活着吗？活着就返回它的地址。

    单实例保护：以前双击第二次启动时会另起一个 studio + 另起一个 ComfyUI，
    两个进程抢同一份 history.json / cache / 日志，还会各按自己的计数发 gen 号，
    界面就会出现「图明明生成了，结果区不动」这种鬼打墙。现在第二个实例直接
    开窗口指向已经在跑的那个。
    """
    try:
        with open(URL_FILE, "r", encoding="utf-8") as f:
            url = f.read().strip()
    except Exception:
        return None
    if not url:
        return None
    try:
        with urllib.request.urlopen(url + "api/health", timeout=2) as r:
            r.read(64)
        return url
    except Exception:
        return None


def remember_url(url):
    try:
        with open(URL_FILE, "w", encoding="utf-8") as f:
            f.write(url)
    except Exception as e:
        log("写 url 文件失败:", repr(e))


def main():
    log("=" * 60)
    log("Qwen Studio 启动中")

    forced = int(os.environ.get("QWEN_STUDIO_PORT", "0"))
    if not forced:
        alive = instance_alive()
        if alive:
            log("已经有一个 Qwen Studio 在跑：%s，这次只开窗口" % alive)
            if not os.environ.get("QWEN_STUDIO_NO_WINDOW"):
                open_window(alive)
            return

    port = forced or find_port()
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        # 检查完到 bind 之间被别的实例抢先了：交给它
        log("端口 %d 被占用（%r），把窗口指过去" % (port, e))
        alive = instance_alive()
        if alive and not os.environ.get("QWEN_STUDIO_NO_WINDOW"):
            open_window(alive)
        return
    url = "http://127.0.0.1:%d/" % port
    remember_url(url)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log("界面地址 %s" % url)

    # 重启后 gen 号从 0 重来会撞上历史里的旧 gen（前端按 gen 分批，撞了就
    # 认为「这批已经画过了」而不再更新）。所以接着历史里的最大值往下数。
    old_max = 0
    for h in load_history():
        try:
            old_max = max(old_max, int(h.get("gen") or 0))
        except (TypeError, ValueError):
            pass
    if old_max:
        JOB.gen = old_max
        log("历史里已有 %d 次生成，批次号从 %d 接着数" % (old_max, old_max))

    try:
        restore_missing_outputs()
    except Exception as e:
        log("restore_missing_outputs failed:", repr(e))

    # 先起界面和窗口，内核在后台拉（前端轮询 /api/health 看进度）
    threading.Thread(target=start_env_worker, daemon=True).start()
    threading.Thread(target=comfy_monitor_loop, daemon=True).start()

    time.sleep(0.6)
    debug = bool(os.environ.get("QWEN_STUDIO_NO_WINDOW"))
    if debug:
        log("（调试模式：不打开浏览器窗口）")
    else:
        open_window(url)

    # 等 /api/quit 触发 server.shutdown()，或 Ctrl+C
    try:
        while not STOP.is_set():
            STOP.wait(0.5)
    except KeyboardInterrupt:
        pass
    log("界面服务已停止")
    # QWEN_STUDIO_NO_WINDOW 既压窗口又跳过清理，是为了单独调试时不误杀 ComfyUI；
    # 被融合版当子进程托管时必须清理（否则 ComfyUI 会变成孤儿进程占着显存）。
    if debug and not os.environ.get("QWEN_STUDIO_CLEANUP"):
        return
    shutdown_all("退出")


if __name__ == "__main__":
    main()
