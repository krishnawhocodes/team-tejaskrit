// MV3 Service Worker (module)

const tabState = new Map();

function setBadge(tabId, isJob) {
  try {
    if (typeof tabId !== "number") return;
    chrome.action.setBadgeBackgroundColor({ tabId, color: isJob ? "#10B981" : "#6B7280" });
    chrome.action.setBadgeText({ tabId, text: isJob ? "JOB" : "" });
  } catch {
    // ignore
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "TEJASKRIT_DETECTED") {
    const tabId = sender?.tab?.id;
    if (typeof tabId === "number") {
      tabState.set(tabId, { isJob: !!msg.payload?.isJob, at: Date.now() });
      setBadge(tabId, !!msg.payload?.isJob);
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabState.delete(tabId);
    setBadge(tabId, false);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  // Clear badges on install
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((t) => t.id && setBadge(t.id, false));
  });
});
