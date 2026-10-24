# Python 网关

Infinite Canvas 的服务端转发网关：浏览器只访问本服务的 `/api/comfy/*` 与 `/api/bailian/*`，服务器地址、凭据、工作流和输入绑定都只存在这里。OpenAI/Gemini 渠道仍是浏览器直连，与本服务无关。

## 启动

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate   # Windows
pip install -r requirements.txt
python main.py          # 默认监听 http://127.0.0.1:8787
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `COMFY_GATEWAY_PORT` | `8787` | 监听端口（避开梯子常用 7890；vite dev 代理同步指向） |
| `COMFY_GATEWAY_HOST` | `127.0.0.1` | 仅本机；对外部署时改 `0.0.0.0` 并自行加反代鉴权 |
| `COMFY_GATEWAY_ORIGINS` | 空 | 前后端分离部署时填允许的前端来源，逗号分隔；留空则同源不放开 CORS |
| `BAILIAN_API_KEY` / `DASHSCOPE_API_KEY` | 空 | 可选：`data/bailian.json` 里没有 Key 时回退读取（与官方 SDK 同源，脚本能用的 Key 网关也能用） |
| `BAILIAN_BASE_URL` | `https://dashscope.aliyuncs.com` | 可选：文件未保存地址时的默认 DashScope 域名 |

数据存 `backend/data/`（gitignore），部署时挂 volume。

## 端点

- `GET/PUT /api/comfy/server` — ComfyUI 地址与可选 Bearer Key；`POST /api/comfy/server/test` 连通性检查。
- `POST /api/comfy/workflows` — 导入「导出 (API)」格式工作流，自动扫描可编辑节点并生成默认绑定；`PUT` 保存绑定与超时，`GET` 列表，`DELETE` 删除。
- `POST /api/comfy/upload` — 参考图/视频透传 ComfyUI `/api/upload/image`（支持 subfolder 与覆盖）。
- `POST /api/comfy/run` — 注入绑定后提交工作流，返回任务 id；`GET /api/comfy/task/{id}` 查询状态；`GET /api/comfy/output?subfolder=&filename=` 回拉产物。

百炼（DashScope）：

- `GET/PUT /api/bailian/server` — DashScope 地址与 API Key（存 `data/bailian.json`，可被环境变量首次写入）；`POST /api/bailian/server/test` 用随机不存在的 task id 探测原生 `/api/v1` 路径，免费且与真实生成走同一鉴权地址，不消耗生成额度。
- `DELETE /api/bailian/video/tasks/{id}` — 取消云端异步任务（DashScope `DELETE /api/v1/tasks/{id}`）。只有还没开始生成的任务取消得掉，已开始的任务会返回错误、仍会跑完并计费；画布点「停止」时前端会自动调用一次。
- `POST /api/bailian/chat/completions` — 透传 OpenAI 兼容的 `/compatible-mode/v1/chat/completions`，供百炼文本/视觉模型（如 `qwen3.8-flash`）做对话与图像理解；默认带 `enable_thinking: false`，流式响应原样转发，上游报错在流开始前转成 400 与「百炼返回：...」文案，整体超时 300 秒。
- `POST /api/bailian/upload` — 参考视频/音频走 getPolicy → OSS 表单两步上传，返回 48 小时有效的 `oss://` 链接。
- `POST /api/bailian/video/trim` — 视频复刻用：网关本机 ffmpeg 把选中区间（1~15 秒）重编码成 mp4，再作为 `reference_video` 上传，返回 `oss://` 链接。
- `POST /api/bailian/video/mux-audio` — 视频复刻用：把原片段音轨混回 wan3.0 的无声结果（`-c:v copy -c:a aac -shortest`），模型侧没有沿用原音轨的参数。

两个 ffmpeg 端点需要网关容器或本机存在 `ffmpeg`（可用 `FFMPEG_PATH` 指定路径），缺失时返回中文提示。
- `POST /api/bailian/video/tasks` — 提交 wan3.0 视频生成任务（校验素材组合限制，需要时带 `X-DashScope-OssResourceResolve`）；`GET /api/bailian/video/tasks/{id}` 查询状态；`GET /api/bailian/video/result?url=` 由网关代理下载结果（链接 24 小时过期且跨域，仅允许 aliyuncs.com 域名）。

## 与画布的对接

渠道编辑器里协议选 ComfyUI 或阿里云百炼，接口地址都填本网关（开发默认 `http://127.0.0.1:8787`）。ComfyUI 渠道选中的“模型”即工作流（id 对应本服务的工作流记录），提示词、参考图、参考视频按绑定表注入；超时默认图片 10 分钟、视频 40 分钟、查询间隔 30 秒，可逐个工作流覆盖。百炼渠道的模型为手动填写的 DashScope 模型名：视频生成填 `wan3.0-video`（能力设为视频），文本与图像理解填 `qwen3.8-flash`（能力设为文本；前端把送分析的图片压到 50 万像素以内、视频先抽帧再提交），画布视频节点连线图片/视频/音频后按「图N/视频N/音频N」顺序作为参考素材提交；百炼任务轮询间隔 15 秒、超时 40 分钟，素材超限在上传前直接报错。
