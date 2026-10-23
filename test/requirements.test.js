import assert from "node:assert/strict";
import test from "node:test";
import { classify, conversationTitle, formatMainPush, formatTopicPush, isAtAll, mutedForConversation, pushIndexLine } from "../src/push.js";
import { splitProtectedAndRounds, toAnthropicMessages, truncateOldToolResults, visibleHistory } from "../src/session.js";
import { attachmentFromBody, extractMediaIds, fileDownloadInfo, fileRefs, imageResourceIds, textWithoutFiles, textWithoutImages } from "../src/media.js";
import { creationText, findByTopicId, idsFromSend, rememberTopic, topicFor, topicIdFromCreate } from "../src/topics.js";
import { findEmotionId, sentMessageRef } from "../src/stamp.js";
import { orgUserName, pickRealName, selectPeer, sentBySelf, userIdFromLookup } from "../src/names.js";
import { isRetryable } from "../src/dws.js";
import { toolKey } from "../src/tools.js";

test("默认推送所有群消息，关闭后只保留提及", () => {
  assert.equal(classify({ type: "user_im_message_receive_o2o_all" }), "dm");
  assert.equal(classify({ type: "user_im_message_receive_at" }), "mention");
  assert.equal(classify({ type: "user_im_message_receive_group_all", content: "普通消息" }), "group");
  assert.equal(classify({ type: "user_im_message_receive_group_all", content: "普通消息" }, { allGroupMessages: false }), null);
  assert.equal(classify({ type: "user_im_message_receive_group_all", content: "@所有人 发布" }, { allGroupMessages: false }), "at-all");
  assert.equal(isAtAll({ content: "请看 @all" }), true);
});

test("群名取 conversationInfo.title", () => {
  const payload = { result: { conversationInfo: { title: "买菜群", openConversationId: "cidn7Xx3LJEGfbeCl3DuZUq3Q==" } } };
  assert.equal(conversationTitle(payload), "买菜群");
});

test("按会话识别真实免打扰结果", () => {
  const payload = {
    result: {
      settings: [
        { notificationOff: 1, openConversationId: "muted", success: true },
        { notificationOff: 0, openConversationId: "open", success: true },
      ],
    },
  };
  assert.equal(mutedForConversation(payload, "muted"), true);
  assert.equal(mutedForConversation(payload, "open"), false);
  assert.equal(mutedForConversation(payload, "missing"), null);
});

test("主对话和话题使用不同推送格式", () => {
  const dm = { sender: "赵然", content: "在吗" };
  const group = { sender: "陈佳", content: "今晚发布" };
  assert.equal(formatMainPush(dm, "dm", "赵然"), "> 收到来自 **赵然** 的消息\n\n在吗");
  assert.equal(formatMainPush(group, "mention", "销售群"), "> 收到来自 **陈佳** 在 **销售群** 的消息\n\n今晚发布");
  assert.equal(formatTopicPush(dm, "dm"), "在吗");
  assert.equal(formatTopicPush(group, "at-all"), "**陈佳**：今晚发布");
});

test("话题图片消息能取出文件 ID", () => {
  const attachment = attachmentFromBody({ type: "image", file_id: "file-1", caption: "看图" });
  assert.equal(attachment.type, "image");
  assert.deepEqual(attachment.fileIds, ["file-1"]);
  assert.equal(attachment.caption, "看图");
  assert.equal(attachmentFromBody({ type: "text", content: "你好" }), null);
});

test("文件消息能取出文件名和 fileId", () => {
  const text = "[文件] 招标机构-百智办公阶段成果汇报.html fileId: NDoBb60VLQ05MaOkcnOZvkMlJlemrZQ3 注意：如需下载使用dws drive download命令下载";
  assert.deepEqual(fileRefs(text), [{ name: "招标机构-百智办公阶段成果汇报.html", fileId: "NDoBb60VLQ05MaOkcnOZvkMlJlemrZQ3" }]);
  assert.equal(textWithoutFiles(text), "");
  assert.equal(fileDownloadInfo({ result: { downloadUrl: "https://example.com/a", fileName: "a.html", headers: {} } }).url, "https://example.com/a");
});

test("从图片消息里取出 mediaId", () => {
  const text = "[图片消息](mediaId=$iwEcAqNwbmcDAQTRCswF0QVW) 注意：如需下载使用dws chat message download-media命令下载";
  assert.deepEqual(extractMediaIds(text), ["$iwEcAqNwbmcDAQTRCswF0QVW"]);
  assert.equal(textWithoutImages(text), "");
  assert.deepEqual(imageResourceIds({
    messages: [{ resourceRefs: [
      { resourceId: "$thumb", resourceIdType: "mediaId", type: "mediaId" },
      { resourceId: "@image", resourceIdType: "mediaId", type: "mediaId", contentType: "image" },
    ] }],
  }), ["@image"]);
});

test("推送索引包含会话名", () => {
  const line = pushIndexLine({
    sender: "陈佳",
    content: "@所有人 发布",
    conversation_id: "cid-1",
    message_id: "msg-1",
    create_time: "2026-10-21 11:07:35",
  }, "at-all", "销售群");
  assert.match(line, /销售群/);
  assert.match(line, /cid-1/);
  assert.match(line, /msg-1/);
});

test("正文或结构化标记都能识别@所有人", () => {
  assert.equal(classify({ type: "user_im_message_receive_group_all", text: "@所有人 发布" }), "at-all");
  assert.equal(isAtAll({ extension: { atAll: true } }), true);
});

test("每次只带最近 6 句可见历史和当前指令", () => {
  const history = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i}` }));
  const window = visibleHistory(history);
  assert.equal(window.length, 6);
  assert.equal(window[0].text, "m2");
  const messages = toAnthropicMessages(window, "现在处理");
  assert.equal(messages.at(-1).content, "现在处理");
  assert.equal(messages[0].role, "user");
});

test("发送回执能取出消息和会话 ID", () => {
  const ref = sentMessageRef({ messageId: "msgABC==", openConversationId: "cidXYZ==" }, "cid-fallback");
  assert.equal(ref.messageId, "msgABC==");
  assert.equal(ref.conversationId, "cidXYZ==");
  assert.equal(findEmotionId({ result: { emotionId: "emo-1" } }), "emo-1");
});

test("自己发送的消息不推送", () => {
  const self = { name: "李昌志", userId: "changzhi.li", openId: "self-oid" };
  assert.equal(sentBySelf({ sender: "火花兄弟", sender_open_dingtalk_id: "self-oid" }, self), true);
  assert.equal(sentBySelf({ sender: "李昌志", sender_open_dingtalk_id: "other" }, self), true);
  assert.equal(sentBySelf({ sender: "毛思特", sender_open_dingtalk_id: "peer" }, { ...self, nick: "毛思特" }), true);
  assert.equal(sentBySelf({ sender: "吴权轩", sender_open_dingtalk_id: "peer" }, self), false);
});

test("单聊对方按会话标题取姓名，不取发送人", () => {
  const peer = selectPeer({
    result: [{ name: "吴权轩", nick: "火花兄弟", openDingTalkId: "peer-1" }],
  }, "火花兄弟");
  assert.equal(peer.name, "吴权轩");
  assert.equal(peer.openId, "peer-1");
});

test("搜索结果用姓名不用昵称", () => {
  const name = pickRealName({
    result: [{ name: "吴权轩", nick: "火花兄弟", openDingTalkId: "oid-1" }],
  }, "oid-1");
  assert.equal(name, "吴权轩");
});

test("通讯录详情取姓名而不是展示名", () => {
  const payload = { result: { orgEmployeeModel: { orgUserId: "u1", orgUserName: "李昌志" } } };
  assert.equal(userIdFromLookup({ result: { userId: "u1" } }), "u1");
  assert.equal(orgUserName(payload), "李昌志");
});

test("证书和网络错误会重试，明确不可重试的不重试", () => {
  assert.equal(isRetryable("tls: failed to verify certificate: x509: certificate signed by unknown authority"), true);
  assert.equal(isRetryable('{"retryable": false, "message": "参数错误"}'), false);
});

test("相同工具和参数只算一次", () => {
  assert.equal(toolKey("send_message", { b: 1, a: 2 }), toolKey("send_message", { a: 2, b: 1 }));
});

test("压缩时保留开头的可见历史和最新工具轮次", () => {
  const messages = [
    { role: "user", content: "历史" },
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "list_unread", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "旧结果" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "2", name: "read_messages", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "新结果" }] },
  ];
  const split = splitProtectedAndRounds(messages);
  assert.equal(split.prefix.length, 1);
  assert.equal(split.prefix[0].content, "历史");
  assert.equal(split.rounds.length, 2);
  assert.equal(split.rounds.at(-1)[1].content[0].content, "新结果");
});

test("已有话题直接复用，没有话题才用创建对话消息", () => {
  const store = { parentConversationId: "", byDingTalk: {} };
  assert.equal(topicFor(store, "cid-1"), null);
  assert.equal(creationText("销售群"), "销售群");
  rememberTopic(store, "cid-1", { topicId: "topic-1", name: "销售群", kind: "group" });
  assert.equal(topicFor(store, "cid-1").topicId, "topic-1");
  assert.equal(findByTopicId(store, "topic-1").name, "销售群");
  assert.equal(idsFromSend({ conversation: { id: "parent" }, message: { id: "msg" } }).messageId, "msg");
  assert.equal(topicIdFromCreate({ conversation: { id: "topic-2" } }), "topic-2");
});

test("压缩时保留最新工具结果", () => {
  const messages = [
    { role: "user", content: [{ type: "tool_result", content: "x".repeat(800) }] },
    { role: "user", content: [{ type: "tool_result", content: "最新结果" }] },
  ];
  const compacted = truncateOldToolResults(messages);
  assert.match(compacted[0].content[0].content, /已压缩/);
  assert.equal(compacted[1].content[0].content, "最新结果");
});
