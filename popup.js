/**
 * Notepad — Chrome Extension
 */

"use strict";

// Tab expanding logic (Zen Mode check)
const urlParams = new URLSearchParams(window.location.search);
const isTabMode = urlParams.get("mode") === "tab";

if (isTabMode) {
  document.documentElement.style.width = "100%";
  document.documentElement.style.height = "100%";
  document.body.style.width = "100%";
  document.body.style.height = "100%";
}

const STORAGE_NOTES = "notepad_notes";
const STORAGE_ACTIVE = "notepad_active";
const STORAGE_THEME = "notepad_theme";

let notes = [];
let activeId = null;
let statusTimer = null;
let previewOn = false;
let isLightMode = false;
let isSearching = false;

// Headings Collapsible State (keys: noteId, value: Set of hidden heading IDs)
let collapsedStates = {};

// Undo/Redo States
let historyStack = [];
let historyIndex = -1;
let isApplyingHistory = false;

const tabsList = document.getElementById("tabs-list");
const tabsScroll = document.getElementById("tabs-scroll");
const btnNewTab = document.getElementById("btn-new-tab");
const noteTitle = document.getElementById("note-title");
const editor = document.getElementById("editor");
const preview = document.getElementById("preview");
const btnPreview = document.getElementById("btn-preview");
const btnExport = document.getElementById("btn-export");
const btnDelete = document.getElementById("btn-delete");
const btnTheme = document.getElementById("btn-theme");
const btnSearchToggle = document.getElementById("btn-search-toggle");
const btnGrabTab = document.getElementById("btn-grab-tab");
const btnCodeBlock = document.getElementById("btn-code-block");
const btnCopyAll = document.getElementById("btn-copy-all");
const btnPopout = document.getElementById("btn-popout");

if (isTabMode && btnPopout) {
  btnPopout.style.display = "none";
}

const searchWrap = document.getElementById("search-wrap");
const searchInput = document.getElementById("search-input");
const saveStatus = document.getElementById("save-status");
const lastEdited = document.getElementById("last-edited");
const stats = document.getElementById("stats");
const globalStats = document.getElementById("global-stats");
const selectionStats = document.getElementById("selection-stats");
const readingTime = document.getElementById("reading-time");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

function activeNote() {
  return notes.find((n) => n.id === activeId) || null;
}

function noteIndex(id = activeId) {
  return notes.findIndex((n) => n.id === id);
}

// ── Link Detection & Efficient Highlighting Engine ─────────────────
const URL_REGEX = /(https?:\/\/[^\s]+)/g;

function getEditorText() {
  return editor.innerText.replace(/\n$/, "");
}

function setEditorText(text) {
  // EFFICIENCY GAIN: Skip full rendering cycles if text strings match perfectly
  if (getEditorText() === text && editor.innerHTML !== "") return;

  // Track cursor offsets precisely
  const selection = window.getSelection();
  let offset = 0;
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(editor);
    preCaretRange.setEnd(range.endContainer, range.endOffset);
    offset = preCaretRange.toString().length;
  }

  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const highlighted = escaped.replace(
    URL_REGEX,
    '<span class="editor-link">$1</span>',
  );
  editor.innerHTML = highlighted;

  restoreCursorPosition(offset);
}

function restoreCursorPosition(chars) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(true);

  let nodeStack = [editor];
  let node,
    found = false,
    stop = false;
  let charCount = 0;

  while (!stop && (node = nodeStack.pop())) {
    if (node.nodeType === 3) {
      const nextCharCount = charCount + node.length;
      if (!found && chars >= charCount && chars <= nextCharCount) {
        range.setStart(node, chars - charCount);
        range.setEnd(node, chars - charCount);
        found = true;
        stop = true;
      }
      charCount = nextCharCount;
    } else {
      let i = node.childNodes.length;
      while (i--) {
        nodeStack.push(node.childNodes[i]);
      }
    }
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

function getCursorPosition() {
  const selection = window.getSelection();
  if (selection.rangeCount === 0) return 0;
  const range = selection.getRangeAt(0);
  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(editor);
  preCaretRange.setEnd(range.endContainer, range.endOffset);
  return preCaretRange.toString().length;
}

function insertAtCursor(text) {
  const start = getCursorPosition();
  const currentText = getEditorText();
  const newText = currentText.slice(0, start) + text + currentText.slice(start);
  setEditorText(newText);
  restoreCursorPosition(start + text.length);
  editor.dispatchEvent(new Event("input"));
  editor.focus();
}

function wrapSelection(prefix, suffix) {
  const selection = window.getSelection();
  if (selection.rangeCount === 0) return;

  const start = getCursorPosition();
  const selectedText = selection.toString();
  const currentText = getEditorText();

  const replacement = prefix + selectedText + suffix;
  const newText =
    currentText.slice(0, start) +
    replacement +
    currentText.slice(start + selectedText.length);

  setEditorText(newText);
  restoreCursorPosition(start + prefix.length + selectedText.length);

  editor.dispatchEvent(new Event("input"));
  editor.focus();
}

// Track Modifier Keys for Cursors
document.addEventListener("keydown", (e) => {
  if (e.key === "Control" || e.key === "Meta")
    document.body.classList.add("ctrl-pressed");
});
document.addEventListener("keyup", (e) => {
  if (e.key === "Control" || e.key === "Meta")
    document.body.classList.remove("ctrl-pressed");
});

// Click interception for Links inside Editor mode
editor.addEventListener("click", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.target.classList.contains("editor-link")) {
    e.preventDefault();
    chrome.tabs.create({ url: e.target.textContent });
  }
});

// ── Copy All Feature
function handleCopyAll() {
  const textToCopy = getEditorText();
  if (!textToCopy) return;

  navigator.clipboard
    .writeText(textToCopy)
    .then(() => {
      const originalText = btnCopyAll.textContent;
      btnCopyAll.textContent = "✅"; // Visual indicator success change
      setTimeout(() => {
        btnCopyAll.textContent = originalText;
      }, 1500);
    })
    .catch((err) => {
      console.error("Could not copy note text contents: ", err);
    });
}

// ── Undo / Redo History Tracking Logic
function initHistory() {
  historyStack = [getEditorText()];
  historyIndex = 0;
}

function pushHistoryState() {
  if (isApplyingHistory) return;
  const currentText = getEditorText();

  if (currentText === historyStack[historyIndex]) return;

  if (historyIndex < historyStack.length - 1) {
    historyStack = historyStack.slice(0, historyIndex + 1);
  }

  historyStack.push(currentText);
  historyIndex = historyStack.length - 1;
}

function handleUndo() {
  if (historyIndex > 0) {
    isApplyingHistory = true;
    historyIndex--;
    applyHistoryState();
  }
}

function handleRedo() {
  if (historyIndex < historyStack.length - 1) {
    isApplyingHistory = true;
    historyIndex++;
    applyHistoryState();
  }
}

function applyHistoryState() {
  const targetText = historyStack[historyIndex];
  const start = getCursorPosition();

  setEditorText(targetText);
  activeNote().content = targetText;
  activeNote().updatedAt = new Date().toISOString();

  updateStats();
  if (previewOn) renderPreview();
  persist();

  restoreCursorPosition(Math.min(start, targetText.length));
  isApplyingHistory = false;
}

function timeAgo(dateString) {
  if (!dateString) return "";
  const seconds = Math.floor((Date.now() - new Date(dateString)) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function persist() {
  chrome.storage.local.set(
    { [STORAGE_NOTES]: notes, [STORAGE_ACTIVE]: activeId },
    () => setStatus("saved"),
  );
  setStatus("saving");
  updateLastEdited();
}

function setStatus(state) {
  saveStatus.className = state;
  clearTimeout(statusTimer);
  if (state === "saving") saveStatus.textContent = "";
  else if (state === "saved") {
    saveStatus.textContent = "Saved";
    statusTimer = setTimeout(() => {
      if (saveStatus.className === "saved") {
        saveStatus.textContent = "All saved";
        saveStatus.className = "";
      }
    }, 1200);
  }
}

function updateLastEdited() {
  const note = activeNote();
  if (note) lastEdited.textContent = "· Edited " + timeAgo(note.updatedAt);
}
setInterval(updateLastEdited, 60000);

function load() {
  chrome.storage.local.get(
    [STORAGE_NOTES, STORAGE_ACTIVE, STORAGE_THEME],
    (result) => {
      notes = result[STORAGE_NOTES] || [];
      activeId = result[STORAGE_ACTIVE] || null;
      isLightMode = result[STORAGE_THEME] === "light";

      if (isLightMode) document.body.classList.add("theme-light");
      if (notes.length === 0) {
        createNote("Note 1");
        return;
      }
      if (!notes.find((n) => n.id === activeId)) activeId = notes[0].id;

      renderTabs();
      loadActiveNote();

      btnPreview.classList.toggle("active", previewOn);
      if (previewOn) {
        renderPreview();
        editor.classList.add("hidden");
        preview.classList.remove("hidden");
      } else {
        editor.classList.remove("hidden");
        preview.classList.add("hidden");
      }
    },
  );
}

function createNote(title = "Untitled") {
  const now = new Date().toISOString();
  const note = {
    id: uid(),
    title: title || "Untitled",
    content: "",
    createdAt: now,
    updatedAt: now,
  };
  notes.push(note);
  activeId = note.id;
  if (isSearching) toggleSearch();
  renderTabs();
  loadActiveNote();
  persist();
  noteTitle.focus();
  noteTitle.select();
}

function deleteNote(idToDel) {
  const idx = noteIndex(idToDel);
  if (idx === -1) return;
  if (notes.length <= 1) {
    notes[0].title = "Note 1";
    notes[0].content = "";
    notes[0].updatedAt = new Date().toISOString();
    renderTabs();
    loadActiveNote();
    persist();
    return;
  }
  notes.splice(idx, 1);
  if (idToDel === activeId) activeId = notes[Math.max(0, idx - 1)].id;
  renderTabs();
  persist();
  loadActiveNote();
}

function renderTabs() {
  tabsList.innerHTML = "";
  const query = isSearching ? searchInput.value.toLowerCase() : "";
  const visibleNotes = query
    ? notes.filter(
        (n) =>
          n.title.toLowerCase().includes(query) ||
          n.content.toLowerCase().includes(query),
      )
    : notes;

  if (query && visibleNotes.length === 0) {
    tabsList.innerHTML =
      '<div style="padding:0 12px; color:var(--bg3); font-size:12px; display:flex; align-items:center;">No matches</div>';
    return;
  }

  visibleNotes.forEach((note) => {
    const btn = document.createElement("div");
    btn.className = "tab" + (note.id === activeId ? " active" : "");
    btn.title = note.title || "Untitled";

    const titleSpan = document.createElement("span");
    titleSpan.className = "tab-title";
    titleSpan.textContent = note.title || "Untitled";

    const closeBtn = document.createElement("span");
    closeBtn.className = "tab-close";
    closeBtn.innerHTML = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteNote(note.id);
    });

    btn.appendChild(titleSpan);
    btn.appendChild(closeBtn);
    btn.addEventListener("click", () => switchTo(note.id));
    tabsList.appendChild(btn);
  });
  if (!isSearching) {
    const activeTab = tabsList.querySelector(".tab.active");
    if (activeTab)
      activeTab.scrollIntoView({ inline: "nearest", block: "nearest" });
  }
}

function toggleSearch() {
  isSearching = !isSearching;
  if (isSearching) {
    searchWrap.classList.remove("hidden");
    tabsScroll.classList.add("hidden");
    btnNewTab.classList.add("hidden");
    btnSearchToggle.classList.add("active");
    btnSearchToggle.textContent = "✕";
    searchInput.value = "";
    searchInput.focus();
  } else {
    searchWrap.classList.add("hidden");
    tabsScroll.classList.remove("hidden");
    btnNewTab.classList.remove("hidden");
    btnSearchToggle.classList.remove("active");
    btnSearchToggle.textContent = "⌕";
    searchInput.value = "";
    if (!previewOn) editor.focus();
  }
  renderTabs();
}

function switchTo(id) {
  if (id === activeId) return;
  const cur = activeNote();
  if (cur) {
    cur.content = getEditorText();
    cur.title = noteTitle.value.trim() || "Untitled";
  }
  activeId = id;
  if (isSearching) toggleSearch();
  renderTabs();
  loadActiveNote();
  persist();
}

function loadActiveNote() {
  const note = activeNote();
  if (!note) return;

  // Initialize heading collapsible state for this note
  if (!collapsedStates[activeId]) {
    collapsedStates[activeId] = new Set();
  }

  noteTitle.value = note.title;
  setEditorText(note.content);
  updateStats();
  updateLastEdited();
  initHistory();
  if (previewOn) renderPreview();
  if (!previewOn) editor.focus();
}

// Adjusts the visibility of child elements to properly collapse sub-headings
function updatePreviewVisibility() {
  let hideLevel = Infinity;
  const children = Array.from(preview.children);
  for (const el of children) {
    if (el.id === "toc-wrapper") continue;

    const isHeading = /^H[1-6]$/.test(el.tagName);
    let level = 7;

    if (isHeading) {
      level = parseInt(el.tagName.substring(1));
      if (level <= hideLevel) {
        hideLevel = Infinity; // We reached a heading of equal or higher priority. Reset.
      }
    }

    if (hideLevel < Infinity) {
      el.classList.add("hidden-collapse");
    } else {
      el.classList.remove("hidden-collapse");
    }

    if (isHeading && el.classList.contains("collapsed") && level < hideLevel) {
      hideLevel = level;
    }
  }
}

function renderPreview() {
  if (typeof marked === "undefined") {
    preview.innerHTML = "Missing marked.js";
    return;
  }
  let parsed =
    typeof marked.parse === "function"
      ? marked.parse(getEditorText())
      : marked(getEditorText());
  parsed = parsed.replace(/disabled="" /g, "");

  // Set the standard HTML first
  preview.innerHTML = parsed;

  // 1. Process ALL headings to maintain their collapsed state
  const allHeadings = preview.querySelectorAll("h1, h2, h3, h4, h5, h6");
  allHeadings.forEach((heading, index) => {
    if (!heading.id) {
      heading.id = `heading-${index}-${heading.textContent
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}`;
    }
    // Restore preserved collapsible states
    if (
      collapsedStates[activeId] &&
      collapsedStates[activeId].has(heading.id)
    ) {
      heading.classList.add("collapsed");
    }
  });

  // 2. Extract top headings to build the Floating Table of Contents
  const tocHeadings = preview.querySelectorAll("h1, h2, h3");
  if (tocHeadings.length > 0) {
    const tocWrapper = document.createElement("div");
    tocWrapper.id = "toc-wrapper";

    const tocToggle = document.createElement("button");
    tocToggle.id = "toc-toggle";
    tocToggle.innerHTML = "≡ Contents";
    tocToggle.title = "Table of Contents";

    const tocDropdown = document.createElement("div");
    tocDropdown.id = "toc-dropdown";
    tocDropdown.className = "hidden"; // Closed by default

    const tocList = document.createElement("ul");
    tocList.id = "toc-list";

    tocHeadings.forEach((heading) => {
      const li = document.createElement("li");
      li.className = `toc-${heading.tagName.toLowerCase()}`;

      const a = document.createElement("a");
      a.href = `#${heading.id}`;
      a.textContent = heading.textContent;

      li.appendChild(a);
      tocList.appendChild(li);
    });

    // Smooth scroll intervention & auto-close overlay
    tocList.addEventListener("click", (e) => {
      if (e.target.tagName === "A") {
        e.preventDefault();
        const targetId = e.target.getAttribute("href").slice(1);
        const targetElement = document.getElementById(targetId);
        if (targetElement) {
          // If jumping to collapsed section, maybe uncollapse it
          targetElement.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }
        tocDropdown.classList.add("hidden");
      }
    });

    tocToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      tocDropdown.classList.toggle("hidden");
    });

    tocDropdown.appendChild(tocList);
    tocWrapper.appendChild(tocToggle);
    tocWrapper.appendChild(tocDropdown);

    // Prepend the floating wrapper so it sticks to the top-right and text wraps it
    preview.prepend(tocWrapper);
  }

  // Hide the sections nested inside the collapsed headings
  updatePreviewVisibility();
}

// Global click listener to close ToC Dropdown when clicking outside
document.addEventListener("click", (e) => {
  const dropdown = document.getElementById("toc-dropdown");
  const toggle = document.getElementById("toc-toggle");
  if (dropdown && !dropdown.classList.contains("hidden")) {
    if (
      !dropdown.contains(e.target) &&
      (!toggle || !toggle.contains(e.target))
    ) {
      dropdown.classList.add("hidden");
    }
  }
});

// Smart Links, Headings & Checkboxes inside Preview panel
preview.addEventListener("click", async (e) => {
  // 1. Handle Heading Collapses
  const heading = e.target.closest(
    "#preview > h1, #preview > h2, #preview > h3, #preview > h4, #preview > h5, #preview > h6",
  );
  if (heading && !e.target.closest("a")) {
    // Do not fold if the user explicitly clicked an embedded link
    heading.classList.toggle("collapsed");

    if (!collapsedStates[activeId]) {
      collapsedStates[activeId] = new Set();
    }

    if (heading.classList.contains("collapsed")) {
      collapsedStates[activeId].add(heading.id);
    } else {
      collapsedStates[activeId].delete(heading.id);
    }

    updatePreviewVisibility();
    return;
  }

  // 2. Handle Markdown links
  const link = e.target.closest("a");

  // Prevent catching our internal TOC clicks
  if (link && link.href && !link.getAttribute("href").startsWith("#")) {
    e.preventDefault();

    if (link.href.includes("youtube.com/watch")) {
      try {
        const [currentTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        const linkVideoId = new URL(link.href).searchParams.get("v");
        const currentVideoId =
          currentTab &&
          currentTab.url &&
          currentTab.url.includes("youtube.com/watch")
            ? new URL(currentTab.url).searchParams.get("v")
            : null;

        if (currentTab && linkVideoId && linkVideoId === currentVideoId) {
          const timeParam = new URL(link.href).searchParams.get("t");
          if (timeParam) {
            const seconds = parseInt(timeParam);
            chrome.scripting.executeScript({
              target: { tabId: currentTab.id },
              func: (sec) => {
                const vid = document.querySelector("video");
                if (vid) {
                  vid.currentTime = sec;
                  vid.play();
                }
              },
              args: [seconds],
            });
            return;
          }
        }
      } catch (err) {
        console.error(err);
      }
    }
    chrome.tabs.create({ url: link.href });
  }
});

preview.addEventListener("change", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type === "checkbox") {
    const checkboxes = Array.from(
      preview.querySelectorAll('input[type="checkbox"]'),
    );
    const index = checkboxes.indexOf(e.target);
    if (index > -1) {
      let count = 0;
      const currentText = getEditorText();
      const newValue = currentText.replace(
        /^(?:\s*>)*\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]/gm,
        (match) => {
          if (count === index) {
            count++;
            return match.replace(/\[[ xX]\]/, e.target.checked ? "[x]" : "[ ]");
          }
          count++;
          return match;
        },
      );
      if (currentText !== newValue) {
        setEditorText(newValue);
        activeNote().content = newValue;
        activeNote().updatedAt = new Date().toISOString();
        pushHistoryState();
        persist();
        updateStats();
      }
    }
  }
});

function togglePreview() {
  previewOn = !previewOn;
  btnPreview.classList.toggle("active", previewOn);
  if (previewOn) {
    renderPreview();
    editor.classList.add("hidden");
    preview.classList.remove("hidden");
  } else {
    preview.classList.add("hidden");
    editor.classList.remove("hidden");
    editor.focus();
  }
}

editor.addEventListener("scroll", () => {
  if (previewOn)
    preview.scrollTop =
      (editor.scrollTop / (editor.scrollHeight - editor.clientHeight)) *
      (preview.scrollHeight - preview.clientHeight);
});

function toggleTheme() {
  isLightMode = !isLightMode;
  document.body.classList.toggle("theme-light", isLightMode);
  chrome.storage.local.set({ [STORAGE_THEME]: isLightMode ? "light" : "dark" });
}

function updateStats() {
  const text = getEditorText();

  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  const chars = text.length;
  const lines = text === "" ? 1 : text.split("\n").length;

  const paragraphs =
    text.split(/\n\s*\n/).filter((p) => p.trim() !== "").length ||
    (text.trim() !== "" ? 1 : 0);

  if (stats) {
    stats.textContent = `${words}w · ${chars}c · ${lines}L · ${paragraphs}P`;
  }

  if (readingTime) {
    const minutes = Math.ceil(words / 200);
    readingTime.textContent = `⏱️ ${words === 0 ? 0 : minutes}m read`;
  }

  const totalNotesCount = notes.length;
  let totalWordsCount = 0;

  notes.forEach((note) => {
    const noteContent = note.content || "";
    if (noteContent.trim() !== "") {
      totalWordsCount += noteContent.trim().split(/\s+/).length;
    }
  });

  if (globalStats) {
    const wordDisplay =
      totalWordsCount >= 1000
        ? (totalWordsCount / 1000).toFixed(1) + "kw"
        : totalWordsCount + "w";

    globalStats.textContent = `📁 Total: ${totalNotesCount} note${
      totalNotesCount !== 1 ? "s" : ""
    } · ${wordDisplay}`;
  }
}

document.addEventListener("selectionchange", () => {
  if (document.activeElement === editor) {
    const selection = window.getSelection();
    const selectedText = selection.toString();

    if (selectedText.length > 0) {
      const selWords =
        selectedText.trim() === ""
          ? 0
          : selectedText.trim().split(/\s+/).length;
      const selChars = selectedText.length;

      if (selectionStats) {
        selectionStats.textContent = `[${selWords}w/${selChars}c]`;
      }
    } else {
      if (selectionStats && selectionStats.textContent !== "[Ready]") {
        selectionStats.textContent = "[Ready]";
      }
    }
  } else {
    if (selectionStats && selectionStats.textContent !== "[Ready]") {
      selectionStats.textContent = "[Ready]";
    }
  }
});

function exportMd() {
  const note = activeNote();
  if (!note) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([note.content], { type: "text/markdown;charset=utf-8" }),
  );
  a.download =
    ((note.title || "note")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-") || "note") + ".md";
  a.click();
}

async function grabActiveTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) return;

    let url = tab.url;
    let title = tab.title.replace("- YouTube", "").trim();
    let isYT = url.includes("youtube.com/watch");

    if (isYT) {
      let [{ result: time }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const vid = document.querySelector("video");
          return vid ? Math.floor(vid.currentTime) : null;
        },
      });

      if (time !== null) {
        let h = Math.floor(time / 3600);
        let m = Math.floor((time % 3600) / 60);
        let s = time % 60;
        let timeStr =
          h > 0
            ? `${h}:${m.toString().padStart(2, "0")}:${s
                .toString()
                .padStart(2, "0")}`
            : `${m}:${s.toString().padStart(2, "0")}`;

        let urlObj = new URL(url);
        urlObj.searchParams.set("t", time + "s");
        insertAtCursor(
          `\n- [▶ ${timeStr}] [${title}](${urlObj.toString()})\n  - `,
        );
        return;
      }
    }
    insertAtCursor(`\n- 📖 [${title}](${url})\n  - `);
  } catch (error) {
    console.log("Could not grab tab info", error);
    insertAtCursor("\n- [Error grabbing link]\n");
  }
}

function insertCodeBlock() {
  const start = getCursorPosition();
  const currentText = getEditorText();
  const selectedText = window.getSelection().toString();

  if (selectedText) {
    const newText =
      currentText.slice(0, start) +
      `\n\`\`\`javascript\n${selectedText}\n\`\`\`\n` +
      currentText.slice(start + selectedText.length);
    setEditorText(newText);
    restoreCursorPosition(start + selectedText.length + 18);
  } else {
    const newText =
      currentText.slice(0, start) +
      `\n\`\`\`javascript\n\n\`\`\`\n` +
      currentText.slice(start);
    setEditorText(newText);
    restoreCursorPosition(start + 16);
  }
  editor.dispatchEvent(new Event("input"));
  editor.focus();
}

tabsScroll.addEventListener("wheel", (e) => {
  if (e.deltaY !== 0) {
    tabsScroll.scrollLeft += e.deltaY;
    e.preventDefault();
  }
});

btnNewTab.addEventListener("click", () => createNote());
btnPreview.addEventListener("click", togglePreview);
btnTheme.addEventListener("click", toggleTheme);
btnSearchToggle.addEventListener("click", toggleSearch);
btnExport.addEventListener("click", exportMd);
btnGrabTab.addEventListener("click", grabActiveTabInfo);
btnCodeBlock.addEventListener("click", insertCodeBlock);
btnCopyAll.addEventListener("click", handleCopyAll);

// "Open in Full Tab" Feature
if (btnPopout) {
  btnPopout.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?mode=tab") });
  });
}

searchInput.addEventListener("input", renderTabs);
btnDelete.addEventListener("click", () => {
  if (confirm("Delete this note?")) deleteNote(activeId);
});

// Capture keystroke pauses to push history states cleanly
let typingHistoryTimeout = null;

editor.addEventListener("input", () => {
  const text = getEditorText();
  activeNote().content = text;
  activeNote().updatedAt = new Date().toISOString();

  if (URL_REGEX.test(text)) {
    setEditorText(text);
  }

  updateStats();
  persist();

  clearTimeout(typingHistoryTimeout);
  typingHistoryTimeout = setTimeout(() => {
    pushHistoryState();
  }, 350);
});

noteTitle.addEventListener("input", () => {
  activeNote().title = noteTitle.value.trim() || "Untitled";
  activeNote().updatedAt = new Date().toISOString();
  renderTabs();
  persist();
});

noteTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    editor.focus();
    e.preventDefault();
  }
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    toggleSearch();
  }
});

// ── Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && !e.shiftKey && e.key === "z") {
    e.preventDefault();
    handleUndo();
    return;
  }
  if (ctrl && (e.key === "y" || (e.shiftKey && e.key === "Z"))) {
    e.preventDefault();
    handleRedo();
    return;
  }
  if (ctrl && e.key === "b") {
    e.preventDefault();
    wrapSelection("**", "**");
  }
  if (ctrl && e.key === "i") {
    e.preventDefault();
    wrapSelection("*", "*");
  }
  if (ctrl && e.shiftKey && (e.key === "X" || e.key === "x")) {
    e.preventDefault();
    wrapSelection("~~", "~~");
  }
  if (ctrl && e.key === "t") {
    e.preventDefault();
    createNote();
  }
  if (ctrl && e.key === "p") {
    e.preventDefault();
    togglePreview();
  }
  if (ctrl && e.key === "s") {
    e.preventDefault();
    setStatus("saved");
  }
  if (ctrl && e.key === "e") {
    e.preventDefault();
    exportMd();
  }
  if (ctrl && e.key === "f") {
    e.preventDefault();
    toggleSearch();
  }
  if (ctrl && e.shiftKey && (e.key === "Y" || e.key === "y")) {
    e.preventDefault();
    grabActiveTabInfo();
  }
  if (ctrl && e.shiftKey && (e.key === "C" || e.key === "c")) {
    e.preventDefault();
    insertCodeBlock();
  }

  if (ctrl && e.key === "Tab") {
    e.preventDefault();
    if (isSearching) return;
    const idx = noteIndex();
    const next = e.shiftKey
      ? (idx - 1 + notes.length) % notes.length
      : (idx + 1) % notes.length;
    switchTo(notes[next].id);
  }
});

editor.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === "d") {
    e.preventDefault();
    const dateStr = new Date().toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    insertAtCursor(dateStr + " ");
  }

  if (e.key === "Tab") {
    e.preventDefault();
    insertAtCursor("  ");
  }

  if (e.key === "Enter") {
    const cursorPos = getCursorPosition();
    const currentText = getEditorText();
    const currentLine = currentText.slice(0, cursorPos).split("\n").pop();
    const match = currentLine.match(/^(\s*(?:-|\*|\d+\.)\s+(?:\[[ xX]\]\s+)?)/);

    if (match) {
      if (currentLine.trim() === match[0].trim()) {
        e.preventDefault();
        const newText =
          currentText.slice(0, cursorPos - match[0].length) +
          currentText.slice(cursorPos);
        setEditorText(newText);
        restoreCursorPosition(cursorPos - match[0].length);
      } else {
        e.preventDefault();
        let insertText = "\n" + match[1];
        if (insertText.includes("[x]") || insertText.includes("[X]"))
          insertText = insertText.replace(/\[[xX]\]/, "[ ]");
        insertAtCursor(insertText);
      }
    }
  }
});

window.addEventListener("pagehide", () => {
  if (activeNote()) {
    activeNote().content = getEditorText();
    activeNote().title = noteTitle.value.trim() || "Untitled";
  }
  chrome.storage.local.set({
    [STORAGE_NOTES]: notes,
    [STORAGE_ACTIVE]: activeId,
  });
});

load();
