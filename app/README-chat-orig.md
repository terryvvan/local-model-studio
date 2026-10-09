# Bonsai Studio — 本机版 Ternary Bonsai 2 27B 桌面客户端

把 `F:\v\project\dsh-test\bonsai` 这套 llama.cpp + 三值权重封装成一个**双击即用的桌面程序**：
一个聊天窗口、一个「系统设置」弹窗（含悬浮解释与实测预计值）、五个一键推荐配置。

零依赖：只用 Node 内置模块（`http` / `child_process` / `fetch`），**没有 npm 包、没有 Electron**；
窗口用 Chrome/Edge 的 `--app` 模式打开，所以外观是一个独立应用窗口而不是浏览器标签页。

---

## 怎么启动

| 方式 | 操作 |
| --- | --- |
| 桌面快捷方式 | 双击桌面上的 **Bonsai Studio** |
| 无窗口启动 | 双击 `F:\v\project\dsh-test\bonsai\Bonsai Studio.vbs` |
| 带控制台（排错用） | 双击 `F:\v\project\dsh-test\bonsai\app\start.bat` |

启动顺序：`Bonsai Studio.vbs` → `node app\launch.js` → 起界面服务（8788）→ 起引擎（llama-server，8110）
→ 等两端就绪 → 打开应用窗口。**关掉窗口 = 停引擎**，不会在后台留 7.6 GB 显存的孤儿进程。

首次启动要加载 5.95 GB 权重，约 **5–20 秒**；窗口里状态灯变绿即可聊天。

---

## 界面

- 顶栏：引擎状态、**显存 / 温度 / 实时 t/s**、停机·开机、引擎日志、系统设置。
- 对话区：流式输出、思考过程可折叠、每条回答标注 token 数与首字延迟。
- 输入区：`Enter` 发送、`Shift+Enter` 换行；**🖼 按钮 / Ctrl+V 粘贴 / 拖拽**三种方式加图。
- 系统设置弹窗：四个分页 + 推荐配置 + 状态页，每项参数都有 `?` 悬浮解释与 **📊 本机实测预计值**。

---

## 「一键推荐配置」

| 预设 | 用途 | 本机实测预计 |
| --- | --- | --- |
| **均衡日常**（推荐） | 纯文本聊天 | ≈22–23 t/s，VRAM ≈7.6 GB |
| **极速优先** | 关思考 + 量化 KV + 8k 上下文 | 首字最快，VRAM ≈7.0 GB |
| **长上下文** | 32k 上下文 + q8_0 KV | VRAM ≈7.6–7.9 GB |
| **无审查模式** | 挂 OrcaBonsai 适配器并自动拧到 scale 2 | 代价仅 3.6–5.0% 速度、显存 +34 MiB |
| **识图模式** | 开视觉塔 + 大批大小 | VRAM 7.73 GB，图片先缩到 1280 长边 |

点预设后：参数写入 `app/settings.json`，需要重启的参数会**自动重启引擎**（约 5–25 秒），
LoRA 强度会等引擎就绪后通过运行时接口自动应用。

---

## 设置项与实测依据

### 模型与上下文
- **权重**：`PTQ1_0`（1.75 bit / 5.95 GB）。官方说明 Ada 代（你的 4060）与 L4 上 decode 最快；`PQ2_0` 只在 H100/A100/Blackwell 上更快。
- **上下文 `-c`**：原生 262144，但 KV 随上下文线性吃显存。实测 **4k/8k/16k 生成速度一样**（22.5–23.2 t/s），16k 时 VRAM ≈7.6 GB；32k 起必须量化 KV。
- **`-ngl 99`** = 全部 65 层上卡。
- **`-b/-ub` 批大小**：实测识图时 `-b 2048 -ub 512` 把图片预填充从 41.5 → **54.0 t/s**，同一张图的等待从 98–134 秒缩到 83 秒。

### 速度与显存优化
- **Flash Attention `-fa on`**：融合注意力内核，省 KV 显存、加速长上下文预填充。
- **KV 量化 `-ctk/-ctv`**：长上下文能在 8 GB 卡上跑的关键。16k f16 KV ≈1.2 GB，换 `q8_0` 省约 0.6 GB、`q4_0` 省约 0.9 GB。
- **`--no-mmap`**：权重一次读进内存常驻，实测不会被换页拖慢。
- **`-np 1`**：单用户最省显存（KV 按槽位翻倍）。
- **`--cache-ram`**：把历史提示前缀缓存在系统内存里，聊天时首字更快；本机 16 GB 内存，别设太大。

### 采样与输出
- **思考档位**：`medium` 在精度几乎不变的前提下省大量 token；`low` 不受支持（行为接近 xhigh）；传 `high` 会 HTTP 500。选 `none` 则关掉思考。
  这一项是**热生效**的——它作为请求字段逐次发送，不会重启引擎。
- **最大输出**：思考内容也吃这个预算，给小了会看到「空答/截断」。官方建议 16384 起步配 65536 上下文。
- **温度**：`0` = 贪心，同问题答案逐字节可复现（做 A/B 对比时用）。
- **重复惩罚**：思考模式官方要求 1.0（即不惩罚），调高会明显伤害推理质量。

### 识图与消融
- **启用视觉 `--mmproj`**：**不加这个参数时网页和 API 都无法发送图片**——这就是「它明明是多模态却发不了图」的原因。
  打开后加载 629 MB 视觉塔：VRAM 7.6 → 7.73–7.79 GB，启动多约 3 秒。
- **发图前缩放长边**：在浏览器里先把图片缩小再上传（原文件不动）。图片 token 数随**边长平方**增长，
  这是识图提速最有效的一招：一张 1920×1200 照片不缩放 = 4145 prompt token，缩到 1280 长边可省一半以上。
- **`--image-min-tokens`**：官方建议 1024 用于 grounding / 小图。**实测对整幅大图完全无效**（1024 与 256 都得到 4145 token）。
- **LoRA 消融适配器**：OrcaBonsai 运行时行为消融，一个权重字节都不改。
- **LoRA 强度 scale**：运行时通过 `/lora-adapters` 热切换。**本机题集实测 scale 0/1 仍 7/7 拒绝，scale 2 才 7/7 照做**
  （与作者 README 宣称的 scale 1 即可矛盾）。注意 `--lora-scaled` 在 Windows 路径下不可用（它按最后一个冒号切分，切到盘符 `F:`），所以这里走运行时接口。

---

## 目录结构

```
bonsai/
├─ Bonsai Studio.vbs          # 无窗口启动器（ASCII，WSH 按 ANSI 读 .vbs）
├─ app/
│  ├─ launch.js               # 桌面启动器：起界面服务 → 等就绪 → 开 Chrome --app 窗口 → 关窗即停引擎
│  ├─ server.js               # 零依赖 Node 后端：托管 llama-server 子进程 + 提供 UI/API
│  ├─ start.bat               # 带控制台启动（排错用）
│  ├─ ui/index.html           # 单页界面（聊天 + 设置弹窗 + 预设）
│  ├─ settings.json           # 运行时写入的设置（首次启动自动生成）
│  └─ logs/                   # 引擎日志 llama-server-*.log、engine.pid、launcher.log
├─ llamacpp/bin/              # PrismML fork 的 llama.cpp（CUDA 12.4 构建，不在 PATH 上）
├─ models/                    # PTQ1_0 权重 5.95 GB + mmproj 视觉塔 629 MB
└─ lora/                      # bonsai-abliterate-lora.gguf 9.68 MB
```

后端 API（界面用，也可自己 curl）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/state` | 设置 + schema + 预设 + 引擎状态 + 显存 |
| POST | `/api/settings` | 应用设置；需要重启的自动重启，LoRA scale 热应用 |
| POST | `/api/preset` | 应用某个推荐配置 |
| POST | `/api/apply-lora` | 只热切换 LoRA 强度 |
| POST | `/api/server` | `{"action":"start"｜"stop"｜"restart"}` |
| GET | `/api/log?lines=200` | 引擎日志尾部 |
| POST | `/api/chat` | 聊天，SSE 流式，支持图片 |

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 状态灯一直不变绿 | 看「引擎日志」。最常见是显存被别的程序占了：`nvidia-smi` 确认空闲 ≥6.5 GB。 |
| 发图按钮没反应 / 发图报错 | 设置里没开「启用视觉」。开它要重启引擎。 |
| 识图等好几分钟 | 图太大。把「发图前缩放长边」调到 1280 或 896。 |
| 关掉窗口后显存没释放 | 引擎没被回收。重开一次程序会自动清理（`app/logs/engine.pid`）。 |
| 界面服务端口被占 | 设环境变量 `BONSAI_APP_PORT` 换端口。 |
| 回答是空的或被截断 | 「最大输出」给小了，思考内容也吃这个预算，调到 4096+。 |

**绝对速度会随会话漂移约 20%**（同脚本同配置几次会话分别 22.7 / 19.2 / 18.4 t/s，与温度无关）。
所以只信**同一会话内**的相对比较，跨会话的绝对值别当基准。

---

## 已知边界

- 只有 **PrismML fork 的 llama.cpp** 能加载这套权重。stock llama.cpp / Ollama 会认不出三值张量类型，
  `ollama create` 虽然报 success，第一次推理就 `GGML_ASSERT(type >= 0 && type < GGML_TYPE_COUNT) failed` 崩掉。
  基于 stock 的前端（Jan / KoboldCpp / text-generation-webui）同理。
- `F16` 权重（51 GB）能被 stock llama.cpp 加载但**输出乱码且不报错**，别用。
- 后端源码一律纯 ASCII，`.vbs` 也是——PowerShell 5.1 和 WSH 会按 ANSI 读无 BOM 的 UTF-8，中文注释会把脚本读坏。
