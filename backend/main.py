"""Infinite Canvas gateway: the browser's door to ComfyUI and Bailian (DashScope).

Run:  uvicorn main:app --port 8787   (or: python main.py)
"""
import json
import time
import uuid
from typing import Any

from fastapi import FastAPI, File, Form, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import bailian
import comfy
import store

app = FastAPI(title="infinite-canvas-gateway")


@app.exception_handler(comfy.ComfyError)
async def comfy_error_handler(_request: Request, error: comfy.ComfyError):
    return _error_response(error.detail or error.code)


@app.exception_handler(bailian.BailianError)
async def bailian_error_handler(_request: Request, error: bailian.BailianError):
    return _error_response(error.detail or error.code)


def _error_response(detail: str) -> Response:
    return Response(status_code=400, content=json.dumps({"detail": detail}, ensure_ascii=False), media_type="application/json")


class ServerConfig(BaseModel):
    url: str = ""
    apiKey: str | None = None


class WorkflowInput(BaseModel):
    name: str = ""
    apiJson: dict[str, Any]


class WorkflowUpdate(BaseModel):
    name: str | None = None
    bindings: list[dict[str, Any]] | None = None
    imageTimeoutSeconds: int | None = None
    videoTimeoutSeconds: int | None = None
    pollIntervalSeconds: int | None = None


class RunInput(BaseModel):
    workflowId: str
    prompt: str = ""
    images: list[str] = []
    video: str = ""
    audio: str = ""
    width: int = 0
    height: int = 0


@app.get("/api/comfy/server")
async def get_server():
    config = store.load_server()
    return {"url": config.get("url", ""), "hasApiKey": bool(config.get("apiKey"))}


@app.put("/api/comfy/server")
async def put_server(body: ServerConfig):
    return {"url": store.save_server(body.url, body.apiKey)["url"]}


@app.post("/api/comfy/server/test")
async def post_server_test():
    return await comfy.test_server(store.load_server())


@app.get("/api/comfy/workflows")
async def get_workflows():
    return store.list_workflows()


@app.post("/api/comfy/workflows")
async def post_workflow(body: WorkflowInput):
    scan = comfy.scan_workflow(body.apiJson)
    workflow_id = uuid.uuid4().hex[:12]
    record = {
        "id": workflow_id,
        "name": body.name.strip() or f"工作流 {workflow_id}",
        "capability": scan["capability"],
        "candidates": scan["candidates"],
        "bindings": comfy.default_bindings(scan["candidates"]),
        "imageTimeoutSeconds": 600,
        "videoTimeoutSeconds": 2400,
        "pollIntervalSeconds": 30,
        "createdAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "apiJson": body.apiJson,
    }
    store.save_workflow(record)
    return _workflow_detail(record)


@app.put("/api/comfy/workflows/{workflow_id}")
async def put_workflow(workflow_id: str, body: WorkflowUpdate):
    record = store.get_workflow(workflow_id)
    if not record:
        return Response(status_code=404, content='{"detail":"工作流不存在"}', media_type="application/json")
    if body.bindings is not None:
        by_node = {candidate["nodeId"]: candidate for candidate in record["candidates"]}
        bindings = []
        for binding in body.bindings:
            candidate = by_node.get(str(binding.get("nodeId")))
            if not candidate:
                continue
            bindings.append({**candidate, **binding, "field": candidate["field"], "kind": candidate["kind"], "sizeRole": candidate.get("sizeRole", "")})
        record["bindings"] = bindings
    if body.name:
        record["name"] = body.name.strip()
    if body.imageTimeoutSeconds is not None:
        record["imageTimeoutSeconds"] = max(30, body.imageTimeoutSeconds)
    if body.videoTimeoutSeconds is not None:
        record["videoTimeoutSeconds"] = max(60, body.videoTimeoutSeconds)
    if body.pollIntervalSeconds is not None:
        record["pollIntervalSeconds"] = max(5, body.pollIntervalSeconds)
    store.save_workflow(record)
    return _workflow_detail(record)


@app.delete("/api/comfy/workflows/{workflow_id}")
async def delete_workflow(workflow_id: str):
    return {"deleted": store.delete_workflow(workflow_id)}


@app.post("/api/comfy/upload")
async def post_upload(file: UploadFile = File(...), subfolder: str = Form("")):
    content = await file.read()
    return await comfy.upload_media(store.load_server(), content, file.filename or "input.bin", subfolder)


@app.post("/api/comfy/run")
async def post_run(body: RunInput):
    workflow = store.get_workflow(body.workflowId)
    if not workflow:
        raise comfy.ComfyError("workflow_not_found")
    task_id = await comfy.submit_prompt(store.load_server(), workflow, body.prompt, body.images, body.video, body.width, body.height, body.audio)
    return {"taskId": task_id, "timeoutSeconds": workflow["imageTimeoutSeconds"] if workflow["capability"] == "image" else workflow["videoTimeoutSeconds"], "pollIntervalSeconds": workflow["pollIntervalSeconds"]}


@app.get("/api/comfy/task/{task_id}")
async def get_task(task_id: str):
    return await comfy.task_status(store.load_server(), task_id)


@app.get("/api/comfy/output")
async def get_output(subfolder: str = "", filename: str = ""):
    content, content_type = await comfy.view_file(store.load_server(), subfolder, filename)
    return Response(content=content, media_type=content_type)


def _workflow_detail(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if key != "apiJson"}


# ---- bailian (DashScope) endpoints ----


class BailianServerConfig(BaseModel):
    url: str = ""
    apiKey: str | None = None


class BailianChatInput(BaseModel):
    model: str
    messages: list[dict[str, Any]]
    stream: bool = True
    temperature: float | None = None
    max_tokens: int | None = None
    # 非 OpenAI 标准参数：qwen3.8 系列默认开启思考，反推提示词这类场景要能显式关掉。
    enable_thinking: bool | None = None


class BailianVideoInput(BaseModel):
    model: str
    prompt: str = ""
    media: list[dict[str, Any]] = []
    parameters: dict[str, Any] = {}


@app.get("/api/bailian/server")
async def get_bailian_server():
    config = store.load_bailian()
    return {"url": config.get("url", ""), **bailian.mask_api_key(config.get("apiKey", ""))}


@app.put("/api/bailian/server")
async def put_bailian_server(body: BailianServerConfig):
    return {"url": store.save_bailian(body.url, body.apiKey)["url"]}


@app.post("/api/bailian/server/test")
async def post_bailian_server_test():
    return await bailian.test_server(store.load_bailian())


@app.post("/api/bailian/upload")
async def post_bailian_upload(file: UploadFile = File(...), model: str = Form("wan3.0-video")):
    content = await file.read()
    return {"url": await bailian.upload_media(store.load_bailian(), content, file.filename or "input.bin", model)}


@app.post("/api/bailian/chat/completions")
async def post_bailian_chat(body: BailianChatInput):
    media_type, stream = await bailian.chat_completions(store.load_bailian(), body.model_dump(exclude_none=True))
    return StreamingResponse(stream, media_type=media_type)


@app.post("/api/bailian/video/tasks")
async def post_bailian_video_task(body: BailianVideoInput):
    task_id = await bailian.create_video_task(store.load_bailian(), body.model, body.prompt, body.media, body.parameters)
    return {"taskId": task_id}


@app.post("/api/bailian/video/trim")
async def post_bailian_video_trim(file: UploadFile = File(...), start: float = Form(0), end: float = Form(0), model: str = Form("wan3.0-video")):
    # 用网关本机 ffmpeg 裁出选中区间，再作为 wan3.0 的参考视频上传，返回 oss:// 临时链接。
    clip = await bailian.trim_video(await file.read(), start, end)
    return {"url": await bailian.upload_media(store.load_bailian(), clip, "reference-clip.mp4", model)}


@app.post("/api/bailian/video/mux-audio")
async def post_bailian_video_mux(result: UploadFile = File(...), source: UploadFile = File(...), start: float = Form(0), end: float = Form(0)):
    content = await bailian.mux_audio(await result.read(), await source.read(), start, end)
    return Response(content=content, media_type="video/mp4")


@app.get("/api/bailian/video/tasks/{task_id}")
async def get_bailian_video_task(task_id: str):
    return await bailian.task_status(store.load_bailian(), task_id)


@app.delete("/api/bailian/video/tasks/{task_id}")
async def delete_bailian_video_task(task_id: str):
    return {"status": await bailian.cancel_task(store.load_bailian(), task_id)}


@app.get("/api/bailian/video/result")
async def get_bailian_video_result(url: str):
    content, content_type = await bailian.download_result(url)
    return Response(content=content, media_type=content_type)


def _cors_origins() -> list[str]:
    import os

    # 默认放行跨域，便于开发时浏览器直连 127.0.0.1 网关（与本地代理同等的安全姿态，且网关默认只听本机）。
    # 需要收紧时设 COMFY_GATEWAY_ORIGINS 逗号分隔；留空即全放行。
    return [origin for origin in os.environ.get("COMFY_GATEWAY_ORIGINS", "").split(",") if origin] or ["*"]


app.add_middleware(CORSMiddleware, allow_origins=_cors_origins(), allow_methods=["*"], allow_headers=["*"])


def main():
    import os

    import uvicorn

    uvicorn.run(app, host=os.environ.get("COMFY_GATEWAY_HOST", "127.0.0.1"), port=int(os.environ.get("COMFY_GATEWAY_PORT", "8787")))


if __name__ == "__main__":
    main()
