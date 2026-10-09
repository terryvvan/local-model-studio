# Local Model Studio

把两套本地模型合成一个桌面程序：**对话**（Ternary Bonsai 2 27B）＋ **生图**（Qwen-Image-2.1），
两个 tab 装在同一个窗口里，共用同一块 8 GB 显存。

原来的 `bonsai`（Bonsai Studio）和 `qwen-setup`（Qwen Studio）已经**完全合并到这里**：代码、模型权重、
启动脚本、历史图库都不再依赖那两个目录，它们已在 2026-10-08 删除（旧源码与使用说明存档在 `docs\`）。
所以**只从这里启动**——只有这个版本知道怎么把显存让给对方。

---

## 快速开始

| 方式 | 怎么做 | 什么时候用 |
| --- | --- | --- |
| 桌面图标 | 双击桌面的 **Local Model Studio** | 日常使用（无黑框窗口） |
| 项目内入口 | 双击 `启动 Local Model Studio.bat` | 同上 |
| 带控制台 | 双击 `start-console.bat` | **出问题时用这个**，能看到真实报错 |
| 命令行 | `node app\launch.js` | 调试 |

启动后会自动打开一个没有地址栏的 Chrome/Edge 应用窗口。**关掉这个窗口 = 整个程序退出**，
后台的 llama-server / ComfyUI 会一起被停掉，不会留下吃显存的孤儿进程。

首次进对话要加载 5.5 GB 权重（约 4–8 秒），首次进生图要等 ComfyUI 起来（约 17 秒，之后约 12 秒）。

---

## 界面

窗口顶部是两个 tab：**对话** 和 **生图**。

### 对话 tab

- **对话框旁边的快捷配置**（不用再进设置弹窗）：
  - **思考深度** — `none` / `medium` / `xhigh`。默认 `medium`，省 token 且精度基本不掉；
    `none` 关掉思考链，回答最快；`xhigh` 最啰嗦。
  - **联网** — 打开后每次提问会先去 Bing 检索一轮，把结果作为资料喂给模型，界面上会显示引用来源。
  - **无审查** — 打开后切到 OrcaBonsai 消融 LoRA（scale 2.0）。
- **按 Enter 发送，Shift+Enter 换行。**
- 附件：可以拖图片进去（需要先打开「识图」）。
- 思考过程默认折叠，点一下展开。

### 让它画图（跨模态）

直接说「画一只坐在窗台上的橘猫」就行。模型自己会调用 `generate_image` 工具：

1. 弹出提示「正在切换到绘图引擎（会先卸载对话模型，约 30–60 秒）」
2. 自动释放对话模型 → 启动绘图栈 → 出图 → 图片直接显示在对话里
3. 自动把对话模型拉回来，再说一句收尾的话

**这中间会切换两次显存**，所以整体比单独用生图 tab 慢一分钟左右。急着出图就直接去生图 tab。

### 生图 tab

qwen-setup 那套界面原样搬过来了，功能没动：

- 提示词 / 负面词、宽高、步数、种子、批量张数
- 参考图（拖进去即可，画布比例可以跟随参考图）
- 历史记录、输出目录选择、系统级负面词
- 进度条按 1 秒轮询刷新

出图速度实测：**1024×1024、8 步、带 Pruna LoRA ≈ 27 秒**。
（`p_qwen_image_2.1_8step_v0.1` 是 8 步 LoRA，步数调到 25 只会更慢，画质不会更好。）

---

## 显存仲裁（这个项目最核心的部分）

**问题**：8 GB 显存，对话模型自己就要 7.6 GB，绘图模型要 6.8 GB。两个同时加载必然爆。

**做法**：同一时刻只让一个模型占显存，Node 后端里有一个串行仲裁器负责切换。

```
进对话  →  释放绘图模型（POST /free，权重卸载但 ComfyUI 进程保活）
            └ 显存 20 秒内没降下来，才退掉整个绘图栈
        →  轮询 nvidia-smi，等显存降到 1500 MiB 以下
        →  启动 llama-server，等它 ready

进生图  →  停掉 llama-server
        →  轮询 nvidia-smi，等显存降到 1500 MiB 以下
        →  启动 Python 桥接 → 桥接再拉起 ComfyUI → 等 /api/health
```

几个关键点：

- **切换必须串行**。后端的 `withGate()` 用一条 promise 链当互斥锁，任何两个切换不会交叉执行。
- **WDDM 下显存释放是惰性的**，杀了进程显存也不会立刻掉，所以必须轮询等待（`waitVramBelow`），
  不能杀了就立刻启动对方。
- **优先卸载而不是杀进程**。ComfyUI 支持 `POST /free {unload_models, free_memory}`，
  卸载权重后进程还在，下次进生图省掉重新初始化的时间。
- **只能读显存总量**。WDDM 下 `nvidia-smi --query-compute-apps` 对所有进程都返回 `[N/A]`，
  认不出是哪个进程占的，所以仲裁器只能看全局 `memory.used`。

实测切换耗时：生图 → 对话约 10–20 秒（要加 5.5 GB 权重加载）；对话 → 生图约 40–60 秒。

---

## 目录结构

```
local-model\
  config.json            所有路径和端口的唯一配置源
  Local Model Studio.vbs 无窗口启动器（纯 ASCII，见下方排错）
  启动 Local Model Studio.bat
  start-console.bat      带控制台的启动器（排错用）
  app\
    server.js            统一后端（零依赖 Node，唯一门户）
    launch.js            桌面启动器：起后端 → 开应用窗口 → 关窗即退出
    ui\index.html        统一界面（两个 tab）
    ui\index.html.orig   合并前 Bonsai Studio 的界面（保留作参考）
    settings.json        对话侧设置
    logs\                engine.pid / bridge.pid / launcher.log / engine-*.log
  chat\                  对话侧
    llamacpp\bin\        llama-server.exe 等（PrismML fork b10743）
    models\              Ternary-Bonsai-2-27B-PTQ1_0.gguf + mmproj-Q8_0.gguf
    lora\                bonsai-abliterate-lora.gguf（OrcaBonsai 消融适配器）
  image\                 生图侧
    qwen_studio.py       Python 桥接（已改成读 config.json）
    ui\index.html        生图界面
    workflows\           8 个工作流 JSON（参考）
    settings.json        输出目录 / 系统负面词
    history.json         出图历史
    output\              生成的图片
  tools\
    smoke-test.ps1       端到端自检
```

---

## config.json

```json
{
  "appPort": 8890,
  "chat":  { "binDir": "chat/llamacpp/bin", "modelsDir": "chat/models",
             "loraDir": "chat/lora", "enginePort": 8110 },
  "image": { "portable": "E:\\ComfyUI_windows_portable",
             "modelRoot": "E:\\ComfyUI\\ComfyUI\\models",
             "bridgePort": 8802, "comfyPort": 8188 },
  "search": { "endpoint": "https://www.bing.com/search", "count": 8 },
  "vram":   { "releaseTargetMiB": 1500, "releaseTimeoutMs": 45000 }
}
```

- 路径用**相对路径**时以项目根为基准；`image.portable` / `image.modelRoot` 是绝对路径
  （ComfyUI 便携版还在 E 盘）。
- 端口占用时改这里即可，不用动代码。
- `QWEN_STUDIO_PORT` / `LOCALMODEL_APP_PORT` 环境变量可以临时覆盖端口。

---

## HTTP API

后端跑在 `appPort`（默认 8890），所有请求都经过它。

### 状态与设置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 全量状态：mode / gpu / chat{settings,schema,presets,catalog,alive,ready} / image{...} |
| GET | `/api/gpu` | 只取显存温度利用率 |
| POST | `/api/settings` | 改对话设置（自动判断是否需要重启引擎） |
| POST | `/api/preset` | 套用预设：`balanced` / `fast` / `longctx` / `uncensored` / `vision` |
| POST | `/api/apply-lora` | 热改 LoRA scale |
| POST | `/api/server` | `{action: start\|stop\|restart}` 控制 llama-server |
| GET | `/api/log?lines=N` | 引擎日志尾部 |
| POST | `/api/switch` | `{target: "chat"\|"image"}` 手动触发仲裁器 |
| GET | `/api/search?q=` | 单独试一次联网检索 |

### 对话

`POST /api/chat` 返回 **SSE**，事件类型：

| type | 含义 |
| --- | --- |
| `mode` | 切换到哪个引擎 |
| `status` | 人类可读的阶段提示 |
| `search` | 联网检索结果（含来源列表） |
| `reasoning` | 思考链增量 |
| `delta` | 正文增量 |
| `speed` | 每 16 token 一次的速度采样 |
| `progress` | 出图进度 |
| `tool` | 模型调用了工具（含参数） |
| `image` | 出图完成（含图片 URL） |
| `stats` | 收尾统计：`wall_s / gen_tokens / prompt_tokens / gen_tps / prompt_tps / cached_n` |
| `error` / `done` | 出错 / 结束 |

请求体：`{messages:[...], search?:bool, tools?:bool, max_tokens?:n}`

### 生图

`POST /api/image/<sub>` 会**先确保生图栈已启动**，然后原样转发给 Python 桥接。
`<sub>` 可以是 `generate` / `cancel` / `start-env` / `sys-negative` / `open-path` /
`history/delete` / `history/clear` / `pick-output-dir` 等。

少数几个被后端接管，不再转发：

| 路径 | 行为 |
| --- | --- |
| `GET /api/image/status`、`/api/image/health` | 桥接没起来时返回空状态而不是报错 |
| `GET /api/image/history` | 直读 `history.json` |
| `POST /api/image/boot` | 走仲裁器启动生图栈 |
| `POST /api/image/stop` | 停掉 Python 桥接 |
| `POST /api/image/free` | `POST /free` 卸载权重但保留进程 |
| `POST /api/image/quit` | 优雅退出桥接（连带停 ComfyUI） |

### 跨模态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/generate-image` | 直接触发出图并自动切显存；`{params:{...}, files:[...], keepImage?:bool}` |

### 静态资源

`GET /img/<name>`、`GET /output/<rel>`、`GET /abs?p=` 都是转发给桥接取图片。

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 双击图标没反应 | 看 `app\logs\launcher.log`；或改用 `start-console.bat` 看真实报错 |
| 双击了两次，出现两个窗口 | 正常。第二个实例探测到 8890 上已经有程序在跑，就只**挂靠**上去再开一个窗口，不会起第二个后端、也不会在关窗时把第一个后端带走 |
| 提示 `port 8890 already in use` | 端口被别的程序占了（不是本程序）。改 `config.json` 的 `appPort`，或用环境变量 `LOCALMODEL_APP_PORT` |
| 窗口起来了但一直转圈 | 引擎还在加载。首次对话要 4–8 秒，首次生图要 17 秒 |
| 界面空白 | 换 `start-console.bat` 启动，F12 看 console |
| 出图报 `Value -1 smaller than min of 0: seed` | 种子传了 -1。生图侧的约定是**不传**（或传 `null`/`"random"`）才随机 |
| 模型反复说「still warming up」，出图不成功 | 桥接的 `/api/health` 返回 200 只代表 HTTP 监听起来，**ComfyUI 还在启动**。真正就绪的判据是 `state === "ready"`。`startBridge()`/`ensureImage()` 必须过 `waitBridgeReady()` |
| 出图报 `上一个还在画` | 上一张没画完，去生图 tab 点取消 |
| 显存没释放 | `POST /api/image/quit` 退掉绘图栈；还不行就 `POST /api/server {action:"stop"}` 停对话引擎 |
| 中文注释的 .vbs 报「缺少对象: 'sh'」 | WSH 按 ANSI 解码无 BOM 文件。`.vbs` 必须**纯 ASCII** |
| 模型回「你的消息里有些字符是问号」 | 不是程序问题——用 PowerShell 发测试请求时没把 body 当 UTF-8 字节发 |

`tools\smoke-test.ps1` 会把整条链路跑一遍（状态 → 对话 → 中文 → 跨模态出图 → 生图 tab），
出错时先跑它。

---

## 已知边界

- **只有 PrismML fork 的 llama.cpp 能加载 PTQ1_0 权重。** 官方 Ollama / 原版 llama.cpp 会断言崩；
  `Ternary-Bonsai-2-27B-F16.gguf` 虽然是标准张量类型、能加载，但缺 Hadamard 旋转会**输出乱码而不报错**。
- **绝对速度会漂移 ±20%**（笔记本功耗墙/温度墙），看相对差异比看绝对值可靠。
- **无审查 LoRA 有代价**：scale 1 时生成速度 22.8 → 16.7 t/s（−27%），这是每 token 的额外 matmul 开销，
  和显存无关；scale 2 反而回到 21 t/s。
- **两个模型不能同时常驻**。想同时用只能接受「对话缩到 4k 上下文 + ComfyUI --lowvram」，
  两边都会明显变慢，目前没做这个模式。
- ComfyUI 的 `comfy_extras\nodes_qwen.py` 被就地打过补丁（给 `TextEncodeQwenImage21` 加了 width/height）。
  **跑 `update_comfyui.bat` 会把它整份覆盖**，补丁就没了。检查办法：
  `GET /object_info/TextEncodeQwenImage21` 里有没有 width/height。
