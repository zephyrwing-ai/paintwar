# 涂地大作战服务器

`server.ts` 是独立的 Node 22.18+ WebSocket 服务。一个进程承载所有房间，并负责座位、阶段、固定步长模拟、涂色、碰撞、炸弹、比分和胜负。浏览器只发送准备、转向和冲刺意图。

## 启动

从仓库根目录执行：

```bash
pnpm --dir server install --frozen-lockfile --prod
HOST=0.0.0.0 PORT=8787 pnpm --dir server start
```

服务端依赖仓库中的 `shared/`。直接复制独立目录时，需要同时保留：

```text
server/
shared/
```

端口 `0` 会绑定空闲端口，第一条 stdout JSON 包含实际端口。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `STATIC_ROOT` | `../dist` | 可选静态客户端目录 |
| `ALLOWED_ORIGINS` | 空 | 精确允许的浏览器 Origin |
| `ALLOWED_ORIGIN_SUFFIXES` | 空 | 允许的域名后缀 |
| `RECONNECT_GRACE_MS` | `30000` | 断线座位保留时间 |
| `ROOM_EMPTY_MS` | `300000` | 空房间保留时间 |

同源请求默认通过。`GET /healthz` 和 `GET /api/health` 返回进程状态。WebSocket 路径为 `/ws`，房间参数为 `room`，创建参数为 `create=1`，重连参数为 `resume`。

## 协议

协议 marker 为 `paint-war-v1`。`welcome` 同时声明服务端能力：

```json
{
  "type": "welcome",
  "marker": "paint-war-v1",
  "role": "p1",
  "capabilities": ["chat-v1"]
}
```

游戏意图：

- `ready`：设置座位准备状态。
- `turn`：在当前回合请求转向。
- `dash`：在当前回合请求冲刺。
- `name`：大厅阶段修改昵称。
- `leave`：立即释放座位。
- `ping`：测量往返延迟。
- `rtc`：向同一房间的另一个在线座位转发 `offer`、`answer` 或 `ice`。

服务端发送 `welcome`、`room`、`snap`、`pong`、`rtc` 和 `error`。房间状态变化发送 `room`，对局进行中约 20 Hz 发送 `snap`。

## 权威规则

- 每局 90 秒，最后 15 秒进入狂热时间。
- 两名以上已连接玩家全部准备后开始 3 秒倒计时。
- 玩家进入格子后为格子涂色；冲刺可撞晕其他玩家；颜料炸弹覆盖 3×3 区域。
- 时间结束按涂色格数、撞晕次数和炸弹数排序。
- 少于两名玩家时提前结束，胜者获得一局比分。
- 断线座位在宽限期内冻结；宽限期结束后释放。
- 客户端意图包含回合与递增序号，服务端只应用当前回合、序号递增且首次到达的意图。

## 聊天信令

服务端检查 `rtc` 消息的目标、类型、字符串大小和目标座位在线状态，然后原样转发。SDP/ICE 对服务端保持不可解析和临时状态，DataChannel 与音频内容在两端浏览器之间加密。

普通游戏消息上限为 4 KB；聊天信令内容上限为 12 KB；WebSocket 帧上限为 16 KB。每个连接每秒最多发送 60 条消息，慢连接在发送缓冲超过 128 KB 时断开。

## 容量

- 200 个房间
- 600 个并发连接
- 每个房间 4 个座位和 8 个观战者
- 15 秒 WebSocket 心跳

## 测试

```bash
pnpm --dir server test
```

测试在随机端口启动真实服务进程，覆盖创造和加入房间、观战、准备、快照频率、意图去重、权威规则、重连、座位替换、Origin 限制以及聊天信令边界。
