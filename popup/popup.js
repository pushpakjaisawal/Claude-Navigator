// popup.js — Claude Navigator popup

document.addEventListener("DOMContentLoaded", () => {

  // Version label always reflects the installed manifest
  const sub = document.getElementById("header-sub");
  if (sub) sub.textContent = "v" + chrome.runtime.getManifest().version.replace(/\.0$/, "");

  // ── Open claude.ai button ────────────────────────────────────────────────
  document.getElementById("open-claude-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://claude.ai" });
    window.close();
  });

  // ── Load saved conversations from chrome.storage ─────────────────────────
  chrome.storage.local.get("cn_index", ({ cn_index }) => {
    const list      = document.getElementById("conv-list");
    const countEl   = document.getElementById("conv-count");
    const index     = cn_index || [];

    countEl.textContent = index.length > 0 ? `${index.length} saved` : "";

    if (index.length === 0) {
      list.innerHTML = `
        <div class="empty-list">
          No conversations saved yet.<br>
          Open <strong>claude.ai</strong> to start.
        </div>`;
      return;
    }

    // Show most recent 20
    index.slice(0, 20).forEach((entry) => {
      const el        = document.createElement("div");
      el.className    = "conv-entry";

      const date      = entry.savedAt
        ? new Date(entry.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
        : "";
      const msgCount  = entry.msgCount ? `${entry.msgCount} msgs` : "";

      el.innerHTML = `
        <div class="conv-title">${escHtml(entry.title || "Claude Chat")}</div>
        <div class="conv-meta">
          <span class="conv-badge">${msgCount}</span>
          <span>${date}</span>
        </div>`;

      el.addEventListener("click", () => {
        if (!/^https:\/\/claude\.ai\//.test(entry.url || "")) return;      // only ever open claude.ai links
        chrome.tabs.create({ url: entry.url });
        window.close();
      });

      list.appendChild(el);
    });
  });
});

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g, "&quot;");
}
