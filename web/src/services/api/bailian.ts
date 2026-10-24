import axios from "axios";

import i18n from "@/i18n";
import { compressImageForAnalysis } from "@/lib/vision-input";
import { decodeChannelModel, type AiConfig } from "@/stores/use-config-store";
import { gateway } from "./comfyui";

type RequestOptions = { signal?: AbortSignal; stream?: boolean };
const bailianText = (key: string, options?: Record<string, unknown>) => i18n.t(`bailianErrors.${key}`, options);

/** wan3.0 limits mirrored from the docs, so over-limit input fails before any upload is paid for. */
const MAX_REFERENCE_IMAGES = 10;
const MAX_REFERENCE_VIDEO_AUDIO = 5;
const MAX_MEDIA_TOTAL = 20;
const MAX_MEDIA_SECONDS = 15;
const MAX_TOTAL_OUTPUT_SECONDS = 30; // input video + output duration must fit in this window
const TASK_TIMEOUT_MINUTES = 40;
const POLL_INTERVAL_MS = 15000;

export type BailianVideoSettings = {
    resolution: string;
    ratio: string;
    duration: number;
    audio: boolean;
    watermark: boolean;
};

function bailianError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return new Error(bailianText("canceled"));
    if (axios.isAxiosError(error) && !error.response) return new Error(fallback);
    const detail = axios.isAxiosError(error) ? error.response?.data?.detail || error.message : String(error);
    return new Error(detail || fallback);
}

/** Resolve the bailian channel behind a model value; null when the model belongs to another channel. */
export function resolveBailianChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return null;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    if (channel?.apiFormat !== "bailian") return null;
    return { gatewayUrl: channel.baseUrl, model: decoded.model };
}

export async function getBailianServer(gatewayUrl: string) {
    try {
        const { data } = await axios.get<{ url: string; hasApiKey: boolean; keyPreview: string; keyWasCleaned: boolean }>(`${gateway(gatewayUrl)}/api/bailian/server`);
        return data;
    } catch (error) {
        throw bailianError(error, bailianText("gatewayUnreachable"));
    }
}

export async function saveBailianServer(gatewayUrl: string, url: string, apiKey: string | null) {
    try {
        await axios.put(`${gateway(gatewayUrl)}/api/bailian/server`, { url, apiKey });
    } catch (error) {
        throw bailianError(error, bailianText("gatewayUnreachable"));
    }
}

/** 取消云端异步任务：只有还没开始生成的取消得掉，已开始的任务仍会跑完并计费。 */
export async function cancelBailianVideoTask(gatewayUrl: string, taskId: string) {
    const { data } = await axios.delete<{ status: string }>(`${gateway(gatewayUrl)}/api/bailian/video/tasks/${taskId}`);
    return data.status;
}

export async function testBailianServer(gatewayUrl: string) {
    try {
        await axios.post(`${gateway(gatewayUrl)}/api/bailian/server/test`);
        return bailianText("serverReady");
    } catch (error) {
        throw bailianError(error, bailianText("serverUnreachable"));
    }
}

export type BailianChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type BailianChatMessage = { role: "system" | "user" | "assistant"; content: string | BailianChatContentPart[] };

/**
 * 百炼文本/视觉模型（如 qwen3.8-flash）走网关的 OpenAI 兼容代理：API Key 不进浏览器。
 * 百炼对单图像素和 DashScope 域名请求体（16MiB）都有硬限制，所以先把 data URL 图片压到上限内；
 * 反推提示词要的是成品文本，qwen3.8 系列默认开启的思考模式在这里显式关掉。
 */
export async function requestBailianChat(config: AiConfig, messages: BailianChatMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const stream = options?.stream !== false;
    let response: Response;
    try {
        response = await fetch(`${gateway(config.baseUrl)}/api/bailian/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: config.model, stream, enable_thinking: false, messages: await Promise.all(messages.map(compressChatMessage)) }),
            signal: options?.signal,
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error(bailianText("gatewayUnreachable"));
    }
    if (!response.ok) throw new Error(await readChatError(response));

    let text = "";
    if (stream && response.headers.get("content-type")?.includes("text/event-stream") && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || "";
            for (const block of blocks) text += readChatDelta(block);
            onDelta(text);
        }
        text += readChatDelta(buffer);
    } else {
        const payload = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }> };
        text = payload.choices?.[0]?.message?.content || "";
    }
    const answer = text.trim() || bailianText("noContent");
    onDelta(answer);
    return answer;
}

async function compressChatMessage(message: BailianChatMessage): Promise<BailianChatMessage> {
    if (typeof message.content === "string") return message;
    const parts = await Promise.all(
        message.content.map(async (part): Promise<BailianChatContentPart> => {
            if (part.type !== "image_url") return part;
            const url = await compressImageForAnalysis(part.image_url.url);
            // blob: 之类的本地地址服务端读不到，提前报中文错，避免百炼只回一句 InvalidParameter 的 URL 提示。
            if (!url.startsWith("data:") && !/^https?:\/\//i.test(url)) throw new Error(bailianText("imageUnreachable"));
            return { type: "image_url", image_url: { url } };
        }),
    );
    return { ...message, content: parts };
}

function readChatDelta(block: string) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
    if (!data || data === "[DONE]") return "";
    try {
        const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = chunk.choices?.[0]?.delta?.content;
        return typeof delta === "string" ? delta : "";
    } catch {
        return "";
    }
}

async function readChatError(response: Response) {
    try {
        const payload = (await response.json()) as { detail?: string; error?: { message?: string } };
        return payload.detail || payload.error?.message || bailianText("chatFailed");
    } catch {
        return bailianText("chatFailed");
    }
}

export type BailianClipRange = { start: number; end: number };

/** 复刻用的参考视频必须先裁到选中区间；reference_video 不收 Base64，所以裁剪与上传在网关一次完成。 */
async function trimAndUploadMedia(gatewayUrl: string, model: string, file: File, clip: BailianClipRange) {
    const form = new FormData();
    form.append("file", file);
    form.append("model", model);
    form.append("start", String(clip.start));
    form.append("end", String(clip.end));
    try {
        const { data } = await axios.post<{ url: string }>(`${gatewayUrl}/api/bailian/video/trim`, form, { timeout: 300000 });
        return data.url;
    } catch (error) {
        throw bailianError(error, bailianText("trimFailed"));
    }
}

/** wan3.0 没有「沿用原音轨」的参数，只能生成后用网关 ffmpeg 把片段声音混回去。 */
export async function muxOriginalAudio(gatewayUrl: string, result: Blob, source: File, clip: BailianClipRange) {
    const form = new FormData();
    form.append("result", new File([result], "result.mp4", { type: "video/mp4" }));
    form.append("source", source);
    form.append("start", String(clip.start));
    form.append("end", String(clip.end));
    try {
        const { data } = await axios.post<Blob>(`${gatewayUrl}/api/bailian/video/mux-audio`, form, { responseType: "blob", timeout: 300000 });
        return data;
    } catch (error) {
        // responseType=blob 时错误体也是 Blob，要读出来才能拿到网关的中文 detail。
        if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
            const blob = error.response.data;
            try {
                const payload = JSON.parse(await blob.text()) as { detail?: string };
                throw new Error(payload.detail || bailianText("muxFailed"));
            } catch (readError) {
                if (readError instanceof Error && readError.message !== bailianText("muxFailed")) throw readError;
                throw new Error(bailianText("muxFailed"));
            }
        }
        throw bailianError(error, bailianText("muxFailed"));
    }
}

type BailianMedia = { type: string; url: string };

/** Upload one reference video/audio to Bailian temp storage and get back its oss:// url. */
async function uploadMedia(base: string, model: string, file: File) {
    const form = new FormData();
    form.append("file", file);
    form.append("model", model);
    try {
        const { data } = await axios.post<{ url: string }>(`${base}/api/bailian/upload`, form, { timeout: 300000 });
        return data.url;
    } catch (error) {
        throw bailianError(error, bailianText("uploadFailed"));
    }
}

function assertReferenceLimits(imageCount: number, videoCount: number, audioCount: number, mediaSeconds: number) {
    if (imageCount > MAX_REFERENCE_IMAGES) throw new Error(bailianText("tooManyImages", { max: MAX_REFERENCE_IMAGES }));
    if (videoCount > MAX_REFERENCE_VIDEO_AUDIO) throw new Error(bailianText("tooManyVideoAudio", { max: MAX_REFERENCE_VIDEO_AUDIO }));
    if (audioCount > MAX_REFERENCE_VIDEO_AUDIO) throw new Error(bailianText("tooManyVideoAudio", { max: MAX_REFERENCE_VIDEO_AUDIO }));
    if (imageCount + videoCount + audioCount > MAX_MEDIA_TOTAL) throw new Error(bailianText("tooManyMedia", { max: MAX_MEDIA_TOTAL }));
    if (mediaSeconds > MAX_MEDIA_SECONDS) throw new Error(bailianText("mediaTooLong", { seconds: MAX_MEDIA_SECONDS }));
}

function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new DOMException("Aborted", "AbortError"))), { once: true });
    });
}

/**
 * Submit a wan3.0 task and return the downloaded video blob.
 * mode "frames": the first two images become first/last frame (reference video/audio must be empty).
 * mode "reference": every input becomes reference_* in canvas order, matching 图N/视频N/音频N in the prompt.
 */
export async function requestBailianVideo(
    base: string,
    model: string,
    prompt: string,
    mode: "frames" | "reference",
    inputs: { images: Array<{ dataUrl: string }>; videos: File[]; audios: File[]; videoSeconds: number[]; audioSeconds: number[]; clip?: BailianClipRange },
    settings: BailianVideoSettings,
    options?: RequestOptions,
): Promise<Blob> {
    const gatewayUrl = gateway(base);
    let media: BailianMedia[] = [];
    // wan3.0 wants an integer duration in [2, 30]; canvas seconds is already clamped to that range upstream.
    const duration = Math.max(2, Math.min(MAX_TOTAL_OUTPUT_SECONDS, Math.round(settings.duration)));
    const parameters: Record<string, unknown> = { resolution: settings.resolution, ratio: settings.ratio, audio: settings.audio, watermark: settings.watermark, prompt_extend: true };
    if (mode === "frames" && inputs.images.length) {
        media = [{ type: "first_frame", url: inputs.images[0].dataUrl }];
        if (inputs.images[1]) media.push({ type: "last_frame", url: inputs.images[1].dataUrl });
        parameters.duration = duration;
    } else if (inputs.images.length || inputs.videos.length || inputs.audios.length) {
        const mediaSeconds = inputs.videoSeconds.reduce((sum, seconds) => sum + seconds, 0) + inputs.audioSeconds.reduce((sum, seconds) => sum + seconds, 0);
        assertReferenceLimits(inputs.images.length, inputs.videos.length, inputs.audios.length, mediaSeconds);
        const videoUrls = await Promise.all(inputs.videos.map((file) => (inputs.clip ? trimAndUploadMedia(gatewayUrl, model, file, inputs.clip) : uploadMedia(gatewayUrl, model, file))));
        const audioUrls = await Promise.all(inputs.audios.map((file) => uploadMedia(gatewayUrl, model, file)));
        media = [
            ...inputs.images.map((image) => ({ type: "reference_image", url: image.dataUrl })),
            ...videoUrls.map((url) => ({ type: "reference_video", url })),
            ...audioUrls.map((url) => ({ type: "reference_audio", url })),
        ];
        // With reference videos, input video + output video must stay within the documented 30s window.
        const videoSeconds = inputs.videoSeconds.reduce((sum, seconds) => sum + seconds, 0);
        parameters.duration = Math.max(2, Math.min(duration, MAX_TOTAL_OUTPUT_SECONDS - Math.ceil(videoSeconds)));
    } else {
        parameters.duration = duration;
    }
    if (!prompt.trim() && !media.length) throw new Error(bailianText("emptyInput"));

    let taskId: string;
    try {
        const { data } = await axios.post<{ taskId: string }>(`${gatewayUrl}/api/bailian/video/tasks`, { model, prompt, media, parameters }, { signal: options?.signal });
        taskId = data.taskId;
    } catch (error) {
        throw bailianError(error, bailianText("runFailed"));
    }
    // 画布点「停止」只会中断前端轮询，云端任务会继续跑完并计费，所以这里在取消信号到来时真的撤销任务。
    let settled = false;
    const cancelOnAbort = () => {
        if (settled) return;
        settled = true;
        void cancelBailianVideoTask(gatewayUrl, taskId).catch(() => undefined);
    };
    options?.signal?.addEventListener("abort", cancelOnAbort, { once: true });
    const deadline = Date.now() + TASK_TIMEOUT_MINUTES * 60 * 1000;
    for (;;) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        let state: { status: string; videoUrl?: string; error?: string };
        try {
            const { data } = await axios.get(`${gatewayUrl}/api/bailian/video/tasks/${taskId}`, { signal: options?.signal });
            state = data;
        } catch (error) {
            throw bailianError(error, bailianText("taskQueryFailed"));
        }
        if (state.status === "failed") {
            settled = true;
            throw new Error(state.error || bailianText("taskFailed"));
        }
        if (state.status === "completed" && state.videoUrl) {
            settled = true;
            try {
                // The result link expires in 24h and is not readable cross-origin, so the gateway proxies the bytes.
                const { data } = await axios.get<Blob>(`${gatewayUrl}/api/bailian/video/result`, { params: { url: state.videoUrl }, responseType: "blob", timeout: 300000, signal: options?.signal });
                return data;
            } catch (error) {
                throw bailianError(error, bailianText("outputDownloadFailed"));
            }
        }
        if (Date.now() >= deadline) {
            settled = true;
            throw new Error(bailianText("taskTimeout", { minutes: TASK_TIMEOUT_MINUTES }));
        }
        await sleep(POLL_INTERVAL_MS, options?.signal);
    }
}
