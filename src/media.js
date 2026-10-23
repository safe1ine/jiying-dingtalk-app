import { mkdir } from "node:fs/promises";
import { runDws } from "./dws.js";

const NOTICE = "注意：如需下载使用dws chat message download-media命令下载";
const FILE_NOTICE = "注意：如需下载使用dws drive download命令下载";

export function attachmentFromBody(body) {
  if (!body || !["image", "file"].includes(body.type)) return null;
  const fileIds = [];
  for (const value of [body.file_id, body.fileId, body.image?.file_id, body.image?.fileId]) {
    if (value) fileIds.push(String(value));
  }
  for (const list of [body.file_ids, body.fileIds, body.files, body.attachments]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string") fileIds.push(item);
      else if (item?.id) fileIds.push(String(item.id));
      else if (item?.file_id) fileIds.push(String(item.file_id));
    }
  }
  const directUrl = /^https?:\/\//.test(String(body.content || "")) ? String(body.content) : "";
  return {
    type: body.type,
    fileIds: [...new Set(fileIds)],
    directUrl,
    caption: String(body.caption || "").trim(),
    name: String(body.name || body.file_name || body.filename || "").trim(),
  };
}

export function urlsFromReadUrls(payload) {
  const found = [];
  walkUrls(payload, found);
  return [...new Set(found.filter((url) => /^https?:\/\//.test(url)))];
}

export function extractMediaIds(text) {
  const ids = [];
  const re = /mediaId=([^)\s]+)/g;
  let match;
  while ((match = re.exec(String(text || "")))) ids.push(decodeURIComponent(match[1]));
  return [...new Set(ids)];
}

export function fileRefs(text) {
  const refs = [];
  const re = /\[文件\]\s*(.+?)\s+fileId:\s*([A-Za-z0-9_-]+)/g;
  let match;
  while ((match = re.exec(String(text || "")))) {
    refs.push({ name: match[1].trim(), fileId: match[2] });
  }
  return refs;
}

export function textWithoutFiles(text) {
  return String(text || "")
    .replace(/\[文件\]\s*.+?\s+fileId:\s*[A-Za-z0-9_-]+/g, "")
    .replace(FILE_NOTICE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function fileDownloadInfo(payload) {
  const root = payload?.result || payload || {};
  const headers = root.headers && typeof root.headers === "object" ? root.headers : {};
  return {
    url: root.downloadUrl || findDownloadUrl(payload),
    name: root.fileName || "",
    headers,
  };
}

export function isImageContent(text) {
  const value = String(text || "");
  return value.includes("图片消息") || extractMediaIds(value).length > 0;
}

export function textWithoutImages(text) {
  return String(text || "")
    .replace(/\[[^\]]*图片消息[^\]]*\]\(mediaId=[^)]+\)/g, "")
    .replace(/\[图片消息\]\(mediaId=[^)]+\)/g, "")
    .replace(NOTICE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function imageResourceIds(detail) {
  const refs = [];
  walk(detail, refs);
  const images = refs.filter((item) => item.contentType === "image" && item.resourceId);
  const chosen = images.length ? images : refs.filter((item) => item.resourceId);
  return [...new Set(chosen.map((item) => item.resourceId))];
}

export function findDownloadUrl(payload) {
  const found = [];
  walkUrls(payload, found);
  return found.find((url) => /^https?:\/\//i.test(url)) || "";
}

export async function downloadImageUrl({ messageId, conversationId, mediaId }) {
  await mkdir("data/media", { recursive: true });
  const output = `data/media/${safeName(messageId)}-${safeName(mediaId).slice(0, 24)}.bin`;
  const result = await runDws([
    "chat", "message", "download-media",
    "--type", "mediaId",
    "--resource-id", mediaId,
    "--message-id", messageId,
    "--open-conversation-id", conversationId,
    "--output", output,
  ], { timeoutMs: 60_000 });
  const url = publicImageUrl(findDownloadUrl(result.data));
  if (!url) throw new Error("下载图片没有返回可访问的地址");
  return url;
}

export function publicImageUrl(url) {
  if (url.startsWith("http://") && url.includes(".aliyuncs.com/")) return `https://${url.slice("http://".length)}`;
  return url;
}

function walk(value, refs) {
  if (!value || typeof value !== "object") return;
  if (value.resourceId && (value.resourceIdType === "mediaId" || value.type === "mediaId")) refs.push(value);
  for (const child of Object.values(value)) walk(child, refs);
}

function walkUrls(value, found) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /url/i.test(key)) found.push(child);
    else walkUrls(child, found);
  }
}

function safeName(value) {
  return String(value || "image").replace(/[^A-Za-z0-9._-]/g, "_");
}
