(() => {
  const STATE = {
    isJob: false,
    extracted: null,
    detectedAt: new Date().toISOString(),
    lastError: null,
  };

  function textify(html) {
    if (!html) return "";
    const div = document.createElement("div");
    div.innerHTML = html;
    return (div.textContent || "").replace(/\s+/g, " ").trim();
  }

  function pickFirstH1() {
    const h1 = document.querySelector("h1");
    if (h1) return (h1.textContent || "").trim();
    return "";
  }

  function findMeta(names) {
    for (const n of names) {
      const m = document.querySelector(`meta[property='${n}'], meta[name='${n}']`);
      const c = m?.getAttribute("content");
      if (c) return c.trim();
    }
    return "";
  }

  function parseJobPostingJSONLD() {
    const scripts = Array.from(document.querySelectorAll("script[type='application/ld+json']"));
    for (const s of scripts) {
      const raw = s.textContent?.trim();
      if (!raw) continue;
      try {
        const data = JSON.parse(raw);
        const items = Array.isArray(data) ? data : [data];
        for (const it of items) {
          const t = it?.["@type"];
          const types = Array.isArray(t) ? t : [t];
          if (!types.includes("JobPosting")) continue;
          return it;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  function extractFromJobPosting(jp) {
    const title = jp?.title || "";
    const company = jp?.hiringOrganization?.name || jp?.hiringOrganization || "";
    const loc = jp?.jobLocation;
    let location = "";
    if (Array.isArray(loc) && loc.length) {
      location = loc.map((x) => x?.address?.addressLocality || x?.address?.addressRegion || "").filter(Boolean).join(", ");
    } else if (loc?.address) {
      location = loc.address.addressLocality || loc.address.addressRegion || loc.address.addressCountry || "";
    }
    const jdText = textify(jp?.description || "");
    return { title, company, location, jdText };
  }

  function looksLikeApplyForm() {
    const url = location.href.toLowerCase();
    const urlHit = /(\bjobs\b|\bcareers\b|\bapply\b|lever\.co|greenhouse\.io|workday|icims|smartrecruiters)/.test(url);

    const forms = Array.from(document.forms || []);
    const inputs = Array.from(document.querySelectorAll("input, textarea, select"));

    const text = (document.body?.innerText || "").toLowerCase();
    const kwHit = /(resume|cv|cover letter|application|apply now|submit application)/.test(text);

    const hasFile = inputs.some((el) => el.tagName === "INPUT" && (el.type || "").toLowerCase() === "file");
    const hasEmail = inputs.some((el) => (el.getAttribute("type") || "").toLowerCase() === "email" || /email/.test(el.name || ""));
    const hasPhone = inputs.some((el) => /(tel|phone)/.test((el.getAttribute("type") || "").toLowerCase()) || /phone|mobile|tel/.test(el.name || ""));

    const bigForm = forms.some((f) => f.querySelectorAll("input, textarea, select").length >= 6);

    // If URL matches known ATS, treat as job/apply even if keywords are hidden behind dynamic UI.
    const knownATS = /(jobs\.lever\.co|lever\.co|greenhouse\.io|workday|icims|smartrecruiters)/.test(url);
    return urlHit || knownATS || ((bigForm || hasFile) && (hasEmail || hasPhone) && kwHit);
  }

  function extractJobInfo() {
    const url = location.href;
    const u = new URL(url);

    // Lever apply pages are often missing JSON-LD and sometimes even a clear H1.
    const isLever = /jobs\.lever\.co$/i.test(u.host) || /lever\.co/i.test(u.host);
    const leverCompany = isLever ? (u.pathname.split("/").filter(Boolean)[0] || "") : "";

    const jp = parseJobPostingJSONLD();
    const base = jp ? extractFromJobPosting(jp) : { title: "", company: "", location: "", jdText: "" };

    const leverTitle = isLever
      ? (
          document.querySelector(".posting-headline h2")?.textContent ||
          document.querySelector("[data-qa='posting-name']")?.textContent ||
          document.querySelector("h2")?.textContent ||
          ""
        ).trim()
      : "";

    const title = (base.title || leverTitle || pickFirstH1() || findMeta(["og:title", "twitter:title"]) || document.title || "").trim();

    const companyMeta = findMeta(["og:site_name", "application-name"]).trim();
    const company = (base.company || companyMeta || leverCompany || "").trim();
    const locationGuess = base.location || "";

    // JD: try common containers if not in JSON-LD
    let jdText = base.jdText;
    if (!jdText) {
      const candidates = [
        "[data-testid*='description']",
        "[class*='description']",
        "[id*='description']",
        "article",
        "main",
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        const t = (el?.innerText || "").trim();
        if (t && t.length > 200) {
          jdText = t;
          break;
        }
      }
      if (!jdText) jdText = (document.body?.innerText || "").slice(0, 50000);
    }

    return {
      title,
      company,
      location: (locationGuess || "").trim(),
      jdText: (jdText || "").trim(),
      applyUrl: url,
      pageUrl: url,
    };
  }

  function detect() {
    try {
      const info = extractJobInfo();
      const isJob = looksLikeApplyForm() || !!parseJobPostingJSONLD();
      STATE.isJob = !!isJob;
      STATE.extracted = info;
      STATE.detectedAt = new Date().toISOString();
      STATE.lastError = null;

      chrome.runtime.sendMessage({
        type: "TEJASKRIT_DETECTED",
        payload: { isJob: STATE.isJob },
      });
    } catch (e) {
      STATE.isJob = looksLikeApplyForm();
      STATE.extracted = {
        title: "",
        company: "",
        location: "",
        jdText: "",
        applyUrl: location.href,
        pageUrl: location.href,
      };
      STATE.lastError = e?.message || String(e);
    }
  }

  // -----------------------
  // Autofill
  // -----------------------

  function getLabelTextFor(el) {
    const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();

    // 0) input wrapped by a label
    const wrap = el.closest("label");
    const wrapText = clean(wrap?.textContent);
    if (wrapText) return wrapText;

    // 1) label[for=id]
    const id = el.id;
    if (id) {
      const l = document.querySelector(`label[for='${CSS.escape(id)}']`);
      const t = clean(l?.textContent);
      if (t) return t;
    }

    // 2) aria-labelledby
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/).filter(Boolean);
      const t = clean(ids.map((x) => clean(document.getElementById(x)?.textContent)).join(" "));
      if (t) return t;
    }

    // 3) common form-field containers
    const container = el.closest(
      "li, .application-field, .application-question, .form-field, .field, .input-group, .control-group, .form-group, .question, fieldset, section"
    );
    if (container) {
      const legend = container.querySelector("legend");
      const label = container.querySelector("label");
      const t = clean((legend || label)?.textContent);
      if (t) return t;

      // sometimes the label is a div/span
      const alt = container.querySelector(
        "[class*='label'],[class*='Label'],[class*='title'],[class*='Title'],[data-qa*='label'],[data-testid*='label']"
      );
      const t2 = clean(alt?.textContent);
      if (t2 && t2.length <= 140) return t2;
    }

    // 4) previous siblings (Lever/Greenhouse often render label as a sibling)
    let sib = el.previousElementSibling;
    for (let i = 0; i < 4 && sib; i++) {
      const tag = (sib.tagName || "").toLowerCase();
      const cls = String(sib.className || "").toLowerCase();
      if (tag === "label" || tag === "legend" || /label|title|heading/.test(cls) || tag === "span" || tag === "div") {
        const t = clean(sib.textContent);
        if (t && t.length <= 140) return t;
      }
      sib = sib.previousElementSibling;
    }

    // 5) fallback: search up the tree for nearby label
    let p = el.parentElement;
    for (let i = 0; i < 7 && p; i++) {
      const l = p.querySelector("label");
      const t = clean(l?.textContent);
      if (t) return t;
      p = p.parentElement;
    }

    return "";
  }

  function signature(el) {
    const parts = [
      getLabelTextFor(el),
      el.getAttribute("aria-label") || "",
      el.getAttribute("data-qa") || "",
      el.getAttribute("data-testid") || "",
      el.getAttribute("placeholder") || "",
      el.getAttribute("autocomplete") || "",
      el.name || "",
      el.id || "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return parts;
  }

  function dispatchAll(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setValue(el, value) {
    try {
      const v = value ?? "";
      const tag = el.tagName.toLowerCase();
      if (tag === "select") {
        const opts = Array.from(el.options || []);
        const target = String(v).toLowerCase();
        const match = opts.find((o) => (o.textContent || "").toLowerCase().includes(target));
        if (match) el.value = match.value;
        dispatchAll(el);
        return !!match;
      }

      if (tag === "textarea" || tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "file") return false;

        // React-controlled inputs need valueTracker nudge.
        const lastValue = el.value;
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
        if (setter) setter.call(el, String(v));
        else el.value = String(v);
        const tracker = el._valueTracker;
        if (tracker) tracker.setValue(lastValue);
        dispatchAll(el);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function buildData(profile) {
    const user = profile?.user || {};
    const mp = profile?.profile || {};

    const fullName = user.name || "";
    const parts = String(fullName).trim().split(/\s+/);
    const firstName = parts[0] || "";
    const lastName = parts.slice(1).join(" ");

    const edu0 = Array.isArray(mp.education) ? mp.education[0] : null;
    const loc = (user.prefs && Array.isArray(user.prefs.locations) && user.prefs.locations[0]) ? user.prefs.locations[0] : "";

    return {
      fullName,
      firstName,
      lastName,
      email: user.email || "",
      phone: user.phone || "",
      location: loc,
      linkedin: mp.links?.linkedin || "",
      github: mp.links?.github || "",
      portfolio: mp.links?.portfolio || "",
      college: edu0?.institute || "",
      degree: edu0?.degree || "",
      branch: edu0?.branch || "",
      endYear: edu0?.endYear ? String(edu0.endYear) : "",
      skills: Array.isArray(mp.skills) ? mp.skills.join(", ") : "",
      summary: mp.summary || mp.headline || "",
    };
  }

  function mapField(sig, data) {
    // Highly common ATS patterns
    const s = sig;

    const want = (re) => re.test(s);

    if (want(/first\s*name|given\s*name|fname|job_application\[first_name\]/)) return data.firstName;
    if (want(/last\s*name|surname|lname|family\s*name|job_application\[last_name\]/)) return data.lastName;
    if (want(/full\s*name|name(?!.*company)|candidate\s*name|applicant\s*name|job_application\[name\]/)) return data.fullName;

    if (want(/email|e-mail|job_application\[email\]/)) return data.email;
    if (want(/phone|mobile|tel|telephone|job_application\[phone\]/)) return data.phone;

    // Location / address
    if (want(/current\s*location|where\s*are\s*you\s*based|based\s*in|city\s*you\s*live|residing|residence/)) return data.location;
    if (want(/location|city|state|country/)) return data.location;
    if (want(/address|street|zip|postal|pincode|pin\s*code|district|landmark|permanent\s*address|current\s*address/)) return data.location;

    if (want(/linkedin/)) return data.linkedin;
    if (want(/github/)) return data.github;
    if (want(/portfolio|website|personal\s*site|url/)) return data.portfolio;

    // Education
    if (want(/college|university|institute|institution|school(?!.*email)|school\s*name|college\s*name|university\s*name/)) return data.college;
    if (want(/degree/)) return data.degree;
    if (want(/branch|major|department|stream/)) return data.branch;
    if (want(/graduation|grad\s*year|passing\s*year|end\s*year|batch|year\s*of\s*completion/)) return data.endYear;

    if (want(/skills|tech\s*stack/)) return data.skills;
    if (want(/summary|about|tell\s*us\s*about\s*yourself|cover\s*letter|why\s*do\s*you\s*want/)) return data.summary;

    return null;
  }

  function autofill(profile) {
    const data = buildData(profile);
    const els = Array.from(document.querySelectorAll("input, textarea, select"));

    let filled = 0;
    let skipped = 0;

    for (const el of els) {
      if (el.disabled || el.readOnly) continue;

      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button") continue;

      const sigText = signature(el);
      const val = mapField(sigText, data);
      if (val === null || val === undefined || val === "") {
        skipped++;
        continue;
      }

      const ok = setValue(el, val);
      if (ok) filled++;
    }

    return { filled, skipped };
  }

  // Listener
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "TEJASKRIT_GET_PAGE_INFO") {
      // If popup asks too early, ensure we have at least one detection pass.
      if (!STATE.extracted) detect();
      sendResponse({ ok: true, state: STATE });
      return true;
    }

    if (msg?.type === "TEJASKRIT_FORCE_DETECT") {
      detect();
      sendResponse({ ok: true, state: STATE });
      return true;
    }

    if (msg?.type === "TEJASKRIT_AUTOFILL") {
      try {
        const profile = msg.payload?.profile;
        const result = autofill(profile);
        // Some ATS (Lever/Greenhouse) mounts or rewrites inputs after the first change.
        // Retry once shortly after to catch late-rendered fields.
        setTimeout(() => {
          try {
            autofill(profile);
          } catch {
            // ignore
          }
        }, 750);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
      return true;
    }

    return false;
  });

  // Run detect on load and when DOM changes a bit
  detect();

  let timer = null;
  const obs = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(detect, 800);
  });
  try {
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    // ignore
  }
})();
