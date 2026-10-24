// 送视觉模型分析前的素材处理：图片压缩到像素上限，视频按时间均匀抽帧，避免超限被拒或白烧 token。
import i18n from "@/i18n";
import { waitForVideo } from "@/lib/canvas/canvas-video-frame";
import { getDataUrlByteSize } from "@/lib/image-utils";
import { resolveMediaUrl } from "@/services/file-storage";
import type { ReferenceVideo } from "@/types/media";

/** 单张图长宽像素乘积上限，超出按比例缩小（百炼图像/视频理解的输入限制）。 */
export const MAX_ANALYSIS_PIXELS = 500_000;
const ANALYSIS_JPEG_QUALITY = 0.82;
// 视频抽帧节奏：每 2 秒一帧，最少 4 帧（qwen3.8 图像列表下限）、最多 12 帧。
const SECONDS_PER_FRAME = 2;
const MIN_FRAMES = 4;
const MAX_FRAMES = 12;

export type VideoFrameSample = { time: number; dataUrl: string };
export type VideoAnalysisInput = { duration: number; frames: VideoFrameSample[] };

// 同一份视频在多路文本输出或重试时不重复解码，只保留最近 4 份抽帧结果。
const frameCache = new Map<string, Promise<VideoAnalysisInput>>();

export function fitAnalysisPixels(width: number, height: number) {
    const safeWidth = Math.max(1, Math.round(width));
    const safeHeight = Math.max(1, Math.round(height));
    const pixels = safeWidth * safeHeight;
    if (pixels <= MAX_ANALYSIS_PIXELS) return { width: safeWidth, height: safeHeight };
    const scale = Math.sqrt(MAX_ANALYSIS_PIXELS / pixels);
    return { width: Math.max(1, Math.floor(safeWidth * scale)), height: Math.max(1, Math.floor(safeHeight * scale)) };
}

/** 等比压缩成 JPEG dataURL；只在体积确实变小时替换，避免小图被无谓重编码。 */
export async function compressImageForAnalysis(dataUrl: string) {
    if (!dataUrl.startsWith("data:image/")) return dataUrl;
    const image = await loadImage(dataUrl);
    const { width, height } = fitAnalysisPixels(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const encoded = canvas.toDataURL("image/jpeg", ANALYSIS_JPEG_QUALITY);
    return getDataUrlByteSize(encoded) < getDataUrlByteSize(dataUrl) ? encoded : dataUrl;
}

/** 视频按时序抽帧并逐帧压缩到像素上限，返回总时长与带时间点的帧，模型才能标出对得上的分镜时间轴。 */
export async function extractVideoFramesForAnalysis(video: ReferenceVideo, options?: { range?: { start: number; end: number }; maxFrames?: number }): Promise<VideoAnalysisInput> {
    const range = options?.range;
    const source = await resolveMediaUrl(video.storageKey, video.url);
    if (!source) throw new Error(i18n.t("vision.videoMissing"));
    const cacheKey = range ? `${source}:${range.start.toFixed(2)}-${range.end.toFixed(2)}:${options?.maxFrames || 0}` : source;
    const cached = frameCache.get(cacheKey);
    if (cached) return cached;
    const pending = sampleFrames(video, source, range, options?.maxFrames).catch((error) => {
        if (frameCache.get(cacheKey) === pending) frameCache.delete(cacheKey);
        throw error;
    });
    frameCache.set(cacheKey, pending);
    if (frameCache.size > 4) frameCache.delete(frameCache.keys().next().value as string);
    return pending;
}

async function sampleFrames(video: ReferenceVideo, source: string, range?: { start: number; end: number }, maxFrames?: number): Promise<VideoAnalysisInput> {
    const element = document.createElement("video");
    element.crossOrigin = "anonymous";
    element.muted = true;
    element.playsInline = true;
    element.preload = "auto";
    try {
        element.src = source;
        element.load();
        await waitForVideo(element, "loadedmetadata");
        const total = await resolveVideoDuration(element, video);
        const from = range ? Math.max(0, Math.min(range.start, total || range.start)) : 0;
        const duration = range ? Math.max(0.1, Math.min(range.end, total || range.end) - from) : total;
        const frameCount = duration > 0 ? Math.min(maxFrames || MAX_FRAMES, Math.max(MIN_FRAMES, Math.round(duration / SECONDS_PER_FRAME))) : MIN_FRAMES;
        const frameTimes = duration > 0 ? Array.from({ length: frameCount }, (_, index) => from + ((index + 0.5) * duration) / frameCount) : [0, 0.5, 1, 1.5];
        const { width, height } = fitAnalysisPixels(element.videoWidth, element.videoHeight);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d")!;
        const frames: VideoFrameSample[] = [];
        for (const time of frameTimes) {
            const target = duration > 0 ? Math.min(duration - 0.001, time) : time;
            // 只有目标时间真的变了才 seek；探时长时 seek 到的末尾位置也靠这里纠正回来。
            if (Math.abs(element.currentTime - target) > 0.01) {
                const seeked = waitForVideo(element, "seeked");
                element.currentTime = target;
                await seeked;
            } else if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
                await waitForVideo(element, "loadeddata");
            }
            context.drawImage(element, 0, 0, width, height);
            // 浏览器会把 seek 裁剪到真实时长，取 currentTime 作为该帧的实际时间点。
            frames.push({ time: Number.isFinite(element.currentTime) ? element.currentTime : time, dataUrl: canvas.toDataURL("image/jpeg", ANALYSIS_JPEG_QUALITY) });
        }
        return { duration, frames };
    } catch {
        throw new Error(i18n.t("vision.frameFailed"));
    } finally {
        element.removeAttribute("src");
        element.load();
    }
}

// 部分浏览器要先 seek 一次才解析出 duration，取不到时退回节点记录的毫秒时长。
async function resolveVideoDuration(element: HTMLVideoElement, video: ReferenceVideo) {
    if (Number.isFinite(element.duration) && element.duration > 0) return element.duration;
    const seeked = waitForVideo(element, "seeked").catch(() => undefined);
    element.currentTime = 1_000_000;
    await seeked;
    if (Number.isFinite(element.duration) && element.duration > 0) return element.duration;
    return (video.durationMs || 0) / 1000;
}

function loadImage(source: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(i18n.t("vision.imageFailed")));
        image.src = source;
    });
}
