// 视频复刻的边界值与提示词绑定：wan3.0 的参考片段和输出视频共享 30 秒额度，素材编号必须和画布 @ 引用一致。

/** wan3.0 reference_video：单个片段 1~15 秒。 */
export const CLIP_MIN_SECONDS = 1;
export const CLIP_MAX_SECONDS = 15;
/** wan3.0 duration：2~30 秒，且「输入片段 + 输出时长」不超过 30 秒。 */
export const OUTPUT_MIN_SECONDS = 2;
export const OUTPUT_MAX_SECONDS = 30;

export function clampClipRange(start: number, end: number, duration: number) {
    const limit = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
    const safeStart = Math.max(0, Math.min(start, limit - CLIP_MIN_SECONDS));
    const safeEnd = Math.max(safeStart + CLIP_MIN_SECONDS, Math.min(end, safeStart + CLIP_MAX_SECONDS, limit));
    return { start: Number(safeStart.toFixed(2)), end: Number(safeEnd.toFixed(2)) };
}

export function maxOutputSeconds(clipSeconds: number) {
    return Math.max(OUTPUT_MIN_SECONDS, Math.min(OUTPUT_MAX_SECONDS, Math.floor(OUTPUT_MAX_SECONDS - clipSeconds)));
}

/** 按参考片段上限把整条视频自动分段，覆盖全片；时长未知时先给一段占位。 */
export function splitVideoSegments(duration: number) {
    if (!(duration > 0)) return [{ start: 0, end: CLIP_MAX_SECONDS }];
    const count = Math.ceil(duration / CLIP_MAX_SECONDS);
    return Array.from({ length: count }, (_, index) => ({ start: Number(((index * duration) / count).toFixed(2)), end: Number(Math.min(duration, ((index + 1) * duration) / count).toFixed(2)) }));
}

export function formatClipTime(seconds: number) {
    const total = Math.max(0, seconds);
    const minutes = Math.floor(total / 60);
    return `${String(minutes).padStart(2, "0")}:${(total - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

/** 把 AI 写出的「图N / 视频N」换成画布 @ 引用；配置节点生成时会按连线顺序还原成同样的编号。 */
export function bindClonePrompt(prompt: string, imageNodeIds: string[], sourceNodeId: string) {
    const withImages = prompt.replace(/图片?(\d+)/g, (match, digits: string) => {
        const nodeId = imageNodeIds[Number(digits) - 1];
        return nodeId ? `@[node:${nodeId}]` : match;
    });
    return withImages.replace(/视频(\d+)/g, `@[node:${sourceNodeId}]`);
}
