import { DEFAULT_CONFIG, STORAGE_KEYS } from "../config.js";
import { getFromStorage, setInStorage, removeFromStorage } from "./storage.js";

function parseJwt(token) {
  try {
    const [, payload] = token.split(".");
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export async function loadConfig() {
  const saved = await getFromStorage("sync", STORAGE_KEYS.config);
  return {
    ...DEFAULT_CONFIG,
    ...(saved || {}),
    firebase: DEFAULT_CONFIG.firebase,
    backendBaseUrl: DEFAULT_CONFIG.backendBaseUrl,
  };
}

async function saveSession(sess) {
  await setInStorage("local", STORAGE_KEYS.session, sess);
}

export async function clearSession() {
  await removeFromStorage("local", STORAGE_KEYS.session);
}

export async function getSession() {
  return (await getFromStorage("local", STORAGE_KEYS.session)) || null;
}

export async function isLoggedIn() {
  const s = await getSession();
  return !!(s?.idToken && s?.uid);
}

export async function registerWithEmailPassword(email, password) {
  const cfg = await loadConfig();
  const apiKey = cfg.firebase.apiKey;

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

  const jwt = parseJwt(data.idToken);
  const sess = {
    uid: data.localId,
    email: data.email,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
    exp: jwt?.exp || null,
  };

  await saveSession(sess);
  return sess;
}

export async function loginWithEmailPassword(email, password) {
  const cfg = await loadConfig();
  const apiKey = cfg.firebase.apiKey;

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

  const jwt = parseJwt(data.idToken);
  const sess = {
    uid: data.localId,
    email: data.email,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
    exp: jwt?.exp || null,
  };

  await saveSession(sess);
  return sess;
}

export async function getValidIdToken() {
  const cfg = await loadConfig();
  const apiKey = cfg.firebase.apiKey;

  let sess = await getSession();
  if (!sess?.refreshToken) throw new Error("Not signed in");

  const exp = sess.exp;
  if (exp && exp - nowSec() > 90) return sess.idToken;

  if (sess.expiresAt && sess.expiresAt - Date.now() > 90_000)
    return sess.idToken;

  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", sess.refreshToken);

  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
  );

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      data?.error?.message || `Token refresh failed (HTTP ${res.status})`,
    );
  }

  const jwt = parseJwt(data.id_token);
  sess = {
    ...sess,
    idToken: data.id_token,
    refreshToken: data.refresh_token || sess.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    exp: jwt?.exp || null,
    uid: data.user_id || sess.uid,
  };

  await saveSession(sess);
  return sess.idToken;
}
