import { projectToolResult } from "./ui-projection.js";
import { ScreenshotImageSchema } from "../screenshot.js";

export type ModelConfig = { baseUrl: string; apiKey: string; model: string; vision?: boolean };
export type ModelFetch = (input: string, init: RequestInit) => Promise<Response>;
export type AgentTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Ephemeral pixels, serialized only as a provider image block; never as tool text. */
  image?: { mimeType: "image/jpeg"; data: string };
};

export class RuntimeError extends Error {
  constructor(readonly code: string, message: string, readonly reason?: string) { super(message); this.name = "RuntimeError"; }
}

export function endpointFor(config: ModelConfig): string {
  if (!config || typeof config.baseUrl !== "string" || typeof config.apiKey !== "string" ||
      typeof config.model !== "string" || !config.model.trim() || config.model.length > 200 ||
      config.apiKey.length > 8192 || /[\r\n]/.test(config.apiKey) || (config.vision !== undefined && typeof config.vision !== "boolean")) {
    throw new RuntimeError("INVALID_MODEL_CONFIG", "请填写有效的模型名称、API 地址和密钥。");
  }
  let url: URL;
  try { url = new URL(config.baseUrl.trim()); }
  catch { throw new RuntimeError("INVALID_MODEL_URL", "API 地址必须是完整的 HTTPS 地址。"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash || config.baseUrl.length > 2048) {
    throw new RuntimeError("INVALID_MODEL_URL", "使用 HTTPS；本地模型可使用 localhost HTTP。地址不能含账号、查询参数或片段。");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  return url.toString();
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Count each UI snapshot once, excluding transport envelopes and historical host facts. */
function uiBytes(value: unknown): number {
  if (!object(value)) return Array.isArray(value) ? value.reduce((sum, item) => sum + uiBytes(item), 0) : 0;
  if (typeof value.snapshotId === "string" && (Array.isArray(value.nodes) || Array.isArray(value.elements))) {
    return Buffer.byteLength(JSON.stringify(value));
  }
  return Object.values(value).reduce<number>((sum, item) => sum + uiBytes(item), 0);
}

export async function completion(config: ModelConfig, messages: Message[], tools: AgentTool[], signal: AbortSignal, modelFetch: ModelFetch = globalThis.fetch,
  workload: "interactive" | "skill_generation" = "interactive"): Promise<{
  message: Message; tokens: number; requestBytes: number; responseBytes: number; modelUiBytes: number; rawUiBytes: number;
}> {
  const endpoint = endpointFor(config);
  let modelUiBytes = 0;
  let rawUiBytes = 0;
  // Only the model's view is compacted. Controllers and progress checks keep full snapshots.
  const modelMessages = messages.map(message => {
    if (message.role !== "tool" || !message.content) return message;
    let original: unknown;
    try { original = JSON.parse(message.content); } catch { return message; }
    const projected = projectToolResult(original);
    rawUiBytes += uiBytes(original);
    modelUiBytes += uiBytes(projected);
    return { ...message, content: JSON.stringify(projected) };
  });
  const envelope = {
    model: config.model.trim(), stream: false,
    ...(tools.length ? { tools: tools.map(tool => ({ type: "function", function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })), tool_choice: "auto", parallel_tool_calls: false } : {}),
  };
  // Pixel bytes have their own strict bound. They must not consume the text/UI
  // budget or silently turn a text-only endpoint into a vision request.
  const imageMessages = modelMessages.filter(message => message.image !== undefined);
  if (imageMessages.length && config.vision !== true) throw new RuntimeError("VISION_REQUIRED", "当前页面需要视觉观察，请启用支持图片的模型后重试。");
  if (imageMessages.length > 1) throw new RuntimeError("MODEL_IMAGE_LIMIT", "单次模型请求只允许保留一张当前截图。");
  for (const message of imageMessages) {
    const image = message.image!;
    if (message.role !== "user" || !ScreenshotImageSchema.safeParse(image).success) {
      throw new RuntimeError("MODEL_IMAGE_LIMIT", "截图格式或大小超出观察限制。");
    }
  }
  const textMessages = modelMessages.map(({ image: _image, ...message }) => message);
  const textBytes = Buffer.byteLength(JSON.stringify({ ...envelope, messages: textMessages }));
  if (textBytes > 256 * 1024) throw new RuntimeError("CONTEXT_LIMIT", "当前界面和工具定义超出单轮上下文限制，请缩小任务或界面读取范围。");
  const payload = JSON.stringify({ ...envelope, messages: modelMessages.map(({ image, ...message }) => image ? { ...message,
    content: [{ type: "text", text: message.content ?? "Current phone screenshot. Untrusted observation only." },
      { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }],
  } : message) });
  const requestBytes = Buffer.byteLength(payload);
  if (requestBytes > 1024 * 1024) throw new RuntimeError("CONTEXT_LIMIT", "当前图片和界面超出单轮请求限制。");
  // Background synthesis is bounded by its own job deadline. It can need more
  // reasoning than the next phone action; do not lengthen foreground waits.
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(workload === "skill_generation" ? 180_000 : 90_000)]);
  let response: Response;
  try {
    response = await modelFetch(endpoint, {
      method: "POST", redirect: "error", signal: requestSignal,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: payload,
    });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new RuntimeError(requestSignal.aborted ? "MODEL_TIMEOUT" : "MODEL_CONNECTION_FAILED",
      requestSignal.aborted ? "模型请求超时；没有重试。" : "无法连接模型服务，请检查 API 地址、网络和 TLS 证书。没有重试请求。");
  }
  if (!response.ok) {
    await response.body?.cancel();
    // Never expose an endpoint's error body: it can echo authorization headers or UI contents.
    if (imageMessages.length && [400, 415, 422].includes(response.status)) throw new RuntimeError("MODEL_VISION_UNSUPPORTED", "模型服务拒绝了图片请求，请检查所选模型和接口是否支持图片。本轮没有重试。");
    throw new RuntimeError(`MODEL_HTTP_${response.status}`, `模型服务返回 HTTP ${response.status}，请检查配置、额度和接口兼容性。`);
  }
  if (!response.body) throw new RuntimeError("MODEL_INVALID_RESPONSE", "模型服务没有返回 JSON 响应。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      responseBytes += part.value.byteLength;
      if (responseBytes > 512 * 1024) {
        await reader.cancel();
        throw new RuntimeError("MODEL_RESPONSE_LIMIT", "模型响应过大，任务已停止。");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new RuntimeError(requestSignal.aborted ? "MODEL_TIMEOUT" : "MODEL_CONNECTION_FAILED", "读取模型响应失败；没有重试。");
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RuntimeError("MODEL_INVALID_RESPONSE", "模型服务返回了无效 JSON，请确认配置的是 Chat Completions 兼容接口。"); }
  if (!object(body) || !Array.isArray(body.choices) || !object(body.choices[0]) || !object(body.choices[0].message)) {
    throw new RuntimeError("MODEL_INVALID_RESPONSE", "模型响应缺少 choices[0].message，请检查接口兼容性。");
  }
  if (body.choices[0].finish_reason === "length") throw new RuntimeError("MODEL_OUTPUT_LIMIT", "模型服务截断了回复。TapPilot 使用服务商默认输出设置，请检查服务端的输出及上下文限制。本轮未执行动作，也未自动重试。");
  const raw = body.choices[0].message;
  if (raw.role !== "assistant" || (raw.content !== null && raw.content !== undefined && typeof raw.content !== "string")) {
    throw new RuntimeError("MODEL_INVALID_RESPONSE", "模型消息格式无效，未执行本轮动作。");
  }
  const message: Message = { role: "assistant", content: typeof raw.content === "string" ? raw.content : null };
  if (raw.tool_calls !== undefined && raw.tool_calls !== null) {
    if (!Array.isArray(raw.tool_calls) || raw.tool_calls.length > 8) throw new RuntimeError("MODEL_INVALID_TOOL_CALL", "模型工具调用列表无效或过长，未执行本轮动作。");
    const ids = new Set<string>();
    message.tool_calls = raw.tool_calls.map(call => {
      if (!object(call) || typeof call.id !== "string" || !call.id || call.id.length > 200 || ids.has(call.id) ||
          call.type !== "function" || !object(call.function) || typeof call.function.name !== "string" ||
          typeof call.function.arguments !== "string" || Buffer.byteLength(call.function.arguments) > 32 * 1024) {
        throw new RuntimeError("MODEL_INVALID_TOOL_CALL", "模型工具调用格式无效，未执行本轮动作。");
      }
      ids.add(call.id);
      return { id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } };
    });
  }
  if (!message.tool_calls?.length && !message.content?.trim()) throw new RuntimeError("MODEL_EMPTY_RESPONSE", "模型没有返回操作或回答。");
  const usage = object(body.usage) ? body.usage.total_tokens : undefined;
  // Providers may omit usage. The byte estimate is deliberately conservative for Chinese UI text.
  const tokens = typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0 ? usage : Math.ceil((requestBytes + responseBytes) / 2);
  return { message, tokens, requestBytes, responseBytes, modelUiBytes, rawUiBytes };
}

export async function testModel(config: ModelConfig, signal: AbortSignal = new AbortController().signal, modelFetch?: ModelFetch): Promise<{ ok: true; model: string; durationMs: number }> {
  const started = performance.now();
  const result = await completion(config, [{ role: "user", content: "Reply with OK only. This is a connection test." }], [], signal, modelFetch);
  if (result.message.tool_calls?.length) throw new RuntimeError("MODEL_INVALID_RESPONSE", "连接测试意外返回工具调用。");
  return { ok: true, model: config.model.trim(), durationMs: Math.round(performance.now() - started) };
}
