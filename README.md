# 涂地大作战

一款 2–4 人实时联机的浏览器涂地竞技游戏。玩家用方向键或 WASD 转向，在 90 秒内尽可能多地覆盖地图；冲刺可以撞晕对手，颜料炸弹能够一次炸开 3×3 区域。房间通过邀请链接加入，支持观战、断线重连和累计比分。

## 技术结构

- **服务端权威模拟**：`server/server.ts` 以 20 Hz 推进固定步长模拟，统一决定移动、碰撞、涂色、炸弹、计时和胜负。
- **共享规则**：`shared/rules.ts` 同时被浏览器和服务端引用，客户端使用相同规则做即时预测，服务端结果作为最终状态。
- **实时通信**：浏览器与服务端通过 WebSocket 交换意图、房间状态和快照，协议版本为 `paint-war-v1`。
- **渲染与界面**：Three.js、TypeScript、Vite；动态界面使用 HTML/CSS。
- **房间聊天**：WebRTC DataChannel 传输文字，WebRTC 音频轨道传输语音；游戏服务器只转发 SDP/ICE 信令。聊天能力通过 `chat-v1` capability 协商，旧服务端仍可正常运行游戏并隐藏聊天入口。
- **聊天身份核对**：双方界面显示由两端 DTLS 指纹生成的安全码。语音仅在本地用户确认安全码后发送和播放；安全码变化会暂停文字和语音，要求重新核对。
- **仓库资产**：游戏模型与分享图随仓库提供，生产构建通过 Vite 输出带内容哈希的本地资源 URL。

## 本地运行

需要 Node.js 22.18+ 和 pnpm 10。

```bash
pnpm install
pnpm --dir server install
```

终端一启动游戏服务器：

```bash
ALLOWED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000 pnpm dev:server
```

终端二创建 `.env.local`：

```dotenv
GAME_MULTIPLAYER_SIGNALING_URL=ws://127.0.0.1:8787/ws
```

然后启动客户端：

```bash
pnpm dev
```

打开 `http://127.0.0.1:3000`。创建房间后复制邀请链接，在第二个浏览器窗口中打开并加入。两名玩家都准备后，服务器开始 3 秒倒计时。

## 检查命令

```bash
pnpm typecheck
pnpm test
pnpm test:server
pnpm build
pnpm smoke
```

`pnpm smoke` 需要先执行 `pnpm build`，使用真实 Chromium、真实 WebSocket 服务和模拟麦克风验证双人入场、安全码一致、语音核对门槛、DataChannel 文本、证书轮换后语音关闭、准备、开局、移动涂色、菜单、移动端布局和离线提示。服务端测试还覆盖房间、预测、重连、权威规则、Origin 限制和聊天信令边界。

## 部署

静态客户端：

```bash
pnpm build
```

输出目录为 `dist/`。`public/multiplayer/bootstrap.json` 默认使用同源 `/ws`，因此客户端和 WebSocket 服务可以部署在同一个域名下。分享元数据默认使用 `https://zephyrwing-ai.github.io/paintwar`；部署到其他地址时通过 `PUBLICATION_ORIGIN` 覆盖：

```bash
PUBLICATION_ORIGIN=https://example.com/paintwar pnpm build
```

Node 服务端：

```bash
pnpm --dir server install --frozen-lockfile --prod
HOST=0.0.0.0 PORT=8787 pnpm --dir server start
```

部署时同时保留 `server/` 与 `shared/`。服务端支持以下环境变量：

| 变量 | 作用 |
| --- | --- |
| `HOST` / `PORT` | 监听地址与端口 |
| `STATIC_ROOT` | 可选静态站点目录，默认 `../dist` |
| `ALLOWED_ORIGINS` | 逗号分隔的精确跨域 Origin |
| `ALLOWED_ORIGIN_SUFFIXES` | 逗号分隔的可信域名后缀 |
| `RECONNECT_GRACE_MS` | 座位保留时长 |
| `ROOM_EMPTY_MS` | 空房间保留时长 |

`Dockerfile` 提供单容器生产镜像：同一 Node 22 服务同时托管静态客户端、`/ws` 和 `/healthz`。本地验证生产镜像：

```bash
PUBLICATION_ORIGIN=https://zephyrwing-ai.github.io/paintwar \
  docker compose up --build --detach
curl --fail http://127.0.0.1:3000/healthz
```

完整的候选容器验证、手工切换、GHCR 镜像、HTTPS 反向代理和回滚步骤见 `DEPLOY.md`。发布过程会重启 Node 服务，房间和比分存放在内存中，因此正式切换会清空当前比赛状态。

## 目录

| 路径 | 职责 |
| --- | --- |
| `shared/rules.ts` | 确定性规则、地图和移动模拟 |
| `shared/protocol.ts` | 客户端与服务端协议、能力声明和严格校验 |
| `server/server.ts` | WebSocket 服务、权威房间与静态文件服务 |
| `src/game/` | Three.js 场景、预测、绘制和游戏表现 |
| `src/net/secureChat.ts` | WebRTC 聊天、安全码、媒体权限和重连状态 |
| `src/ui/chatPanel.ts` | 聊天与语音界面 |
| `src/ui/ui.ts` | 首页、房间、HUD、菜单和设置 |
| `docs/secure-chat.md` | 聊天威胁模型与验证范围 |
| `scripts/smoke.mjs` | 生产构建端到端验收 |
| `Dockerfile` / `compose.yaml` | 单容器生产构建与本机验证 |
| `DEPLOY.md` | 手动云端发布、切换与回滚 |
| `.github/workflows/` | CI 验证与 GHCR 镜像发布 |

## 第三方资源

Three.js 使用 MIT 许可证，`ws` 使用 MIT 许可证。ManusCC0 字体及其许可证位于 `public/fonts/`。
