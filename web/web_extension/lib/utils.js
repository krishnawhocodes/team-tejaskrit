export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function clampStr(s, max = 50000) {
  const x = String(s ?? "");
  return x.length > max ? x.slice(0, max) : x;
}

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    // remove common tracking params
    const drop = new Set([
      "utm_source","utm_medium","utm_campaign","utm_term","utm_content",
      "gclid","fbclid","igshid","mc_cid","mc_eid","ref","source","_hsenc","_hsmi"
    ]);
    [...u.searchParams.keys()].forEach((k) => {
      if (drop.has(k.toLowerCase())) u.searchParams.delete(k);
    });
    // normalize trailing slash
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return String(url ?? "");
  }
}

export async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return b64;
}

export async function makeJobId(applyUrl) {
  const norm = normalizeUrl(applyUrl || "");
  if (!norm) return null;
  const h = await sha256Base64Url(norm);
  // prefix to reduce collision with other sources
  return `ext_${h.slice(0, 22)}`;
}

export function splitName(full) {
  const s = String(full || "").trim();
  if (!s) return { first: "", last: "" };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export function randomId(len = 20) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}

export function nowIso() {
  return new Date().toISOString();
}

export function isProbablyJobPage(info) {
  return !!(info && (info.title || info.company || info.jdText) && info.applyUrl);
}
