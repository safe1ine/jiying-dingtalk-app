import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { runDws, startEventStream } from "./dws.js";
import { MagicChat, startStatus } from "./magicchat.js";
import { attachmentFromBody, downloadImageUrl, extractMediaIds, imageResourceIds, isImageContent, textWithoutImages, urlsFromReadUrls } from "./media.js";
import { currentUser, personByName, realName, sentBySelf } from "./names.js";
import { classify, conversationTitle, formatTopicPush, formatTopicSender, messageBody, mutedForConversation, pushIndexLine } from "./push.js";
import { appendVisible, rememberPush } from "./session.js";
import { stampSentMessage } from "./stamp.js";
import { loadJson, saveJson } from "./store.js";
import { creationText, emptyTopics, findByTopicId, idsFromSend, rememberTopic, topicFor, topicIdFromCreate } from "./topics.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionPath = resolve(root, "data/session.json");
const pushPath = resolve(root, "data/pushes.json");
const seenPath = resolve(root, "data/seen.json");
const topicsPath = resolve(root, "data/topics.json");
const emotionPath = resolve(root, "data/emotion.json");

let config;
let chat;
let session;
let pushes;
let seen;
let topics;
let stopped = false;
let connecting = false;
let stream;
const muteCache = new Map();
const topicLocks = new Map();
let inbound = Promise.resolve();

async function main() {
  config = await loadConfig(resolve(root, "config.yaml"));
  session = await loadJson(sessionPath, { summary: "", messages: [] });
  pushes = await loadJson(pushPath, []);
  seen = await loadJson(seenPath, {});
  topics = await loadJson(topicsPath, emptyTopics());
  topics.byDingTalk ||= {};
  chat = new MagicChat({
    url: config.magicchat.ws_url,
    appId: config.magicchat.app_id,
    secret: config.magicchat.app_secret,
  });
  chat.onEvent = (envelope) => {
    inbound = inbound.then(() => handleInbound(envelope)).catch((error) => console.error(error));
    return inbound;
  };
  chat.onClose = () => {
    if (!stopped && !connecting) connectForever().catch((error) => console.error(error));
  };
  await connectForever();
  console.log("即应已连接。");
  listen(0);
}

async function connectForever() {
  if (connecting) return;
  connecting = true;
  let delay = 1000;
  try {
    for (;;) {
      try {
        await chat.connect();
        return;
      } catch (error) {
        if (stopped) return;
        console.error(`连接即应失败：${error.message}`);
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  } finally {
    connecting = false;
  }
}

async function handleInbound(envelope) {
  if (envelope.event === "conversation.status") return;
  try {
    if (envelope.event === "message.created") await handleUserMessage(envelope.payload);
  } finally {
    if (envelope.cursor) await chat.request("events.ack", { cursor: envelope.cursor }).catch(() => {});
  }
}

async function handleUserMessage(payload) {
  const conversation = payload?.conversation;
  const sender = payload?.sender;
  if (!conversation || sender?.id !== config.magicchat.user_id) return;
  if (conversation.type === "topic") {
    await relayTopicReply(payload);
    return;
  }
  if (conversation.type !== "app" || conversation.parent) return;
  const messageId = payload.message?.id;
  if (messageId && seen[messageId]) return;
  if (messageId) {
    seen[messageId] = Date.now();
    await saveJson(seenPath, seen);
  }
  chat.request("message.reaction.set", {
    conversation_id: conversation.id,
    message_id: messageId,
    text: "👀",
    reacted: true,
  }).catch((error) => console.error("贴表情失败：", error.message));

  const status = startStatus(chat, conversation.id);
  const instruction = payload.message?.body?.content || payload.message?.summary || "（收到一条没有文本的消息）";
  try {
    const reply = await runAgent({
      config,
      session,
      pushIndex: pushes,
      instruction: String(instruction),
      status,
    });
    await sendText(reply);
    appendVisible(session, "user", String(instruction));
    appendVisible(session, "assistant", reply);
    await saveJson(sessionPath, session);
  } catch (error) {
    console.error(error);
    await saveJson(sessionPath, session).catch(() => {});
    await sendText(`处理失败：${error.message}`).catch(() => {});
  } finally {
    status.stop();
  }
}

async function handleDingTalk(event) {
  const reason = classify(event, { allGroupMessages: config.push.all_group_messages !== false });
  if (!reason) return;
  const id = event.message_id || event.event_id;
  if (!id || seen[id]) return;
  if (config.push.muted_conversations !== true && reason !== "dm" && await isMuted(event.conversation_id)) return;
  if (sentBySelf(event, await currentUser().catch(() => null))) return;
  seen[id] = Date.now();
  await saveJson(seenPath, seen);
  const peer = reason === "dm" ? await dmPeer(event.conversation_id) : null;
  const senderName = reason === "dm"
    ? peer.name
    : await realName(event.sender_open_dingtalk_id, cleanName(event.sender), event.conversation_id);
  const namedEvent = {
    ...event,
    sender: senderName,
    sender_open_dingtalk_id: reason === "dm" && peer.openId ? peer.openId : event.sender_open_dingtalk_id,
  };
  const name = reason === "dm" ? peer.name : await dingTalkTitle(namedEvent, reason);
  const images = await imageUrls(namedEvent);
  if (images.length) {
    const extra = textWithoutImages(messageBody(namedEvent));
    const topicCaption = reason === "dm" ? "" : formatTopicSender(namedEvent);
    if (extra) await deliverToTopic(namedEvent, reason, name, reason === "dm" ? extra : `${topicCaption}${extra}`);
    for (const url of images) await deliverImageToTopic(namedEvent, reason, name, url, extra ? "" : topicCaption);
  } else {
    await deliverToTopic(namedEvent, reason, name, formatTopicPush(namedEvent, reason));
  }
  pushes = rememberPush(pushes, pushIndexLine(namedEvent, reason, name));
  await saveJson(pushPath, pushes);
}

async function isMuted(conversationId) {
  if (!conversationId) return true;
  const cached = muteCache.get(conversationId);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.muted;
  try {
    const result = await runDws(["chat", "group", "user-settings", "query", "--groups", conversationId]);
    const muted = mutedForConversation(result.data, conversationId);
    const value = muted == null ? true : muted;
    muteCache.set(conversationId, { muted: value, at: Date.now() });
    return value;
  } catch (error) {
    console.error("查询免打扰失败，群消息不推送：", error.message);
    return true;
  }
}

const dmPeerCache = new Map();

async function dmPeer(conversationId) {
  if (dmPeerCache.has(conversationId)) return dmPeerCache.get(conversationId);
  const title = cleanName(await conversationName(conversationId));
  const person = title ? await personByName(title) : { name: "", openId: "" };
  const peer = {
    name: person.name || title || "私聊",
    openId: person.openId || "",
  };
  dmPeerCache.set(conversationId, peer);
  return peer;
}

async function dingTalkTitle(event, reason) {
  if (reason === "dm") return cleanName(event.sender) || "私聊";
  return cleanName(await conversationName(event.conversation_id)) || event.conversation_id || "群聊";
}

async function imageUrls(event) {
  const raw = `${event.content || ""}\n${event.text || ""}`;
  if (!isImageContent(raw)) return [];
  let ids = [];
  if (event.message_id) {
    try {
      const detail = await runDws(["chat", "+messages-mget", "--msg-ids", event.message_id, "--no-reactions", "--no-threads"]);
      ids = imageResourceIds(detail.data);
    } catch (error) {
      console.error("读取图片资源失败：", error.message);
    }
  }
  if (!ids.length) ids = extractMediaIds(raw);
  const urls = [];
  for (const mediaId of ids) {
    try {
      urls.push(await downloadImageUrl({
        messageId: event.message_id,
        conversationId: event.conversation_id,
        mediaId,
      }));
    } catch (error) {
      console.error("下载图片失败：", error.message);
    }
  }
  return urls;
}

async function deliverImageToTopic(event, reason, name, url, caption) {
  const dingTalkId = event.conversation_id;
  if (!dingTalkId) return;
  let record = topicFor(topics, dingTalkId);
  if (!record?.topicId) record = await withTopicLock(dingTalkId, () => createTopic(dingTalkId, name, event, reason));
  if (!record?.topicId) return;
  await sendImage({ type: "topic", conversation_id: record.topicId }, url, caption);
}

async function sendImage(target, url, caption) {
  const message = { type: "image", content: url };
  if (caption) {
    message.caption = caption;
    message.caption_type = "markdown";
  }
  await chat.request("message.send", { target, message });
}

async function deliverToTopic(event, reason, name, text) {
  const dingTalkId = event.conversation_id;
  if (!dingTalkId) {
    await sendText(text);
    return;
  }
  let record = topicFor(topics, dingTalkId);
  if (!record?.topicId) record = await withTopicLock(dingTalkId, () => createTopic(dingTalkId, name, event, reason));
  if (!record?.topicId) {
    await sendText(text);
    return;
  }
  await sendToConversation(record.topicId, "topic", text);
}

async function createTopic(dingTalkId, name, event, reason) {
  const existing = topicFor(topics, dingTalkId);
  if (existing?.topicId) return existing;
  const created = await sendText(creationText(name));
  const ids = idsFromSend(created);
  if (!ids.conversationId || !ids.messageId) {
    console.error("创建话题失败：发送源头消息没有返回会话或消息 ID");
    return null;
  }
  topics.parentConversationId = ids.conversationId;
  const createdTopic = await chat.request("conversation.topic.create", {
    conversation_id: ids.conversationId,
    source_message_id: ids.messageId,
  });
  const topicId = topicIdFromCreate(createdTopic);
  if (!topicId) {
    console.error("创建话题失败：没有返回话题 ID");
    return null;
  }
  const record = rememberTopic(topics, dingTalkId, {
    topicId,
    name,
    kind: reason === "dm" ? "dm" : "group",
    openDingTalkId: event.sender_open_dingtalk_id || "",
    dingTalkConversationId: dingTalkId,
  });
  await saveJson(topicsPath, topics);
  return record;
}

function withTopicLock(dingTalkId, fn) {
  const previous = topicLocks.get(dingTalkId) || Promise.resolve();
  const current = previous.then(fn, fn);
  topicLocks.set(dingTalkId, current);
  return current;
}

async function relayTopicReply(payload) {
  const messageId = payload.message?.id;
  if (messageId && seen[messageId]) return;
  if (messageId) {
    seen[messageId] = Date.now();
    await saveJson(seenPath, seen);
  }
  const topicId = payload.conversation?.id;
  const record = findByTopicId(topics, topicId);
  if (!record) return;
  const body = payload.message?.body || {};
  const attachment = attachmentFromBody(body);
  if (attachment) {
    try {
      await relayAttachment(payload, record, attachment);
      await markTopicSent(payload);
    } catch (error) {
      console.error("转发图片失败：", error.message, JSON.stringify(body));
      await sendToConversation(topicId, "topic", `转发到钉钉失败：${error.message}`);
    }
    return;
  }
  const text = String(body.content || payload.message?.summary || "").trim();
  if (!text) {
    await sendToConversation(topicId, "topic", "这条消息没有可转发的文字。");
    return;
  }
  try {
    await sendDingTalk(record, ["--text", text], payload.message?.id || topicId);
    await markTopicSent(payload);
  } catch (error) {
    await sendToConversation(topicId, "topic", `转发到钉钉失败：${error.message}`);
  }
}

async function relayAttachment(payload, record, attachment) {
  const urls = [...attachment.directUrl ? [attachment.directUrl] : [], ...await readAttachmentUrls(payload, attachment.fileIds)];
  if (!urls.length) throw new Error("图片消息里没有可下载的文件");
  const relativePath = await downloadToWorkspace(urls[0], payload.message?.id || "image");
  const markdown = attachment.caption
    ? `${attachment.caption}\n\n![图片](${relativePath})`
    : `![图片](${relativePath})`;
  await sendDingTalk(record, ["--markdown", markdown], payload.message?.id || record.topicId);
}

async function readAttachmentUrls(payload, fileIds) {
  if (!fileIds.length) return [];
  const result = await chat.request("temporary_files.read_urls", {
    conversation_id: payload.conversation.id,
    message_id: payload.message.id,
    file_ids: fileIds,
  });
  return urlsFromReadUrls(result);
}

async function downloadToWorkspace(url, baseName) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载即应图片失败 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const ext = extensionFrom(response.headers.get("content-type"), url);
  const relativePath = `data/outbound/${String(baseName).replace(/[^A-Za-z0-9._-]/g, "_")}${ext}`;
  await mkdir("data/outbound", { recursive: true });
  await writeFile(relativePath, bytes);
  return relativePath;
}

function extensionFrom(contentType, url) {
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return ".jpg";
  if (contentType?.includes("gif")) return ".gif";
  if (contentType?.includes("webp")) return ".webp";
  const match = String(url).match(/\.(png|jpe?g|gif|webp)(?:\?|$)/i);
  return match ? `.${match[1].toLowerCase()}` : ".png";
}

async function markTopicSent(payload) {
  const conversationId = payload.conversation?.id;
  const messageId = payload.message?.id;
  if (!conversationId || !messageId) return;
  await chat.request("message.reaction.set", {
    conversation_id: conversationId,
    message_id: messageId,
    text: "✌️",
    reacted: true,
  }).catch((error) => console.error("贴发送成功表情失败：", error.message));
}

async function sendDingTalk(record, contentArgs, idempotencyKey) {
  const sent = await runDws([
    "chat", "+messages-send", "--as", "user",
    "--ai-tag=false",
    ...relayTargetArgs(record),
    ...contentArgs,
    "--wait-delivery",
    "--idempotency-key", String(idempotencyKey).replace(/[^A-Za-z0-9]/g, "").slice(0, 32) || "relay",
  ], { timeoutMs: 60_000 });
  await stampSentMessage(sent.data, {
    conversationId: record.dingTalkConversationId,
    emotionPath,
  }).catch((error) => console.error("贴使用即应发送失败：", error.message));
}

function relayTargetArgs(record) {
  if (record.kind === "dm") {
    if (!record.openDingTalkId) throw new Error("没有对方的钉钉 ID");
    return ["--open-dingtalk-id", record.openDingTalkId];
  }
  return ["--group", record.dingTalkConversationId];
}

function cleanName(value) {
  const text = String(value ?? "").trim();
  return !text || text === "null" ? "" : text;
}

async function conversationName(conversationId) {
  if (!conversationId) return "";
  try {
    const result = await runDws(["chat", "+conversation-info", "--group", conversationId], { timeoutMs: 30_000 });
    const title = conversationTitle(result.data);
    if (!title) console.error("会话信息没有标题：", conversationId);
    return title;
  } catch (error) {
    console.error("查询群名失败：", error.message);
    return "";
  }
}

async function sendText(text) {
  return sendToUser(text);
}

async function sendToUser(text) {
  let last;
  for (const content of splitText(text, 3500)) {
    last = await chat.request("message.send", {
      target: { type: "user", user_id: config.magicchat.user_id },
      message: { type: "markdown", content },
    });
  }
  return last;
}

async function sendToConversation(conversationId, type, text) {
  let last;
  for (const content of splitText(text, 3500)) {
    last = await chat.request("message.send", {
      target: { type, conversation_id: conversationId },
      message: { type: "markdown", content },
    });
  }
  return last;
}

function splitText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length ? chunks : ["（空消息）"];
}

function listen(delay) {
  setTimeout(() => {
    if (stopped) return;
    stream = startEventStream({
      onReady: () => console.log("钉钉事件订阅已就绪。"),
      onEvent: (event) => {
        handleDingTalk(event).catch((error) => console.error("推送失败：", error.message));
      },
      onExit: (code, signal) => {
        if (stopped) return;
        console.error(`钉钉监听退出 code=${code} signal=${signal || ""}`);
        listen(3000);
      },
    });
  }, delay);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function shutdown() {
  stopped = true;
  stream?.kill("SIGTERM");
  chat?.close();
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
