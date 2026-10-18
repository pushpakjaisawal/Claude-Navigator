// background.js — Claude Navigator Service Worker v3.6

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log("Claude Navigator v3.6 installed successfully.");
  }
  if (details.reason === "update") {
    console.log("Claude Navigator updated to version", chrome.runtime.getManifest().version);
  }
});

// Handle keyboard command — toggle the sidebar
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-navigator") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.startsWith("https://claude.ai")) {
      chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SIDEBAR" });
    }
  }
});

// Handle messages from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATUS") {
    sendResponse({ status: "ok", version: chrome.runtime.getManifest().version });
  }
  return false;
});
