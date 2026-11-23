/**
 * dsh-agnes-media — Agnes 生图 / 生视频（服务端）。
 *
 * 出口：
 *   ① 设置页接口（同源，走 DSH 自身的网络栅栏）
 *        GET    /plugin/agnes-media/status   密钥是否已配置（不含值）
 *        POST   /plugin/agnes-media/key      保存密钥（先校验可用再落库）
 *        DELETE /plugin/agnes-media/key      清除密钥
 *        POST   /plugin/agnes-media/test     测试密钥（GET /v1/models）
 *   ② 两个工具：agnes_generate_image / agnes_generate_video
 *
 * 密钥存放：DSH 的凭据库（credentialRef AGNES_API_KEY），不写进配置文件。
 *   读取顺序由 dsh-credentials 决定：凭据库里的值 > 启动时的环境变量。
 *
 * 生图取回：默认请求 base64（return_base64 / extra_body.response_format）。
 *   不直接拿 CDN URL —— 上游返回的 url 在返回瞬间可能还不可读，
 *   下载到半截错误体再判类型就会误报「不是有效图片」。
 */
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const name = "agnes-media";

/** 只依赖三个 seam：HTTP 路由、工具注册、凭据库。 */
export const inject = ["webServer", "tools", "credentials"];

const ORIGIN = "https://api.agnes-ai.cn";
const BASE = `${ORIGIN}/v1`;
const KEY_REF = "AGNES_API_KEY";
const IMAGE_MODEL = "agnes-image-2.5-flash";
const VIDEO_MODEL = "agnes-video-2.5-flash";

const DEFAULTS = {
  /** 生成文件落盘目录；留空则用 <当前工作目录>/agnes-media */
  outputDir: "",
  imageTimeoutMs: 360_000,
  /** 单次工具调用最多等多久视频（超时返回 pending + videoId，可再次查询） */
  videoWaitMs: 240_000,
  pollIntervalMs: 5_000,
  timeoutMs: 30_000,
  userAgent: "dsh-agnes-media/1.0.0",
};

/* ── 从运行中的 dsh 安装里解析内部包 ───────────────────────────────
 * 本插件装在 profiles/<p>/local/ 下，模块解析链上看不到 @deepseek-ai/dsh-tools，
 * 所以拿 dsh 进程入口建 createRequire。
 *
 * 注意：createRequire() 对**任何**路径都会成功，失败发生在 req(spec) 那一刻。
 * 所以必须逐个候选项真的去解析，不能拿第一个能创建的 require 就用
 * —— dsh 的 bin 是个软链 shim，直接对它 require 是找不到包的。
 */
function safeRealpath(p) {
  try { return realpathSync(p); } catch { return undefined; }
}

function resolveFromDsh(spec) {
  const entry = process.argv[1];
  const candidates = [];
  if (entry) {
    candidates.push(entry);
    const real = safeRealpath(entry);
    if (real) candidates.push(real);
  }
  // 兜底：按 node 的安装位置推导 dsh 的入口（nvm / 系统 node 都适用）
  try {
    const root = dirname(dirname(process.execPath));
    candidates.push(join(root, "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  } catch { /* 忽略 */ }
  for (const c of candidates) {
    try {
      return createRequire(`file://${c}`)(spec);
    } catch { /* 试下一个 */ }
  }
  return undefined;
}

/** 兼容 cordis 的 Ref 包装（.get()）与裸对象。 */
function cfgOf(config) {
  if (!config) return {};
  if (typeof config.get === "function") {
    try { return config.get() ?? {}; } catch { return {}; }
  }
  return config;
}

const now = () => Date.now();

/** 把上游响应体压成一句人话，便于工具报错。 */
function upstreamMessage(body, status) {
  if (!body) return `HTTP ${status}`;
  if (typeof body === "string") return body.slice(0, 300);
  const detail = body.detail ?? body.error?.message ?? body.message ?? body.error;
  if (typeof detail === "string" && detail) return detail;
  if (detail) return JSON.stringify(detail).slice(0, 300);
  return `HTTP ${status}`;
}

async function readJson(resp) {
  const text = await resp.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** 从 PNG / JPEG 头部读尺寸；读不出返回 0。 */
function imageSize(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* 忽略 */ }
  return { width: 0, height: 0 };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slug(text, max = 28) {
  const s = String(text || "").replace(/[\s\n\r\t]+/g, "-").replace(/[^\p{L}\p{N}\-_]/gu, "").slice(0, max);
  return s || "output";
}

/** 给文件挑一个不冲突的名字。 */
async function uniquePath(dir, base, ext) {
  const taken = new Set(await readdir(dir).catch(() => []));
  let name = `${base}.${ext}`;
  let n = 1;
  while (taken.has(name)) name = `${base}-${++n}.${ext}`;
  return join(dir, name);
}

export function apply(ctx, config) {
  const cfgNow = () => ({ ...DEFAULTS, ...cfgOf(config) });

  // 用 ctx.effect 托管注册：插件被卸载/热重载时自动释放，否则会残留
  // 「duplicate exact route」这类冲突（webServer.register 不会自己清理）。
  const route = (spec) => ctx.effect(() => ctx.webServer.register(spec));
  const tool = (def) => { registered.push(def.name); ctx.effect(() => { ctx.tools.register(def); }); };

  const credentialRef = resolveFromDsh("@deepseek-ai/dsh-credentials")?.credentialRef;
  const keyRef = credentialRef ? credentialRef(KEY_REF) : KEY_REF;

  /* ── 凭据读写 ─────────────────────────────────────────────── */
  async function resolveKey() {
    try {
      const hit = await ctx.credentials.resolve(keyRef);
      return hit?.value ? String(hit.value) : "";
    } catch (e) {
      ctx.logger?.warn?.("agnes-media: 读取凭据失败 %s", e?.message || e);
      return "";
    }
  }
  async function describeKey() {
    try {
      const info = await ctx.credentials.describe(keyRef);
      return {
        configured: Boolean(info?.configured),
        source: String(info?.source || ""),
        writable: info?.writable !== false,
        masked: String(info?.masked || ""),
      };
    } catch {
      return { configured: false, source: "", writable: true, masked: "" };
    }
  }
  const setKey = (v) => ctx.credentials.set(keyRef, v);
  const clearKey = () => ctx.credentials.unset(keyRef);

  /* ── 上游调用 ─────────────────────────────────────────────── */
  async function apiFetch(path, init = {}, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? cfgNow().timeoutMs);
    try {
      return await fetch(`${ORIGIN}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          "User-Agent": cfgNow().userAgent,
          Accept: "application/json",
          ...(init.headers || {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 用给定 key 探测账号可用性：拉模型列表（最轻的只读接口）。 */
  async function probeKey(key) {
    const t0 = now();
    const resp = await apiFetch("/v1/models", { headers: { Authorization: `Bearer ${key}` } })
      .catch((e) => {
        const err = new Error(e?.name === "AbortError" ? "连接 Agnes 超时" : `连接 Agnes 失败：${e?.message || e}`);
        err.code = "NETWORK";
        throw err;
      });
    const body = await readJson(resp);
    const ms = now() - t0;
    if (!resp.ok) {
      const err = new Error(`密钥不可用：${upstreamMessage(body, resp.status)}`);
      err.code = "BAD_KEY";
      err.status = resp.status;
      throw err;
    }
    const models = Array.isArray(body?.data) ? body.data.map((m) => String(m?.id ?? "")).filter(Boolean) : [];
    return { models, latencyMs: ms };
  }

  /* ── 落盘 ─────────────────────────────────────────────────── */
  function outputDir() {
    const cfg = cfgNow();
    return cfg.outputDir && String(cfg.outputDir).trim()
      ? String(cfg.outputDir).trim()
      : join(process.cwd(), "agnes-media");
  }

  async function saveBytes(buf, prompt, ext) {
    const dir = outputDir();
    await mkdir(dir, { recursive: true });
    const file = await uniquePath(dir, `${stamp()}-${slug(prompt)}`, ext);
    await writeFile(file, buf, { mode: 0o644 });
    return file;
  }

  /* ── 生图 ────────────────────────────────────────────────── */
  async function generateImage(args) {
    const key = await resolveKey();
    if (!key) throw new Error(`还没配置 Agnes API Key —— 打开「设置 → Agnes 生成」填一个再试`);
    const prompt = String(args?.prompt || "").trim();
    if (!prompt) throw new Error("prompt 不能为空");

    const size = String(args?.size || "1K");
    const refs = Array.isArray(args?.references) ? args.references.filter(Boolean).map(String) : [];
    const body = { model: IMAGE_MODEL, prompt, size };
    if (args?.ratio) body.ratio = String(args.ratio);
    if (refs.length) {
      body.extra_body = { image: refs, response_format: "b64_json" };
    } else {
      body.return_base64 = true;
    }

    const t0 = now();
    const resp = await apiFetch("/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, cfgNow().imageTimeoutMs).catch((e) => {
      const err = new Error(e?.name === "AbortError" ? "生图超时（提示词复杂时可能要几十秒）" : `生图请求失败：${e?.message || e}`);
      err.code = "NETWORK";
      throw err;
    });
    const data = await readJson(resp);
    if (!resp.ok) throw new Error(`生图失败：${upstreamMessage(data, resp.status)}`);

    const item = Array.isArray(data?.data) ? data.data[0] : null;
    if (!item) throw new Error("生图失败：上游没返回图片数据");

    let buf;
    if (typeof item.b64_json === "string" && item.b64_json) {
      buf = Buffer.from(item.b64_json, "base64");
    } else if (typeof item.url === "string" && item.url) {
      // 兜底：真的没给 base64 才去下载，且重试几次（对象可能刚写完还没就绪）
      buf = await downloadWithRetry(item.url);
    } else {
      throw new Error("生图失败：上游既没返回 b64_json 也没返回 url");
    }
    if (!buf || buf.length < 1024) throw new Error("生图失败：拿到的图片数据不完整");

    const dim = imageSize(buf);
    const ext = buf[0] === 0x89 ? "png" : buf[0] === 0xff ? "jpg" : "png";
    const path = await saveBytes(buf, prompt, ext);
    return {
      path,
      bytes: buf.length,
      width: dim.width,
      height: dim.height,
      model: IMAGE_MODEL,
      elapsedMs: now() - t0,
      revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : "",
    };
  }

  /**
   * 下载上游给的媒体 URL（图片兜底 / 视频）。
   * 注意：媒体在 CDN 上（如 cos-platform-outputs.agnes-ai.cn），
   * 不能拼到 API 域名下请求，必须用绝对地址原样抓。
   */
  async function downloadWithRetry(url, attempts = 5, key = "") {
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 180_000);
        let resp;
        try {
          resp = await fetch(url, {
            signal: ctrl.signal,
            redirect: "follow",
            headers: {
              "User-Agent": cfgNow().userAgent,
              Accept: "*/*",
              ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
          });
        } finally {
          clearTimeout(timer);
        }
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length > 1024) return buf;
          last = new Error(`内容只有 ${buf.length} 字节`);
        } else {
          last = new Error(`HTTP ${resp.status}`);
        }
      } catch (e) {
        last = e;
      }
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
    throw new Error(`下载生成的文件失败：${last?.message || last}`);
  }

  /* ── 生视频 ──────────────────────────────────────────────── */
  async function createVideo(args, key) {
    const prompt = String(args?.prompt || "").trim();
    if (!prompt) throw new Error("prompt 不能为空");
    const mode = String(args?.mode || "text");
    if (!["text", "keyframe", "reference"].includes(mode)) throw new Error("mode 只能是 text / keyframe / reference");

    const body = {
      model: VIDEO_MODEL,
      prompt,
      mode,
      seconds: String(args?.seconds || "5"),
      size: "720P",
    };
    if (args?.aspectRatio) body.aspect_ratio = String(args.aspectRatio);
    if (args?.seed !== undefined && args?.seed !== null && args.seed !== "") body.seed = Number(args.seed);

    if (mode === "keyframe") {
      if (args?.firstFrame) body.first_frame = String(args.firstFrame);
      if (args?.lastFrame) body.last_frame = String(args.lastFrame);
      if (!body.first_frame && !body.last_frame) throw new Error("keyframe 模式需要 firstFrame 或 lastFrame");
    }
    if (mode === "reference") {
      const images = Array.isArray(args?.references) ? args.references.filter(Boolean).map(String) : [];
      if (images.length > 5) throw new Error("参考图片最多 5 张");
      if (images.length) body.images = images;
      if (!images.length) throw new Error("reference 模式需要至少 1 张参考图片");
    }

    const resp = await apiFetch("/v1/videos", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((e) => {
      const err = new Error(e?.name === "AbortError" ? "创建视频任务超时" : `创建视频任务失败：${e?.message || e}`);
      err.code = "NETWORK";
      throw err;
    });
    const data = await readJson(resp);
    if (!resp.ok) {
      const msg = upstreamMessage(data, resp.status);
      // 免费额度有速率限制：给出能照着做的话，而不是原样抛上游文案
      if (resp.status === 429 || /速率限制|rate limit|频繁/i.test(msg)) {
        const err = new Error(
          `Agnes 拒绝了这次视频任务：账号当前触发速率限制（免费额度更容易触发）。稍等一会儿再试，或在 Agnes 控制台升级额度。上游原话：${msg}`,
        );
        err.code = "RATE_LIMIT";
        throw err;
      }
      throw new Error(`创建视频任务失败：${msg}`);
    }
    const videoId = String(data?.video_id || data?.id || data?.task_id || "");
    if (!videoId) throw new Error("创建视频任务失败：上游没返回 video_id");
    return { videoId, prompt, seconds: body.seconds, mode, aspectRatio: body.aspect_ratio || "16:9" };
  }

  async function pollVideo(videoId, key) {
    const resp = await apiFetch(
      `/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(VIDEO_MODEL)}`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const data = await readJson(resp);
    if (!resp.ok) {
      const msg = upstreamMessage(data, resp.status);
      // 上游对查询有频控：这种情况是"再等等"，不是任务失败
      const throttled = resp.status === 429 || /频繁|too many|rate limit/i.test(msg);
      const err = new Error(`查询视频任务失败：${msg}`);
      err.throttled = throttled;
      throw err;
    }
    return data || {};
  }

  /** 等视频完成；超时返回 pending（带上 videoId 供下一轮查询）。 */
  async function waitVideo(videoId, key, waitMs) {
    const cfg = cfgNow();
    const deadline = now() + (waitMs ?? cfg.videoWaitMs);
    let lastStatus = "queued";
    let lastProgress = 0;
    let wait = cfg.pollIntervalMs;
    let misses = 0;
    while (now() < deadline) {
      let data;
      try {
        data = await pollVideo(videoId, key);
        misses = 0;
        wait = cfg.pollIntervalMs;
      } catch (e) {
        if (!e?.throttled || ++misses > 12) throw e;
        // 被频控：退避后再试（5s → 10s → 20s → 30s 封顶）
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30_000);
        continue;
      }
      lastStatus = String(data?.status || lastStatus);
      lastProgress = Number(data?.progress ?? lastProgress) || 0;
      if (lastStatus === "completed") {
        const url = String(data?.url || "");
        if (!url) throw new Error(`视频已完成但没给下载地址（videoId=${videoId}）`);
        const buf = await downloadWithRetry(url, 6, key);
        const path = await saveBytes(buf, `video-${videoId}`, "mp4");
        return {
          done: true, path, bytes: buf.length,
          seconds: String(data?.seconds || ""),
          size: String(data?.size || ""),
          status: lastStatus, progress: 100,
        };
      }
      if (lastStatus === "failed") {
        throw new Error(`视频生成失败：${String(data?.error || "上游未给出原因")}`);
      }
      await new Promise((r) => setTimeout(r, wait));
    }
    return { done: false, status: lastStatus, progress: lastProgress };
  }

  /* ── HTTP 路由（设置页用） ─────────────────────────────────── */
  const PREFIX = "/plugin/agnes-media";

  function respond(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new Error("请求体过大");
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("请求体不是合法 JSON"); }
  }

  route({
    kind: "exact",
    path: `${PREFIX}/status`,
    async handler(req, res) {
      if (req.method !== "GET" && req.method !== "HEAD") return respond(res, 405, { ok: false, error: "只支持 GET" });
      const info = await describeKey();
      respond(res, 200, { ok: true, ...info, keyName: KEY_REF, tools: registered });
    },
  });

  route({
    kind: "exact",
    path: `${PREFIX}/key`,
    async handler(req, res) {
      try {
        if (req.method === "DELETE") {
          await clearKey();
          return respond(res, 200, { ok: true, ...(await describeKey()) });
        }
        if (req.method !== "POST") return respond(res, 405, { ok: false, error: "只支持 POST / DELETE" });
        const body = await readBody(req);
        const key = String(body?.apiKey || "").trim();
        if (!key) return respond(res, 400, { ok: false, error: "API Key 不能为空" });
        if (/\s/.test(key) || key.length < 8 || key.length > 4096) {
          return respond(res, 400, { ok: false, error: "API Key 格式不对（不能含空格）" });
        }
        // 先验证再落库：避免把错的 key 存进去
        const probe = await probeKey(key).catch((e) => {
          throw Object.assign(new Error(e?.message || "密钥校验失败"), { code: e?.code || "BAD_KEY" });
        });
        await setKey(key);
        return respond(res, 200, { ok: true, ...(await describeKey()), models: probe.models, latencyMs: probe.latencyMs });
      } catch (e) {
        ctx.logger?.warn?.("agnes-media: 保存密钥失败 %s", e?.message || e);
        respond(res, e?.code === "BAD_KEY" ? 400 : 502, { ok: false, error: String(e?.message || e), code: e?.code || "UNKNOWN" });
      }
    },
  });

  route({
    kind: "exact",
    path: `${PREFIX}/test`,
    async handler(req, res) {
      if (req.method !== "POST" && req.method !== "GET") return respond(res, 405, { ok: false, error: "只支持 GET / POST" });
      try {
        const key = await resolveKey();
        if (!key) return respond(res, 400, { ok: false, error: "还没配置 API Key", code: "NO_KEY" });
        const probe = await probeKey(key);
        respond(res, 200, { ok: true, ...probe, ...(await describeKey()) });
      } catch (e) {
        respond(res, e?.code === "BAD_KEY" ? 400 : 502, { ok: false, error: String(e?.message || e), code: e?.code || "UNKNOWN" });
      }
    },
  });

  /* ── 工具 ────────────────────────────────────────────────── */
  const defineTool = resolveFromDsh("@deepseek-ai/dsh-tools")?.defineTool;
  const registered = [];
  if (!defineTool) {
    ctx.logger?.warn?.("agnes-media: 未能解析 @deepseek-ai/dsh-tools，工具不注册");
    return;
  }

  tool(defineTool({
    name: "agnes_generate_image",
    description:
      "用 Agnes 图像模型（agnes-image-2.5-flash）生成图片，也支持基于参考图改写/多图合成。返回落盘的绝对路径，便于接着预览或交付。未配置密钥时会提示去设置页填写。",
    parameters: {
      prompt: { type: "string", required: true, description: "画面描述。建议结构：主体 + 场景 + 风格 + 光照 + 构图 + 质量要求" },
      size: { type: "string", enum: ["1K", "2K", "3K", "4K"], description: "输出档位，默认 1K；4K 更慢也更贵" },
      ratio: { type: "string", enum: ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"], description: "宽高比，默认 1:1" },
      references: { type: "array", items: { type: "string" }, description: "参考图：公网 HTTPS URL 或 data:image/...;base64；给了就是图生图/多图合成" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "生成图片的绝对路径" },
          bytes: { type: "integer" },
          width: { type: "integer", description: "0 表示没解析出来" },
          height: { type: "integer" },
          model: { type: "string" },
          elapsedMs: { type: "integer" },
          revisedPrompt: { type: "string", description: "上游改写后的提示词；空串表示没有" },
        },
      },
      render: (_a, v) => [{
        type: "text",
        text: `已生成图片：${v.path}\n${v.width}×${v.height}，${(v.bytes / 1024).toFixed(0)}KB，用时 ${(v.elapsedMs / 1000).toFixed(1)}s（${v.model}）`,
      }],
    },
    async execute(args) {
      return generateImage(args || {});
    },
  }));

  tool(defineTool({
    name: "agnes_generate_video",
    description:
      "用 Agnes 视频模型（agnes-video-2.5-flash，720P）生成视频：文生视频、首尾帧控制、或图片参考。默认会等到完成再返回文件路径；等太久会返回 pending 和 videoId，再调一次本工具并带上 videoId 继续等。",
    parameters: {
      prompt: { type: "string", required: true, description: "视频内容描述。reference 模式可用 <Picture 1> / <Audio 1> 指代素材" },
      mode: { type: "string", enum: ["text", "keyframe", "reference"], description: "默认 text" },
      seconds: { type: "string", enum: ["4", "5", "6", "7", "8", "9", "10", "11", "12"], description: "时长（秒），默认 5" },
      aspectRatio: { type: "string", enum: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], description: "画幅，默认 16:9" },
      firstFrame: { type: "string", description: "keyframe 模式：首帧图片 URL" },
      lastFrame: { type: "string", description: "keyframe 模式：尾帧图片 URL" },
      references: { type: "array", items: { type: "string" }, description: "reference 模式：参考图片 URL，最多 5 张" },
      seed: { type: "integer", description: "随机种子，可选" },
      videoId: { type: "string", description: "续等：传入之前的 videoId，只继续等待不重新创建任务" },
      waitSeconds: { type: "integer", description: "本次最多等多少秒，默认 240" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", description: "completed 或 pending" },
          path: { type: "string", description: "完成时的视频绝对路径；未完成是空串" },
          bytes: { type: "integer" },
          videoId: { type: "string" },
          progress: { type: "integer", description: "0–100" },
          seconds: { type: "string", description: "视频时长" },
          hint: { type: "string", description: "未完成时的下一步提示；完成为空串" },
        },
      },
      render: (_a, v) => [{
        type: "text",
        text: v.status === "completed"
          ? `已生成视频：${v.path}（${v.seconds || "?"} 秒，${(v.bytes / 1024 / 1024).toFixed(1)}MB）`
          : `视频还在生成（${v.progress}%）。再调 agnes_generate_video 并带 videoId=${v.videoId} 继续等`,
      }],
    },
    async execute(args) {
      const a = args || {};
      const key = await resolveKey();
      if (!key) throw new Error("还没配置 Agnes API Key —— 打开「设置 → Agnes 生成」填一个再试");
      const waitMs = Number(a.waitSeconds) > 0 ? Number(a.waitSeconds) * 1000 : undefined;

      let videoId = String(a.videoId || "").trim();
      let meta = { seconds: "", aspectRatio: "" };
      if (!videoId) {
        const created = await createVideo(a, key);
        videoId = created.videoId;
        meta = { seconds: created.seconds, aspectRatio: created.aspectRatio };
      }

      const r = await waitVideo(videoId, key, waitMs);
      if (r.done) {
        return {
          status: "completed", path: r.path, bytes: r.bytes, videoId,
          progress: 100, seconds: r.seconds || meta.seconds || "", hint: "",
        };
      }
      return {
        status: "pending", path: "", bytes: 0, videoId,
        progress: r.progress || 0, seconds: meta.seconds || "",
        hint: `还没生成完（${r.status}，${r.progress || 0}%）。带上 videoId=${videoId} 再调一次继续等`,
      };
    },
  }));

  tool(defineTool({
    name: "agnes_media_status",
    description: "查看 Agnes 生图/生视频是否可用：密钥是否已配置、有哪几个模型、输出目录在哪。不消耗额度。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          configured: { type: "boolean" },
          source: { type: "string", description: "凭据来源，如 stored / env；空串表示没有" },
          masked: { type: "string", description: "打码预览，可能为空" },
          outputDir: { type: "string" },
          imageModel: { type: "string" },
          videoModel: { type: "string" },
        },
      },
      render: (_a, v) => [{
        type: "text",
        text: v.configured
          ? `Agnes 已就绪（来源：${v.source || "未知"}）。图片 ${v.imageModel}，视频 ${v.videoModel}，输出目录 ${v.outputDir}`
          : `Agnes 还没有 API Key。打开「设置 → Agnes 生成」填一个，保存时会自动校验`,
      }],
    },
    async execute() {
      const info = await describeKey();
      return {
        configured: info.configured,
        source: info.source || "",
        masked: info.masked || "",
        outputDir: outputDir(),
        imageModel: IMAGE_MODEL,
        videoModel: VIDEO_MODEL,
      };
    },
  }));

  ctx.logger?.info?.("agnes-media: 已就绪（设置页 + %d 个工具）", 3);
}
