"use strict";

(function () {
  const replacements = [
    [/NekoSune Restream Node/g, "CastNexus"],
    [/RestreamNode/g, "CastNexus"],
    [/Restream Node/g, "CastNexus"],
  ];

  function replaceText(value) {
    let out = String(value || "");
    for (const [from, to] of replacements) out = out.replace(from, to);
    return out;
  }

  function brandNode(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      const next = replaceText(root.nodeValue);
      if (next !== root.nodeValue) root.nodeValue = next;
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const next = replaceText(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    }
    if (root.querySelectorAll) {
      root.querySelectorAll("[title],[aria-label],[placeholder]").forEach(el => {
        for (const attr of ["title","aria-label","placeholder"]) {
          if (!el.hasAttribute(attr)) continue;
          const before=el.getAttribute(attr), after=replaceText(before);
          if (before !== after) el.setAttribute(attr, after);
        }
      });
    }
  }

  document.title = "CastNexus Studio";
  brandNode(document.body);

  new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === "characterData") brandNode(m.target);
      for (const n of m.addedNodes || []) brandNode(n);
    }
  }).observe(document.documentElement, { childList:true, subtree:true, characterData:true });

  // Migrate only old untouched default radio labels. User-created names are
  // deliberately left alone.
  let attempts=0;
  const timer=setInterval(async () => {
    attempts++;
    try {
      if (typeof S === "undefined" || !Array.isArray(S.profiles) || !S.profiles.length) {
        if (attempts > 20) clearInterval(timer);
        return;
      }
      let dirty=false;
      for (const p of S.profiles) {
        if (!p.musicVisual) continue;
        if (p.musicVisual.station === "RestreamNode Radio") { p.musicVisual.station = "CastNexus Radio"; dirty=true; }
        if (p.musicVisual.title === "RestreamNode Radio") { p.musicVisual.title = "CastNexus Radio"; dirty=true; }
      }
      if (dirty && typeof saveProfileStore === "function") await saveProfileStore();
      clearInterval(timer);
    } catch {
      if (attempts > 20) clearInterval(timer);
    }
  }, 500);
})();
