// Toggles the in-page floating panel when the user clicks the toolbar icon.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "dn:toggle-panel" });
  } catch (e) {
    // Content script not yet injected (e.g. chrome:// page or freshly installed).
    // Try to inject on demand; will silently fail on restricted URLs.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["content.css"],
      });
      await chrome.tabs.sendMessage(tab.id, { type: "dn:toggle-panel" });
    } catch (_) {
      // Unsupported page (chrome://, web store, etc.) — nothing we can do.
    }
  }
});
