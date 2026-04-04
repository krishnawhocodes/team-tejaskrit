import { DEFAULT_CONFIG, STORAGE_KEYS } from "../config.js";
import { getFromStorage } from "./storage.js";
import { getValidIdToken, getSession } from "./auth.js";
import { randomId } from "./utils.js";

async function loadConfig() {
  const saved = await getFromStorage("sync", STORAGE_KEYS.config);
  return {
    ...DEFAULT_CONFIG,
    ...(saved || {}),
    firebase: DEFAULT_CONFIG.firebase,
    backendBaseUrl: DEFAULT_CONFIG.backendBaseUrl,
  };
}

function docName(projectId, docPath) {
  return `projects/${projectId}/databases/(default)/documents/${docPath}`;
}

function isPlainObject(x) {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    !(x instanceof Date)
  );
}

function toFsValue(v) {
  if (v === undefined) return undefined;
  if (v === null) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (Array.isArray(v)) {
    const values = v.map(toFsValue).filter(Boolean);
    return { arrayValue: { values } };
  }
  if (isPlainObject(v)) {
    const fields = {};
    for (const [k, vv] of Object.entries(v)) {
      const fv = toFsValue(vv);
      if (fv !== undefined) fields[k] = fv;
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromFsValue(v) {
  if (!v || typeof v !== "object") return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return new Date(v.timestampValue);
  if ("arrayValue" in v) {
    const arr = v.arrayValue?.values || [];
    return arr.map(fromFsValue);
  }
  if ("mapValue" in v) {
    const out = {};
    const fields = v.mapValue?.fields || {};
    for (const [k, vv] of Object.entries(fields)) out[k] = fromFsValue(vv);
    return out;
  }
  return undefined;
}

function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const fv = toFsValue(v);
    if (fv !== undefined) fields[k] = fv;
  }
  return fields;
}

function fromDoc(doc) {
  const fields = doc?.fields || {};
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromFsValue(v);
  return out;
}

async function authedFetch(url, init = {}) {
  const token = await getValidIdToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

export async function getDoc(docPath) {
  const cfg = await loadConfig();
  const projectId = cfg.firebase.projectId;
  const url = `https://firestore.googleapis.com/v1/${docName(projectId, docPath)}`;
  const res = await authedFetch(url, { method: "GET" });

  if (res.status === 404) return null;

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  return fromDoc(json);
}

export async function setDocMerge(docPath, data, serverTimestampFields = []) {
  const cfg = await loadConfig();
  const projectId = cfg.firebase.projectId;
  const commitUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;
  const name = docName(projectId, docPath);

  const fields = toFields(data);
  const fieldPaths = Object.keys(fields);

  const fieldTransforms = (serverTimestampFields || []).map((f) => ({
    fieldPath: f,
    setToServerValue: "REQUEST_TIME",
  }));

  let writes = [];

  if (fieldPaths.length === 0 && fieldTransforms.length > 0) {
    writes = [{ transform: { document: name, fieldTransforms } }];
  } else {
    const w = {
      update: { name, fields },
      updateMask: { fieldPaths },
    };
    if (fieldTransforms.length) w.updateTransforms = fieldTransforms;
    writes = [w];
  }

  const res = await authedFetch((commitUrl), {
    method: "POST",
    body: JSON.stringify({ writes }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  return true;
}

export async function addDoc(collectionPath, data, serverTimestampFields = []) {
  const id = randomId(20);
  await setDocMerge(`${collectionPath}/${id}`, data, serverTimestampFields);
  return id;
}

export async function ensureUserAndProfile() {
  const sess = await getSession();
  if (!sess?.uid) throw new Error("Not signed in");

  const uid = sess.uid;

  const userPath = `users/${uid}`;
  const user = await getDoc(userPath);

  if (!user) {
    await setDocMerge(
      userPath,
      {
        uid,
        email: sess.email || null,
        role: "student",
        instituteId: null,
        consents: {
          resumeGeneration: true,
          jobMatching: true,
          shareWithTpo: false,
        },
      },
      ["createdAt", "updatedAt", "lastLoginAt"],
    );
  } else {
    await setDocMerge(userPath, {}, ["updatedAt", "lastLoginAt"]);
  }

  const profilePath = `users/${uid}/master_profile/main`;
  const profile = await getDoc(profilePath);

  if (!profile) {
    await setDocMerge(
      profilePath,
      {
        headline: "",
        summary: "",
        links: { linkedin: "", github: "", portfolio: "" },
        skills: [],
        education: [],
        experience: [],
        projects: [],
        achievements: [],
        masterText: "",
      },
      ["updatedAt"],
    );
  }

  return { uid };
}
