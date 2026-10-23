# jiying-dingtalk-app

只给自己用的即应应用。钉钉里和你相关的新消息会原文推送到应用单聊；你在这条单聊里发指令时，Agent 通过 `dws` 操作钉钉聊天。

## 使用方式

先在即应里创建一个应用，并把可见范围设成仅自己可见。即应的可见范围有三种：创建者、指定用户、公开。这里要选创建者，不要选指定用户或公开。这样别人看不到这个应用，也不能在群里把它拉进来指挥。

创建后打开该应用的「应用接入信息」，抄下这三项，后面写入 `config.yaml`：

- WebSocket 地址，填到 `magicchat.ws_url`
- 应用 ID，填到 `magicchat.app_id`
- 连接密钥，填到 `magicchat.app_secret`

再找到你自己的即应用户 ID，填到 `magicchat.user_id`。推送只发给这个人，也只有这个人在应用单聊里发来的消息会被处理。密钥只放在 `config.yaml`，不要提交到仓库。

然后在运行这个程序的电脑上安装并登录 `dws`，登录的必须是你要接收通知的那个钉钉账号。安装和登录命令见下文。组织如果还没开 CLI 权限，需要管理员在钉钉开发者平台开启。

配置写好后，在仓库目录启动：

```bash
npm install
npm start
```

看到「即应已连接」和「钉钉事件订阅已就绪」就可以用了。这个进程要一直开着。停止时用 Ctrl+C，不要 `kill -9`，否则钉钉上的个人事件订阅可能退不掉。

用的时候只打开这个应用的单聊，不要在即应的群里 @ 它。群消息会被直接丢掉。

它有两种工作方式：

- 推送只进对应话题，不再发到应用单聊。默认推送所有未开免打扰的群消息；把 `push.all_group_messages` 设为 `false` 后，只推送私聊、@你和 @所有人。`push.muted_conversations` 默认 `false`，免打扰群不推送；设为 `true` 后免打扰会话也会推送。私聊只发正文，群聊写成同一行「**发送人**：正文」。一个钉钉会话对应一个话题。话题还不存在时，先在应用单聊发一句钉钉会话名，只用它来创建话题，之后的消息不再出现在单聊。对应关系保存在本地 `data/topics.json`，重启后继续使用。你在话题里回复的文字、图片和文件会直接发回那个钉钉会话，不经过模型。免打扰群里的消息不推。图片和钉盘文件会下载后，分别以即应图片或文件消息发进话题。
- 主动：你在应用单聊里发指令。应用先在你的消息上贴 👀，表示已收到，然后显示正在思考、正在调用工具、正在生成回复。它可以用 `dws` 查未读、查 @你、搜消息、读会话、找人找群、发私聊、发群消息、回复某一条。发消息和回复会直接执行，不再二次确认。撤回没有开放。

主动对话始终是同一个 session，不会每句话新开一次。每次请求带上最近 6 句可见记录和你这次的指令。单次最多调用工具 25 轮，到上限就用已有结果回复。

## 安装 dws

应用通过本机的 `dws` 收钉钉事件和操作聊天。官方仓库是 [dingtalk-workspace-cli](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)。

国内网络建议用 npm 镜像：

```bash
npm install -g dingtalk-workspace-cli --registry=https://registry.npmmirror.com
dws --version
```

也可以用安装脚本。能访问 GitHub 时：

```bash
curl -fsSL https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh | sh
```

GitHub 不稳定时改用 Gitee 镜像：

```bash
curl -fsSL https://gitee.com/DingTalk-Real-AI/dingtalk-workspace-cli/raw/main/scripts/install.sh | DWS_GITEE_REPO=DingTalk-Real-AI/dingtalk-workspace-cli sh
```

安装后登录接收通知的那个钉钉账号。浏览器会打开，选择组织并授权：

```bash
dws auth login
dws auth status
```

无图形界面时用 `dws auth login --device`。组织如果还没开 CLI 权限，需要管理员在钉钉开发者平台开启。

## 配置

配置文件是仓库根目录的 `config.yaml`。它包含密钥，已在 `.gitignore` 中，不要提交。

```bash
cp config.example.yaml config.yaml
```

字段如下。

`anthropic` 是主动模式调用的模型，协议为 Anthropic Messages。

| 字段 | 说明 |
| --- | --- |
| `base_url` | 接口地址。官方是 `https://api.anthropic.com`；使用兼容网关时填网关地址，程序会请求 `{base_url}/v1/messages`。如果地址本身以 `/v1` 结尾，则不会再重复追加。 |
| `model` | 模型名称，原样传给接口。 |
| `api_key` | 模型密钥，放在请求头 `x-api-key`。 |

`magicchat` 是即应应用的接入信息。在即应的「应用接入信息」里复制前三项。应用用独立身份连接，不会继承创建者权限。

| 字段 | 说明 |
| --- | --- |
| `ws_url` | WebSocket 地址，形如 `wss://<主机>/api/app/ws`。 |
| `app_id` | 应用 ID。 |
| `app_secret` | 应用连接密钥。只放在这个文件里，不要写进客户端或仓库。 |
| `user_id` | 你自己的即应用户 ID。推送只发给这个人；也只有这个人在应用单聊里发来的消息会被处理。 |

`agent` 可以省略，省略时使用下列默认值。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `max_rounds` | `25` | 你发来一条消息后，模型最多连续调用工具的轮数。到上限后用已有结果回复，不新开 session。 |
| `max_context_tokens` | `100000` | 单次请求的上下文估算上限。超过后压缩更早的对话和旧工具结果，最近 6 句和当前这一轮保持原样。 |
