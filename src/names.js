import { runDws } from "./dws.js";

const cache = new Map();
let selfProfile;

export async function currentUser() {
  if (selfProfile) return selfProfile;
  const profile = await runDws(["contact", "user", "get-self"]);
  const name = orgUserName(profile.data);
  const userId = userIdFromLookup(profile.data);
  let openId = firstString(profile.data, ["openDingTalkId", "openDingtalkId"]);
  let nick = "";
  if (name) {
    try {
      const searched = await runDws(["contact", "user", "search", "--query", name]);
      const list = searched.data?.result || [];
      const hit = list.find((item) => item.userId === userId) || list.find((item) => item.name === name);
      openId = openId || hit?.openDingTalkId || "";
      nick = hit?.nick || "";
    } catch (error) {
      console.error("查询本人身份失败：", error.message);
    }
  }
  selfProfile = { name, userId, openId, nick };
  return selfProfile;
}

export function selectPeer(results, query) {
  const list = Array.isArray(results) ? results : results?.result || [];
  const hit = list.find((item) => item?.nick === query || item?.name === query) || list[0];
  if (!hit) return { name: "", openId: "" };
  return {
    name: String(hit.name || "").trim(),
    openId: hit.openDingTalkId || "",
  };
}

export function pickRealName(results, openDingTalkId) {
  const list = Array.isArray(results) ? results : results?.result || [];
  const matched = list.find((item) => item?.openDingTalkId === openDingTalkId) || list[0];
  return String(matched?.name || "").trim();
}

export function orgUserName(payload) {
  return firstString(payload, ["orgUserName", "name"]);
}

export function userIdFromLookup(payload) {
  return firstString(payload, ["userId", "orgUserId"]);
}

export function sentBySelf(event, self) {
  if (!self) return false;
  const senderId = event?.sender_open_dingtalk_id || "";
  const senderName = String(event?.sender || "").trim();
  if (self.openId && senderId && senderId === self.openId) return true;
  if (self.userId && senderId && senderId === self.userId) return true;
  if (self.name && senderName && senderName === self.name) return true;
  if (self.nick && senderName && senderName === self.nick) return true;
  return false;
}

export function employeeName(member) {
  return String(member?.memberEmpName || member?.name || "").trim();
}

export async function personByName(query) {
  const text = String(query || "").trim();
  if (!text) return { name: "", openId: "" };
  if (cache.has(`query:${text}`)) return cache.get(`query:${text}`);
  try {
    const searched = await runDws(["contact", "user", "search", "--query", text]);
    const peer = selectPeer(searched.data, text);
    cache.set(`query:${text}`, peer);
    return peer;
  } catch (error) {
    console.error("按会话标题查对方失败：", error.message);
    return { name: text, openId: "" };
  }
}

export async function realName(openDingTalkId, fallback = "", conversationId = "") {
  const key = `${conversationId}:${openDingTalkId || fallback}`;
  if (cache.has(key)) return cache.get(key);
  const name = await lookupName(openDingTalkId, fallback, conversationId);
  cache.set(key, name || fallback);
  return name || fallback;
}

async function lookupName(openDingTalkId, fallback, conversationId) {
  if (conversationId && openDingTalkId) {
    try {
      const members = await runDws([
        "chat", "+chat-members-list",
        "--conversation-id", conversationId,
        "--member-types", "user",
        "--single-page",
      ]);
      const users = members.data?.users || [];
      const hit = users.find((item) => item.openDingtalkId === openDingTalkId || item.openDingTalkId === openDingTalkId);
      const name = employeeName(hit);
      if (name) return name;
    } catch (error) {
      console.error("从群成员查姓名失败：", error.message);
    }
  }
  if (fallback) {
    try {
      const searched = await runDws(["contact", "user", "search", "--query", fallback]);
      const name = pickRealName(searched.data, openDingTalkId);
      if (name) return name;
    } catch (error) {
      console.error("按展示名查姓名失败：", error.message);
    }
  }
  try {
    const lookup = await runDws(["contact", "user", "get-by-open-dingtalk-id", "--id", openDingTalkId]);
    const userId = userIdFromLookup(lookup.data);
    if (!userId) return "";
    const detail = await runDws(["contact", "user", "get", "--ids", userId]);
    return orgUserName(detail.data);
  } catch (error) {
    console.error("按开放 ID 查姓名失败：", error.message);
    return "";
  }
}

function firstString(value, keys) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim() && value[key] !== "null") return value[key].trim();
  }
  for (const child of Object.values(value)) {
    const found = firstString(child, keys);
    if (found) return found;
  }
  return "";
}
