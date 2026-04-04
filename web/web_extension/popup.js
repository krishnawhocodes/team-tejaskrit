import { DEFAULT_CONFIG, STORAGE_KEYS } from "./config.js";
import { getFromStorage, setInStorage } from "./lib/storage.js";
import {
  loginWithEmailPassword,
  clearSession,
  getSession,
} from "./lib/auth.js";
import { ensureUserAndProfile } from "./lib/firestore.js";
import {
  getMyProfile,
  saveQuickProfile,
  upsertPrivateJob,
  upsertApplicationStatus,
  generateTailoredLatex,
  downloadResumePdf,
} from "./lib/tejaskrit.js";
import { makeJobId } from "./lib/utils.js";

const root = document.getElementById("root");

const state = {
  loading: true,
  session: null,
  config: DEFAULT_CONFIG,
  page: null,
  jobId: null,
  appId: null,
  myProfile: null,
  toast: null,
  busy: false,
};

function toast(kind, msg) {
  state.toast = { kind, msg };
  render();
  setTimeout(() => {
    if (state.toast?.msg === msg) {
      state.toast = null;
      render();
    }
  }, 3200);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = String(v);
    else if (k === "value") node.value = v ?? "";
    else if (k === "checked") node.checked = !!v;
    else if (k === "disabled") node.disabled = !!v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false)
      node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

async function loadConfig() {
  const saved = (await getFromStorage("sync", STORAGE_KEYS.config)) || {};
  const merged = { ...DEFAULT_CONFIG, ...saved };
  merged.autofill = {
    ...(DEFAULT_CONFIG.autofill || {}),
    ...(merged.autofill || {}),
  };
  merged.firebase = DEFAULT_CONFIG.firebase;
  merged.backendBaseUrl = DEFAULT_CONFIG.backendBaseUrl;
  state.config = merged;
}

async function saveConfig(patch) {
  state.config = {
    ...state.config,
    ...patch,
    firebase: DEFAULT_CONFIG.firebase,
    backendBaseUrl: DEFAULT_CONFIG.backendBaseUrl,
  };
  await setInStorage("sync", STORAGE_KEYS.config, state.config);
}

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      resolve((tabs && tabs[0]) || null);
    });
  });
}

async function askContent(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok: false, error: err.message, _noReceiver: true });
      resolve(resp || { ok: false, error: "No response" });
    });
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch {
    // ignore
  }
}

async function askContentEnsured(tabId, msg) {
  const resp = await askContent(tabId, msg);
  if (resp?.ok) return resp;

  const e = (resp?.error || "").toLowerCase();
  const noReceiver = resp?._noReceiver && (e.includes("receiving end") || e.includes("could not establish") || e.includes("no receiver"));
  if (!noReceiver) return resp;

  await ensureContentScript(tabId);
  await new Promise((r) => setTimeout(r, 250));
  return await askContent(tabId, msg);
}

async function refreshPageInfo() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    state.page = null;
    state.jobId = null;
    return;
  }

  const resp = await askContentEnsured(tab.id, { type: "TEJASKRIT_GET_PAGE_INFO" });
  if (!resp?.ok) {
    state.page = { isJob: false, extracted: null, detectedAt: null, lastError: resp?.error || "No response" };
    state.jobId = await makeJobId(tab.url || "");
    state.appId = state.session?.uid && state.jobId ? `${state.session.uid}__${state.jobId}` : null;
    return;
  }

  state.page = resp.state;
  const applyUrl = resp.state?.extracted?.applyUrl || tab.url || "";
  state.jobId = await makeJobId(applyUrl);
  const sess = state.session;
  state.appId = sess?.uid && state.jobId ? `${sess.uid}__${state.jobId}` : null;
}

function formatJobCard(ex) {
  if (!ex) return el("div", { class: "small" }, ["No job details found on this page."]);

  return el("div", { class: "details" }, [
    el("div", { class: "small" }, [
      el("span", { class: "k" }, ["Role: "]),
      el("span", { class: "v" }, [ex.title || "—"]),
    ]),
    el("div", { class: "small" }, [
      el("span", { class: "k" }, ["Company: "]),
      el("span", { class: "v" }, [ex.company || "—"]),
    ]),
    el("div", { class: "small" }, [
      el("span", { class: "k" }, ["URL: "]),
      el("span", { class: "v" }, [ex.applyUrl ? ex.applyUrl.slice(0, 52) + (ex.applyUrl.length > 52 ? "…" : "") : "—"]),
    ]),
    el("div", { class: "code", style: "margin-top:6px" }, [state.jobId ? `jobId: ${state.jobId}` : "jobId: —"]),
  ]);
}

function formatPageError() {
  const err = state.page?.lastError;
  if (!err) return null;
  return el("div", { class: "small", style: "margin-top:8px;color:#fca5a5" }, [
    `Can't read this page yet: ${err}. Try refreshing the tab once, then click Refresh in the popup.`,
  ]);
}

function LoadingView() {
  return el("div", { class: "card" }, [
    el("div", { style: "font-weight:800" }, ["Loading…"]),
    el("div", { class: "small", style: "margin-top:6px" }, [
      "Fetching your session and profile.",
    ]),
  ]);
}

function LoginView() {
  const email = el("input", { class: "input", type: "email", placeholder: "Email" });
  const password = el("input", { class: "input", type: "password", placeholder: "Password" });

  const doLogin = async () => {
    try {
      state.busy = true;
      render();
      await loginWithEmailPassword(email.value.trim(), password.value);
      state.session = await getSession();
      await ensureUserAndProfile();
      await refreshPageInfo();
      state.myProfile = await getMyProfile().catch(() => null);
      toast("ok", "Logged in");
    } catch (e) {
      toast("err", e?.message || String(e));
    } finally {
      state.busy = false;
      render();
    }
  };

  return el("div", {}, [
    el("div", { class: "card" }, [
      el("div", { class: "row space" }, [
        el("div", {}, [el("div", { style: "font-weight:800" }, ["Sign in"]), el("div", { class: "small" }, ["Email + password"])]),
        el("span", { class: "badge" }, ["MVP"]),
      ]),
      el("div", { class: "hr" }),
      el("div", { class: "label" }, ["Email"]),
      email,
      el("div", { style: "height:8px" }),
      el("div", { class: "label" }, ["Password"]),
      password,
      el("div", { style: "height:10px" }),
      el("button", { class: "btn primary", onClick: doLogin, disabled: state.busy }, ["Login"]),
      el("div", { class: "small", style: "margin-top:10px" }, [
        "Use the same credentials as your Tejaskrit Candidate Panel account.",
      ]),
    ]),
    SettingsCard(),
  ]);
}

function SettingsCard() {
  const cfg = state.config;
  const toggles = cfg.autofill || {};

  const toggleRow = (key, label) => {
    const box = el("input", { type: "checkbox" });
    box.checked = !!toggles[key];
    box.addEventListener("change", async () => {
      await saveConfig({
        ...state.config,
        autofill: { ...state.config.autofill, [key]: box.checked },
      });
      toast("ok", "Saved settings");
    });

    return el("div", { class: "toggle" }, [
      el("div", { class: "small" }, [label]),
      box,
    ]);
  };

  return el("div", { class: "card" }, [
    el("div", { style: "font-weight:800" }, ["Settings"]),
    el("div", { class: "hr" }),
    el("div", { class: "label" }, ["Autofill toggles"]),
    toggleRow("name", "Name"),
    toggleRow("email", "Email"),
    toggleRow("phone", "Phone"),
    toggleRow("location", "Location"),
    toggleRow("links", "Links (LinkedIn/GitHub/Portfolio)"),
    toggleRow("education", "Education"),
    toggleRow("skills", "Skills"),
    toggleRow("summary", "Summary/About"),
  ]);
}

function ProfileMiniEditorCard() {
  const prof = state.myProfile;
  const user = prof?.user || {};
  const mp = prof?.profile || {};
  const edu0 = Array.isArray(mp.education) ? mp.education[0] : null;
  const loc = user?.prefs?.locations?.[0] || "";

  const name = el("input", { class: "input", placeholder: "Full name" });
  const phone = el("input", { class: "input", placeholder: "Phone" });
  const location = el("input", { class: "input", placeholder: "Location" });
  const college = el("input", { class: "input", placeholder: "College / University" });
  const degree = el("input", { class: "input", placeholder: "Degree (e.g. B.Tech)" });
  const branch = el("input", { class: "input", placeholder: "Branch" });
  const endYear = el("input", { class: "input", placeholder: "Graduation year (e.g. 2026)" });
  const linkedin = el("input", { class: "input", placeholder: "LinkedIn URL" });
  const github = el("input", { class: "input", placeholder: "GitHub URL" });
  const portfolio = el("input", { class: "input", placeholder: "Portfolio URL" });
  const skills = el("input", { class: "input", placeholder: "Skills (comma separated)" });
  const summary = el("textarea", { class: "input", placeholder: "Short summary (2-3 lines)", rows: "3" });

  // Prefill from Firestore
  name.value = user.name || "";
  phone.value = user.phone || "";
  location.value = loc || "";
  college.value = edu0?.institute || "";
  degree.value = edu0?.degree || "";
  branch.value = edu0?.branch || "";
  endYear.value = edu0?.endYear ? String(edu0.endYear) : "";
  linkedin.value = mp.links?.linkedin || "";
  github.value = mp.links?.github || "";
  portfolio.value = mp.links?.portfolio || "";
  skills.value = Array.isArray(mp.skills) ? mp.skills.join(", ") : "";
  summary.value = mp.summary || mp.headline || "";

  const save = async () => {
    try {
      state.busy = true;
      render();
      await saveQuickProfile({
        name: name.value.trim(),
        phone: phone.value.trim(),
        location: location.value.trim(),
        college: college.value.trim(),
        degree: degree.value.trim(),
        branch: branch.value.trim(),
        endYear: endYear.value.trim(),
        linkedin: linkedin.value.trim(),
        github: github.value.trim(),
        portfolio: portfolio.value.trim(),
        skills: skills.value,
        summary: summary.value,
      });

      // refresh cached profile so the editor reflects saved values
      state.myProfile = await getMyProfile().catch(() => state.myProfile);
      toast("ok", "Profile saved");
    } catch (e) {
      toast("err", e?.message || String(e));
    } finally {
      state.busy = false;
      render();
    }
  };

  return el("div", { class: "card" }, [
    el("div", { class: "row space" }, [
      el("div", {}, [el("div", { style: "font-weight:800" }, ["Quick Profile"]), el("div", { class: "small" }, ["Used for autofill"])]),
      el("span", { class: "badge" }, ["Edit"]),
    ]),
    el("div", { class: "hr" }),
    el("div", { class: "label" }, ["Name"]),
    name,
    el("div", { style: "height:8px" }),
    el("div", { class: "grid2" }, [
      el("div", {}, [el("div", { class: "label" }, ["Phone"]), phone]),
      el("div", {}, [el("div", { class: "label" }, ["Location"]), location]),
    ]),
    el("div", { style: "height:8px" }),
    el("div", { class: "label" }, ["College"]),
    college,
    el("div", { style: "height:8px" }),
    el("div", { class: "grid2" }, [
      el("div", {}, [el("div", { class: "label" }, ["Degree"]), degree]),
      el("div", {}, [el("div", { class: "label" }, ["Branch"]), branch]),
    ]),
    el("div", { style: "height:8px" }),
    el("div", { class: "label" }, ["Graduation year"]),
    endYear,
    el("div", { style: "height:8px" }),
    el("div", { class: "label" }, ["Links"]),
    linkedin,
    el("div", { style: "height:6px" }),
    github,
    el("div", { style: "height:6px" }),
    portfolio,
    el("div", { style: "height:8px" }),
    el("div", { class: "label" }, ["Skills"]),
    skills,
    el("div", { style: "height:8px" }),
    el("div", { class: "label" }, ["Summary"]),
    summary,
    el("div", { style: "height:10px" }),
    el("button", { class: "btn secondary", onClick: save, disabled: state.busy }, ["Save profile"]),
  ]);
}

function MainView() {
  const sess = state.session;
  const isJob = !!state.page?.isJob;
  const ex = state.page?.extracted;

  const jobBadge = isJob ? el("span", { class: "badge ok" }, ["Job detected ✅"]) : el("span", { class: "badge err" }, ["Not a job page"]);

  const refresh = async () => {
    try {
      state.busy = true;
      render();
      const tab = await getActiveTab();
      if (tab?.id) await askContentEnsured(tab.id, { type: "TEJASKRIT_FORCE_DETECT" });
      await refreshPageInfo();
    } finally {
      state.busy = false;
      render();
    }
  };

  const logout = async () => {
    await clearSession();
    state.session = null;
    state.page = null;
    state.jobId = null;
    state.appId = null;
    state.myProfile = null;
    toast("ok", "Logged out");
    render();
  };

  const runAutofill = async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return toast("err", "No active tab");
    // Even if job extraction fails, we can still autofill generic application forms.
    if (!state.page) await refreshPageInfo();

    try {
      state.busy = true;
      render();

      const prof = state.myProfile || (await getMyProfile());
      state.myProfile = prof;

      // Apply toggle filters
      const t = state.config.autofill || {};
      const filtered = JSON.parse(JSON.stringify(prof));
      if (!t.name) filtered.user.name = "";
      if (!t.email) filtered.user.email = "";
      if (!t.phone) filtered.user.phone = "";
      if (!t.location) filtered.user.prefs = { ...(filtered.user.prefs || {}), locations: [] };
      if (!t.links) filtered.profile.links = { linkedin: "", github: "", portfolio: "" };
      if (!t.education) filtered.profile.education = [];
      if (!t.skills) filtered.profile.skills = [];
      if (!t.summary) filtered.profile.summary = "";

      const resp = await askContentEnsured(tab.id, { type: "TEJASKRIT_AUTOFILL", payload: { profile: filtered } });
      if (!resp?.ok) throw new Error(resp?.error || "Autofill failed");
      toast("ok", `Autofill done · filled ${resp.result?.filled || 0} fields`);
    } catch (e) {
      toast("err", e?.message || String(e));
    } finally {
      state.busy = false;
      render();
    }
  };

  const ensureJobReady = async () => {
    if (!state.jobId) throw new Error("Couldn't compute jobId for this page");
    await upsertPrivateJob(state.jobId, {
      ...ex,
      pageUrl: ex?.pageUrl,
      applyUrl: ex?.applyUrl,
      jdText: ex?.jdText,
    });
  };

  const saveStatus = async (status) => {
    if (!ex) return toast("err", "No job info found");
    try {
      state.busy = true;
      render();
      await ensureJobReady();
      const appId = await upsertApplicationStatus({
        jobId: state.jobId,
        status,
        pageUrl: ex.applyUrl,
        detectedAts: state.page?.detectedAt,
      });
      state.appId = appId;
      toast("ok", status === "applied" ? "Marked as Applied" : "Saved to tracker");
    } catch (e) {
      toast("err", e?.message || String(e));
    } finally {
      state.busy = false;
      render();
    }
  };

  const genResume = async () => {
    if (!ex) return toast("err", "No job info found");
    try {
      state.busy = true;
      render();
      await ensureJobReady();
      const out = await generateTailoredLatex(state.jobId);
      state.appId = out.applicationId;
      toast("ok", "Resume generated (LaTeX) — ready to download");
    } catch (e) {
      toast("err", e?.message || String(e));
    } finally {
      state.busy = false;
      render();
    }
  };

  const download = async () => {
    try {
      state.busy = true;
      render();
      if (!state.appId) throw new Error("No applicationId yet. Generate resume first.");
      await downloadResumePdf(state.appId);
      toast("ok", "Download started");
    } catch (e) {
      toast("err", e?.message || String(e));
    } finally {
      state.busy = false;
      render();
    }
  };

  const openTracker = async () => {
    const base = (DEFAULT_CONFIG.backendBaseUrl || "").replace(/\/$/, "");
    chrome.tabs.create({ url: `${base}/tracker` });
  };

  return el("div", {}, [
    state.toast
      ? el("div", { class: `toast ${state.toast.kind === "ok" ? "ok" : "err"}` }, [state.toast.msg])
      : null,

    el("div", { class: "card" }, [
      el("div", { class: "row space" }, [
        el("div", {}, [
          el("div", { style: "font-weight:800" }, ["Current page"]),
          el("div", { class: "small" }, [sess?.email || ""]),
        ]),
        jobBadge,
      ]),
      el("div", { class: "hr" }),
      formatJobCard(ex),
      formatPageError(),
      el("div", { style: "height:10px" }),
      el("div", { class: "footer" }, [
        el("button", { class: "btn secondary", onClick: refresh, disabled: state.busy }, ["Refresh"]),
        el("button", { class: "btn secondary", onClick: logout, disabled: state.busy }, ["Logout"]),
      ]),
    ]),

    ProfileMiniEditorCard(),

    el("div", { class: "card" }, [
      el("div", { style: "font-weight:800" }, ["Actions"]),
      el("div", { class: "small" }, ["Autofill can’t upload files — you’ll download resume and upload manually."]),
      el("div", { class: "hr" }),
      el("button", { class: "btn primary", onClick: runAutofill, disabled: state.busy }, ["Autofill application"]),
      el("div", { style: "height:8px" }),
      el("button", { class: "btn secondary", onClick: () => saveStatus("saved"), disabled: state.busy || !isJob }, ["Save to tracker"]),
      el("div", { style: "height:8px" }),
      el("button", { class: "btn secondary", onClick: genResume, disabled: state.busy || !isJob }, ["Generate tailored resume"]),
      el("div", { style: "height:8px" }),
      el("button", { class: "btn ok", onClick: download, disabled: state.busy || !state.appId }, ["Download resume PDF"]),
      el("div", { style: "height:8px" }),
      el("button", { class: "btn warn", onClick: () => saveStatus("applied"), disabled: state.busy || !isJob }, ["I submitted → Mark Applied"]),
      el("div", { style: "height:10px" }),
      el("button", { class: "btn secondary", onClick: openTracker, disabled: state.busy }, ["Open Tracker"]),
    ]),

    SettingsCard(),
  ]);
}

function render() {
  if (!root) return;
  root.innerHTML = "";
  const view = state.loading ? LoadingView() : (state.session ? MainView() : LoginView());
  root.appendChild(view);
}

async function init() {
  // Render immediately so the popup doesn't look "empty" (header-only)
  state.loading = true;
  render();

  try {
    await loadConfig();
    state.session = await getSession();

    // Show UI ASAP; fetch the rest right after.
    state.loading = false;
    render();

    if (state.session) {
      try {
        await ensureUserAndProfile();
      } catch (e) {
        await clearSession();
        state.session = null;
        toast("err", e?.message || String(e));
        render();
        return;
      }
    }

    await refreshPageInfo();
    if (state.session) state.myProfile = await getMyProfile().catch(() => null);
  } catch (e) {
    console.error(e);
    toast("err", e?.message || String(e));
  } finally {
    state.loading = false;
    render();
  }
}

init();
