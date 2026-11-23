# dsh-agnes-media

给 DSH 装上 Agnes 的**生图 / 生视频**能力：设置页填 API Key，保存即校验，通过后 agent 就有两个工具可用。

## 设置

**设置 → Agnes 生成**

| 操作 | 说明 |
|---|---|
| 保存并验证 | 先用 `GET /v1/models` 校验 Key，通过才写入凭据库 |
| 测试连接 | 用已保存的 Key 拉一次模型列表（不消耗额度）|
| 清除 | 从凭据库删除 |

Key 存在 DSH 凭据库（`credentialRef = AGNES_API_KEY`），**不写进任何配置文件**。
优先级：凭据库 > 启动 dsh 时的环境变量 `AGNES_API_KEY`。

## 工具

| 工具 | 能力 |
|---|---|
| `agnes_generate_image` | `agnes-image-2.5-flash`，1K/2K/3K/4K，8 种画幅，图生图与多图合成 |
| `agnes_generate_video` | `agnes-video-2.5-flash`，720P，4–12 秒，文生视频 / 首尾帧 / 图片参考 |
| `agnes_media_status` | 查 Key 状态与输出目录（不消耗额度）|

生成结果落盘到 `<当前工作目录>/agnes-media/`，工具返回绝对路径。

## 实现要点（踩过的坑）

1. **`createRequire` 对任何路径都会成功**，失败发生在 `req(spec)` 那一刻。
   dsh 的 bin 是软链 shim，直接对它 require 找不到 `@deepseek-ai/dsh-tools` ——
   必须逐个候选（含 `realpath` 与按 `process.execPath` 推导的路径）真的去解析。
2. **工具参数不是 JSON Schema**，是「属性映射」：`{ prompt: { type:'string', required:true } }`；
   整块塞 `{type:'object', properties:{}}` 会报 `parameters.type must be a value schema object`。
3. **生图一律要 base64**（`return_base64` / `extra_body.response_format`）。
   上游返回的 `url` 在返回瞬间可能还不可读，抓到半截错误体再判类型就会误报「不是有效图片」。
4. **视频查询有频控**：默认 5 秒一次，遇 429 / 「过于频繁」指数退避，不直接判失败。
5. **视频免费额度容易限速**：创建被拒时转成人话提示，别原样抛上游 JSON。

## 卸载

从 `~/.dsh/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉
`dsh-agnes-media`，再删 `node_modules/dsh-agnes-media` 软链即可。
