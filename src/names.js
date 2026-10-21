import { runDws } from "./dws.js";

const cache = new Map();

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

export function employeeName(member) {
  return String(member?.memberEmpName || member?.name || "").trim();
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
