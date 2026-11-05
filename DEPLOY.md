# 手动部署

## 部署模型

生产发布采用单个容器。容器内的 Node.js 服务同时提供 Vite 构建后的静态站点和 `/ws` WebSocket 服务，浏览器通过同源相对地址 `/ws` 连接。

线上切换由人工执行：

1. 在本地或发布机构建一个版本化镜像。
2. 在临时端口启动候选容器并完成健康检查与浏览器验收。
3. 停止旧容器，启动同版本镜像作为正式容器。
4. 通过正式域名完成联机验收。

服务器进程承载房间、比分和聊天信令状态。**每次手动发布都会重启服务器，内存中的房间、比分、断线席位和聊天信任状态都会清空。** 发布前需要等待正在进行的对局结束，并通知玩家重新建房。

GitHub Actions 承担两项辅助职责：

- `CI` 工作流在 push 和 pull request 时执行类型检查、客户端测试、服务端测试和生产构建。仓库变量 `RUN_BROWSER_SMOKE=true` 会额外启用 Playwright Smoke；该完整媒体链路默认在本地和发布机执行。
- `Container` 工作流在 `main` 分支 push 时构建并推送 GHCR 镜像。

线上容器切换始终由人工步骤完成。

## 单容器内容

`Dockerfile` 使用多阶段构建：

- `client-deps` 依据根目录 `pnpm-lock.yaml` 安装客户端构建依赖。
- `build` 执行 `pnpm build`，生成 `dist/`、本地哈希模型、分享图和 OG 元数据。
- `server-deps` 依据 `server/pnpm-lock.yaml` 安装生产环境 `ws` 依赖。
- `runtime` 仅保留 `dist/`、`server/server.ts`、`shared/` 和 `server/node_modules/`，以 `node` 用户运行。

运行镜像监听 `3000` 端口，提供以下入口：

| 路径 | 用途 |
| --- | --- |
| `/` | Vite 静态站点 |
| `/ws` | 房间与实时游戏 WebSocket |
| `/healthz` | 容器健康检查 |

镜像内置 `HEALTHCHECK`，检查间隔为 30 秒，超时为 3 秒，启动宽限期为 10 秒。

## 构建参数

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `NODE_IMAGE` | `node:22-alpine` | Node.js 22 构建与运行基础镜像 |
| `PNPM_VERSION` | `10.18.0` | 构建阶段使用的 pnpm 版本 |
| `PUBLICATION_ORIGIN` | `https://zephyrwing-ai.github.io/paintwar` | 写入分享元数据的公开 HTTPS 站点地址 |

`PUBLICATION_ORIGIN` 在构建阶段写入 `og:url`、分享图和页面元数据。切换公开域名时，使用新的构建参数重新构建镜像。

游戏客户端依据 `public/multiplayer/bootstrap.json` 连接同源 `/ws`，静态站点和 WebSocket 服务共享一个域名与端口。

## 本机生产验证

### 1. 启动完整镜像

`PUBLICATION_ORIGIN` 使用有效的 HTTPS 站点地址。该地址表示最终公开来源，页面仍可通过本机地址打开。

```bash
PUBLICATION_ORIGIN=https://game.example.com \
  docker compose up --detach --build
```

查看状态：

```bash
docker compose ps
docker compose logs --follow game
```

### 2. 执行健康检查

```bash
curl --fail --show-error http://127.0.0.1:3000/healthz
```

返回值包含 `ok: true`、协议 marker、房间数、连接数和运行时长。

### 3. 验证页面与实时服务

打开 `http://127.0.0.1:3000/`，创建房间，并在第二个浏览器窗口或第二台设备中加入。检查以下链路：

1. 首页、字体、模型和分享资源完成加载。
2. 两名玩家进入同一房间并准备。
3. 倒计时开始后，移动、冲刺、涂色和比分保持同步。
4. 聊天面板显示相同的安全码。
5. 双方确认安全码后，麦克风按钮可用并完成语音发送。
6. 刷新页面后，玩家在原座位恢复。

移动设备的麦克风和 WebRTC 验收使用正式 HTTPS 域名。

### 4. 停止本机验证

```bash
docker compose down
```

`compose.yaml` 使用只读根文件系统、`/tmp` 临时盘、全部 capability 移除和 `no-new-privileges`。Compose 适合验证生产镜像和安全参数。

## 手动发布步骤

以下步骤适用于 Docker Engine 主机。示例域名使用 `game.example.com`，仓库地址使用 `zephyrwing-ai/paintwar`。

### 1. 准备版本

```bash
git fetch origin main
git switch main
git pull --ff-only
REV="$(git rev-parse --short HEAD)"
```

### 2. 构建版本化镜像

```bash
docker build \
  --build-arg PUBLICATION_ORIGIN=https://game.example.com \
  --tag "paintwar:release-${REV}" \
  .
```

构建过程包含客户端类型检查、Vite 生产构建、分享元数据校验和服务端生产依赖安装。

### 3. 启动候选容器

候选容器使用临时端口 `3001`，正式容器继续服务现有玩家。候选容器启动会创建独立进程，内存房间从空状态开始。

```bash
docker run --detach \
  --name paintwar-candidate \
  --init \
  --read-only \
  --tmpfs /tmp:rw,size=16m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --publish 127.0.0.1:3001:3000 \
  "paintwar:release-${REV}"
```

等待 Docker 报告健康状态，最长等待 60 秒：

```bash
health=starting
for _ in {1..30}; do
  health="$(docker inspect --format '{{.State.Health.Status}}' paintwar-candidate)"
  [ "$health" = healthy ] && break
  sleep 2
done
test "$health" = healthy
```

检查候选容器：

```bash
curl --fail --show-error http://127.0.0.1:3001/healthz
docker logs paintwar-candidate
```

打开 `http://127.0.0.1:3001/`，用两个浏览器上下文完成建房、准备、移动、涂色和聊天检查。

### 4. 切换正式容器

切换动作会停止当前服务器，内存房间和比分会清空。执行前确认所有对局已经结束。

首次发布直接从 `docker run` 步骤开始；已有正式容器时先执行 `docker stop paintwar` 和 `docker rm paintwar`。

```bash
docker stop paintwar
docker rm paintwar
docker run --detach \
  --name paintwar \
  --init \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:rw,size=16m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --publish 127.0.0.1:3000:3000 \
  "paintwar:release-${REV}"
```

确认正式容器健康，最长等待 60 秒：

```bash
health=starting
for _ in {1..30}; do
  health="$(docker inspect --format '{{.State.Health.Status}}' paintwar)"
  [ "$health" = healthy ] && break
  sleep 2
done
test "$health" = healthy
curl --fail --show-error http://127.0.0.1:3000/healthz
```

完成验收后移除候选容器：

```bash
docker rm --force paintwar-candidate
```

## 从 GHCR 发布

`Container` 工作流为 `main` 的每次提交生成 GHCR 镜像：

- `ghcr.io/zephyrwing-ai/paintwar:sha-<提交短哈希>`
- `ghcr.io/zephyrwing-ai/paintwar:main`
- `ghcr.io/zephyrwing-ai/paintwar:latest`

生产发布使用 `sha-<提交短哈希>` 标签，版本与 Git 提交一一对应。

### 1. 配置公开来源

在 GitHub 仓库的 `Settings > Secrets and variables > Actions > Variables` 中设置 `PUBLICATION_ORIGIN`。例如：

```text
https://game.example.com
```

变量留空时，工作流使用 `https://<owner>.github.io/<repository>`。

### 2. 登录 GHCR

使用具备 `read:packages` 权限的 GitHub Token：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USER" --password-stdin
```

### 3. 拉取提交对应镜像

```bash
REV="$(git rev-parse --short HEAD)"
docker pull "ghcr.io/zephyrwing-ai/paintwar:sha-${REV}"
```

随后按“启动候选容器”和“切换正式容器”的步骤，将镜像名替换为 `ghcr.io/zephyrwing-ai/paintwar:sha-${REV}`。

## HTTPS 与反向代理

正式站点使用 HTTPS。HTTPS 同时提供麦克风权限、WebRTC 和 `wss://` 所需的安全上下文。

Caddy 示例：

```caddyfile
game.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

Caddy 自动处理 TLS、HTTP/2 和 WebSocket Upgrade。容器绑定到 `127.0.0.1:3000`，公网只开放 `80` 和 `443`。

Nginx 需要显式转发 Upgrade 头：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name game.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

同源部署由服务端根据 `Host` / `X-Forwarded-Host` 自动放行。跨域部署时，通过 `ALLOWED_ORIGINS` 或 `ALLOWED_ORIGIN_SUFFIXES` 明确允许来源。

## 运行配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 容器监听地址 |
| `PORT` | `3000` | 容器监听端口 |
| `STATIC_ROOT` | `/app/dist` | 静态站点目录 |
| `ALLOWED_ORIGINS` | 空 | 逗号分隔的精确跨域 Origin |
| `ALLOWED_ORIGIN_SUFFIXES` | 空 | 逗号分隔的可信域名后缀 |
| `RECONNECT_GRACE_MS` | `30000` | 断线座位保留时长 |
| `ROOM_EMPTY_MS` | `300000` | 空房间保留时长 |

Compose 额外提供以下变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PAINTWAR_IMAGE` | `paintwar:local` | Compose 使用的镜像名 |
| `PAINTWAR_BIND` | `127.0.0.1` | 宿主机绑定地址 |
| `PAINTWAR_PORT` | `3000` | 宿主机发布端口 |
| `PUBLICATION_ORIGIN` | GitHub Pages 地址 | 构建阶段分享来源 |

## 发布后验收

1. `curl --fail https://game.example.com/healthz` 返回 `HTTP 200`。
2. 首页完成字体、模型、分享图和脚本加载。
3. 一台桌面设备和一台移动设备可以创建、加入并开始同一房间。
4. 移动、冲刺、涂色、炸弹和比分在两端一致。
5. 聊天安全码一致，确认后麦克风完成双向语音。
6. 刷新页面后原座位恢复。
7. 邀请链接、OG 图片和 favicon 指向 `PUBLICATION_ORIGIN`。

## 回滚

旧镜像保留版本化标签。将“切换正式容器”命令中的镜像替换为上一个 `paintwar:release-<REV>` 或 `ghcr.io/zephyrwing-ai/paintwar:sha-<REV>`，重新启动容器并执行健康检查。

回滚同样会重启服务器，内存中的房间和比分重新创建。
