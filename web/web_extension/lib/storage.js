export function getFromStorage(area, key) {
  return new Promise((resolve) => {
    chrome.storage[area].get([key], (res) => resolve(res?.[key]));
  });
}

export function setInStorage(area, key, value) {
  return new Promise((resolve) => {
    chrome.storage[area].set({ [key]: value }, () => resolve());
  });
}

export function removeFromStorage(area, key) {
  return new Promise((resolve) => {
    chrome.storage[area].remove([key], () => resolve());
  });
}
