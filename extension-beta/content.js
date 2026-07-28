// REVSetter AI Content Script
// Runs on Instagram, Facebook, Messenger pages.
// Detects the open conversation and pushes it to the side panel via background.

(function () {
  'use strict';

  if (window.__REVSETTER_CONTENT_LOADED__) return;
  window.__REVSETTER_CONTENT_LOADED__ = true;

  // ---------- Platform detection ----------

  function detectPlatform() {
    const host = location.hostname;
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('messenger.com')) return 'messenger';
    if (host.includes('facebook.com')) return 'facebook';
    return null;
  }

  function isThreadOpen() {
    const platform = detectPlatform();
    if (platform === 'instagram') return /\/direct\/t\/[^/]+/.test(location.pathname);
    if (platform === 'messenger') return /\/t\/[^/]+/.test(location.pathname);
    if (platform === 'facebook') {
      return /\/messages\/(?:[^/]+\/)?t\/[^/]+/.test(location.pathname) ||
             document.querySelector('[role="dialog"][aria-label*="Chat" i]') !== null;
    }
    return false;
  }

  function getThreadId() {
    const m = location.pathname.match(/\/t\/([^/]+)/);
    return m ? m[1] : location.pathname;
  }

  // ---------- Instagram extractor ----------
  // Built against real DOM intel:
  //   - [role="group"] anchors every message row
  //   - [role="presentation"] wraps the rendered bubble text
  //   - [role="link"][aria-label^="Open the profile page of"] = sender (theirs only)
  //   - computed justify-content: flex-end = mine, flex-start = theirs
  //   - innerText to preserve emoji <img alt="..."> content
  //   - Skip groups without [role="presentation"] (filters headers/banners)
  // TODO: detect reply-quote wrappers and split quoted vs reply text.

  function findInstagramScroller() {
    const all = findAllInstagramScrollers();
    return all[0] || null;
  }

  // IG's actual scroll-listener element isn't always the FIRST overflow ancestor.
  // Collect every candidate so the auto-loader can fire triggers on all of them.
  function findAllInstagramScrollers() {
    const anyMessage = document.querySelector('[role="group"]');
    if (!anyMessage) return [];
    const scrollers = [];
    let el = anyMessage.parentElement;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      const overflowOk = cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay';
      if (overflowOk && el.scrollHeight > el.clientHeight + 50) {
        scrollers.push(el);
      }
      el = el.parentElement;
    }
    return scrollers;
  }

  function classifyInstagramMessage(group) {
    // Primary: any descendant with computed justify-content: flex-end → mine
    const divs = group.querySelectorAll('div');
    for (const d of divs) {
      if (getComputedStyle(d).justifyContent === 'flex-end') return 'you';
    }
    // Fallback: presence of profile link → theirs
    if (group.querySelector('a[role="link"][aria-label^="Open the profile page of"]')) {
      return 'them';
    }
    // Default theirs (safer assumption — we'd rather mis-tag mine as theirs than vice versa)
    return 'them';
  }

  function getInstagramSender(group) {
    const link = group.querySelector('a[role="link"][aria-label^="Open the profile page of"]');
    if (!link) return null;
    const label = link.getAttribute('aria-label') || '';
    return label.replace('Open the profile page of ', '').trim() || null;
  }

  function getInstagramText(group) {
    const bubble = group.querySelector('[role="presentation"]');
    if (!bubble) return '';
    // innerText (not textContent) so emoji <img alt="..."> resolve as their alt text
    return (bubble.innerText || '').trim();
  }

  // Per-thread message accumulator. Survives FB/IG React virtualization, which
  // unmounts rows when they scroll off-screen — without this cache the message
  // count oscillates as the auto-loader scrolls and DOM rotates batches.
  // Key: aria-label for Meta (includes time → unique). For IG: role|text (less
  // robust against repeated phrases; acceptable for v1).
  const messageCache = new Map(); // threadId → { ordered: [], keys: Set }

  function mergeMessagesIntoCache(threadId, fresh) {
    let cache = messageCache.get(threadId);
    if (!cache) {
      cache = { ordered: [], keys: new Set() };
      messageCache.set(threadId, cache);
    }

    for (let i = 0; i < fresh.length; i++) {
      const m = fresh[i];
      if (cache.keys.has(m._key)) continue;

      // Anchor 1: next message in this batch that's already cached → insert before it
      let inserted = false;
      for (let j = i + 1; j < fresh.length; j++) {
        if (cache.keys.has(fresh[j]._key)) {
          const idx = cache.ordered.findIndex(x => x._key === fresh[j]._key);
          cache.ordered.splice(idx, 0, m);
          inserted = true;
          break;
        }
      }
      // Anchor 2: previous message in this batch already cached → insert after it
      if (!inserted) {
        for (let j = i - 1; j >= 0; j--) {
          if (cache.keys.has(fresh[j]._key)) {
            const idx = cache.ordered.findIndex(x => x._key === fresh[j]._key);
            cache.ordered.splice(idx + 1, 0, m);
            inserted = true;
            break;
          }
        }
      }
      // No anchor in current batch — first batch ever pushes, disjoint batch
      // prepends (scroll-up convention: new batch is older than what we have).
      if (!inserted) {
        if (cache.ordered.length === 0) cache.ordered.push(m);
        else cache.ordered.unshift(m);
      }
      cache.keys.add(m._key);
    }

    return cache.ordered.map(({ _key, ...rest }) => rest);
  }

  function extractInstagram() {
    if (!isThreadOpen()) return { error: 'No conversation thread open' };

    const scroller = findInstagramScroller();
    if (!scroller) return { error: 'Could not locate thread scroller' };

    const groups = scroller.querySelectorAll('[role="group"]');
    if (groups.length === 0) return { error: 'No messages found in thread' };

    const freshMessages = [];
    groups.forEach(g => {
      // Skip groups that aren't messages (headers, banners) — they have no presentation bubble
      if (!g.querySelector('[role="presentation"]')) return;
      let text = getInstagramText(g);
      // Voice note: the bubble text is the revealed transcript (or the unrevealed
      // "View transcription" placeholder). Strip the clip-duration prefix (e.g.
      // "0:13") + trailing "See less/more"; placeholder → "[voice note]".
      const isVoiceNote = !!g.querySelector('svg[aria-label="Waveform for audio message"], svg[aria-label="Voice Clip"]');
      if (isVoiceNote) {
        text = text.replace(/^\d{1,2}:\d{2}\s*/, '').replace(/\s*See (less|more)\s*$/i, '').trim();
        if (!text || /^view\s+transcri\w*$/i.test(text)) text = '[voice note]';
      }
      if (!text) return;
      const role = classifyInstagramMessage(g);
      const sender = role === 'them' ? getInstagramSender(g) : null;
      freshMessages.push({ role, text, ...(sender ? { sender } : {}), _key: `${role}|${text}` });
    });

    if (freshMessages.length === 0) return { error: 'No readable messages found' };

    const threadId = getThreadId();
    const messages = mergeMessagesIntoCache(threadId, freshMessages);

    return {
      platform: 'instagram',
      threadId,
      messages,
      messageCount: messages.length,
      text: messages.map(m => `${m.role === 'you' ? 'YOU' : 'THEM'}: ${m.text}`).join('\n')
    };
  }

  // ---------- Facebook / Messenger extractor ----------
  // Built against real DOM intel from facebook.com/messages/ (2026-05):
  //   - Every message row is anchored by [data-scope="messages_table"]
  //   - aria-label is the truth signal, format: "At {time}, {sender|You}: {text}"
  //       • aria starts with "You:" after the comma → mine
  //       • aria starts with first-name + ":" → theirs (sender = name)
  //       • aria-label null/missing = not a message (date headers, system notices) → skip
  //   - Text is parsed from aria-label (cleanest, dedupes link previews & reply quotes)
  //   - Fallback to [dir="auto"] innerText if aria parse fails
  //   - Scroller discovered same way as IG (walk up to overflow:auto ancestor)
  //   - messenger.com uses identical DOM structure (Meta shared infra)

  const META_ARIA_RE = /^At [^,]+, (You|[^:]+): ([\s\S]+)$/;

  function findMetaScroller() {
    const anyRow = document.querySelector('[data-scope="messages_table"]');
    if (!anyRow) return null;
    let el = anyRow.parentElement;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight + 50) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function parseMetaAria(aria) {
    if (!aria) return null;
    const m = aria.match(META_ARIA_RE);
    if (!m) return null;
    const who = m[1].trim();
    const text = m[2].trim();
    if (!text) return null;
    return {
      role: who === 'You' ? 'you' : 'them',
      sender: who === 'You' ? null : who,
      text
    };
  }

  function getMetaFallbackText(row) {
    // If aria-parse fails, take the first non-empty [dir="auto"] inside the row
    const dirAutos = row.querySelectorAll('[dir="auto"]');
    for (const d of dirAutos) {
      const t = (d.innerText || '').trim();
      if (t) return t;
    }
    return '';
  }

  function extractMeta(platform) {
    if (!isThreadOpen()) return { error: 'No conversation thread open' };

    const rows = document.querySelectorAll('[data-scope="messages_table"]');
    if (rows.length === 0) {
      return { error: 'Could not locate message rows ([data-scope="messages_table"] not found)' };
    }

    const freshMessages = [];
    rows.forEach(row => {
      const aria = row.getAttribute('aria-label');
      if (!aria) return;  // skip rows without aria (date headers, system notices)

      const parsed = parseMetaAria(aria);
      if (parsed) {
        freshMessages.push({
          role: parsed.role,
          text: parsed.text,
          ...(parsed.sender ? { sender: parsed.sender } : {}),
          _key: aria
        });
        return;
      }
      // Fallback: aria-label exists but didn't match canonical format
      const fallback = getMetaFallbackText(row);
      if (!fallback) return;
      const role = /,\s*You:/i.test(aria) ? 'you' : 'them';
      freshMessages.push({ role, text: fallback, _key: aria });
    });

    if (freshMessages.length === 0) return { error: 'No readable messages found in thread' };

    const threadId = getThreadId();
    const messages = mergeMessagesIntoCache(threadId, freshMessages);

    return {
      platform,
      threadId,
      messages,
      messageCount: messages.length,
      text: messages.map(m => `${m.role === 'you' ? 'YOU' : 'THEM'}: ${m.text}`).join('\n')
    };
  }

  async function loadMetaHistory() {
    if (isLoadingHistory) return;
    const scroller = findMetaScroller();
    if (!scroller) return;

    const threadId = getThreadId();
    if (historyLoadedForThread === threadId) return;

    const initialCount = document.querySelectorAll('[data-scope="messages_table"]').length;
    if (initialCount >= TARGET_MESSAGE_COUNT) {
      historyLoadedForThread = threadId;
      return;
    }

    isLoadingHistory = true;
    pushLoadingState(true);

    const savedScrollTop = scroller.scrollTop;
    const startTime = Date.now();
    let lastCount = initialCount;
    let lastGrowthTime = Date.now();

    try {
      while (Date.now() - startTime < LOAD_TIMEOUT_MS) {
        // Three-way scroll trigger: setting scrollTop, dispatching a scroll
        // event (FB's React virtualized list needs the event, not just the
        // property mutation), and scrollIntoView on the topmost row as
        // belt + suspenders when the chosen scroller isn't the real one.
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        const topRow = document.querySelector('[data-scope="messages_table"]');
        if (topRow) topRow.scrollIntoView({ block: 'start' });
        await sleep(SCROLL_WAIT_MS);

        const currentCount = document.querySelectorAll('[data-scope="messages_table"]').length;
        if (currentCount >= TARGET_MESSAGE_COUNT) break;

        if (currentCount > lastCount) {
          lastCount = currentCount;
          lastGrowthTime = Date.now();
        } else if (Date.now() - lastGrowthTime > NO_GROWTH_TIMEOUT_MS) {
          break;
        }
      }
    } catch (e) {
      console.warn('[REVSetter] meta history load error:', e);
    } finally {
      try { scroller.scrollTop = savedScrollTop; } catch {}
      isLoadingHistory = false;
      // Only mark thread as loaded if we actually got more messages. Otherwise
      // the next getCurrentConvo call should retry — silent dedup on a failed
      // load was the root cause of "stuck at 7 messages forever" (BOO-30).
      if (lastCount > initialCount) {
        historyLoadedForThread = threadId;
      }
      try { await revealVoiceTranscripts(); } catch {}
      pushLoadingState(false);
      pushUpdate('history-loaded');
    }
  }

  // ---------- Router ----------

  function extractConversation() {
    const platform = detectPlatform();
    if (!platform) return { error: 'Not a supported platform' };
    if (platform === 'instagram') return extractInstagram();
    if (platform === 'messenger' || platform === 'facebook') return extractMeta(platform);
    return { error: 'Unknown platform' };
  }

  // ---------- History loader (Instagram only for now) ----------
  // Triggers IG's lazy-load by scrolling the thread scroller to top.
  // Saves and restores scroll position so the user's view doesn't jump.

  const TARGET_MESSAGE_COUNT = 100;
  const LOAD_TIMEOUT_MS = 25000;
  const NO_GROWTH_TIMEOUT_MS = 6000;
  const SCROLL_WAIT_MS = 2500;

  let isLoadingHistory = false;
  let historyLoadedForThread = null;

  async function loadInstagramHistory() {
    if (isLoadingHistory) return;
    const allScrollers = findAllInstagramScrollers();
    if (allScrollers.length === 0) return;
    const scroller = allScrollers[0];  // for count + scroll-position restore

    const threadId = getThreadId();
    if (historyLoadedForThread === threadId) return; // already loaded this thread

    const initialCount = document.querySelectorAll('[role="group"]').length;
    if (initialCount >= TARGET_MESSAGE_COUNT) {
      historyLoadedForThread = threadId;
      return;
    }

    isLoadingHistory = true;
    pushLoadingState(true);

    const savedScrollTop = scroller.scrollTop;
    const startTime = Date.now();
    let lastCount = initialCount;
    let lastGrowthTime = Date.now();

    try {
      while (Date.now() - startTime < LOAD_TIMEOUT_MS) {
        // Burst-scroll: 30 rapid scrollBy steps with wheel + scroll events,
        // ~30ms apart. Mimics the event firehose of a fast user mouse-wheel
        // scroll — that's what IG's React intersection observer reacts to.
        // Smooth scroll was capped by the browser's animation speed and never
        // covered enough distance per iteration (Joe's 2026-05-27 test: "scroll
        // only went up a smidge").
        for (let burst = 0; burst < 30; burst++) {
          for (const s of allScrollers) {
            s.scrollBy({ top: -250, behavior: 'instant' });
            s.dispatchEvent(new WheelEvent('wheel', {
              deltaY: -250,
              bubbles: true,
              cancelable: true
            }));
            s.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
          await sleep(30);
        }
        // Settle: let IG's load handler run + render new messages before we count.
        await sleep(SCROLL_WAIT_MS);

        const currentCount = document.querySelectorAll('[role="group"]').length;
        if (currentCount >= TARGET_MESSAGE_COUNT) break;

        if (currentCount > lastCount) {
          lastCount = currentCount;
          lastGrowthTime = Date.now();
        } else if (Date.now() - lastGrowthTime > NO_GROWTH_TIMEOUT_MS) {
          break; // reached thread start
        }
      }
    } catch (e) {
      console.warn('[REVSetter] history load error:', e);
    } finally {
      // Restore the user's scroll position
      try { scroller.scrollTop = savedScrollTop; } catch {}
      isLoadingHistory = false;
      // Only dedup the thread if we actually loaded more (BOO-30 fix).
      if (lastCount > initialCount) {
        historyLoadedForThread = threadId;
      }
      try { await revealVoiceTranscripts(); } catch {}
      pushLoadingState(false);
      pushUpdate('history-loaded');
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---------- Voice-note transcript auto-reveal (Instagram) ----------
  // Instagram voice notes hide their transcript behind a "View transcription"
  // button (div[role="button"]). Clicking it renders the transcript into the
  // same [role="presentation"] bubble the extractor already reads. First-ever
  // click opens a Meta consent dialog ("audio messages into text", "Continue");
  // we NEVER auto-accept that — we nudge the user instead. Toggle: chrome
  // storage local `voiceTranscribe` (default ON). Selectors verified live 2026-06.

  function isViewTranscriptionBtn(b) {
    if (b.getAttribute('role') !== 'button') return false;
    // Tolerant match: IG ships label variants ("View transcription" / "View
    // transcript" / case shifts). Exact equality silently missed the click.
    const label = (b.textContent || '').trim().toLowerCase();
    if (!(label.startsWith('view') && /transcri/.test(label) && label.length <= 40)) return false;
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  async function revealVoiceTranscripts() {
    if (detectPlatform() !== 'instagram') return;
    // Default ON; only OFF when explicitly set false.
    try {
      const r = await chrome.storage.local.get('voiceTranscribe');
      if (r && r.voiceTranscribe === false) return;
    } catch { /* storage unavailable — default ON */ }

    const btns = [...document.querySelectorAll('div[role="button"]')].filter(isViewTranscriptionBtn);
    if (btns.length === 0) return;

    btns.forEach(b => { try { b.click(); } catch {} });

    // Wait for transcripts to render OR the Meta consent dialog to appear.
    const start = Date.now();
    while (Date.now() - start < 2500) {
      await sleep(150);
      const consent = [...document.querySelectorAll('[role="dialog"]')]
        .some(d => /audio messages into text/i.test(d.textContent || ''));
      if (consent) {
        // One-time data-sharing consent — surface it, never click "Continue".
        try {
          chrome.runtime.sendMessage({ action: 'consentNeeded', data: { platform: 'instagram' } }).catch(() => {});
        } catch {}
        return;
      }
      const remaining = [...document.querySelectorAll('div[role="button"]')].filter(isViewTranscriptionBtn);
      if (remaining.length === 0) break;
    }
  }

  function pushLoadingState(loading) {
    try {
      chrome.runtime.sendMessage({
        action: 'convoLoadingState',
        data: { loading, threadId: getThreadId(), platform: detectPlatform() }
      }).catch(() => {});
    } catch {}
  }

  // ---------- Push current state to background ----------

  let lastSentSignature = null;

  function pushUpdate(reason = 'unknown') {
    const platform = detectPlatform();
    let result = extractConversation();

    // Trim long threads (IG / FB / Messenger) to last N messages
    if (result.messages && result.messages.length > TARGET_MESSAGE_COUNT) {
      const trimmed = result.messages.slice(-TARGET_MESSAGE_COUNT);
      result = {
        ...result,
        messages: trimmed,
        messageCount: trimmed.length,
        truncated: true,
        originalCount: result.messages.length,
        text: trimmed.map(m => `${m.role === 'you' ? 'YOU' : 'THEM'}: ${m.text}`).join('\n')
      };
    }

    const payload = {
      action: 'convoUpdate',
      data: {
        platform,
        url: location.href,
        threadId: getThreadId(),
        threadOpen: isThreadOpen(),
        ...result,
        reason,
        timestamp: Date.now()
      }
    };

    const sig = JSON.stringify({
      p: payload.data.platform,
      t: payload.data.threadId,
      c: payload.data.messageCount,
      last: payload.data.messages?.[payload.data.messages.length - 1]?.text
    });
    if (sig === lastSentSignature) return;
    lastSentSignature = sig;

    try { chrome.runtime.sendMessage(payload).catch(() => {}); } catch {}

    // History load is user-triggered only (Read Full Thread button → the
    // loadThreadHistory action below). Auto-loading on thread detection made
    // every IG/FB tab burst-scroll on its own — including background windows.
  }

  // ---------- Watchers ----------

  // 1. URL change detection (SPA routing)
  let lastUrl = location.href;
  function checkUrl() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastSentSignature = null;
      setTimeout(() => pushUpdate('url-change'), 600);
    }
  }
  ['pushState', 'replaceState'].forEach(method => {
    const orig = history[method];
    history[method] = function (...args) {
      const ret = orig.apply(this, args);
      window.dispatchEvent(new Event('revsetter-locationchange'));
      return ret;
    };
  });
  window.addEventListener('popstate', checkUrl);
  window.addEventListener('revsetter-locationchange', checkUrl);
  setInterval(checkUrl, 1500);

  // 2. DOM mutation observer (debounced)
  let mutTimer = null;
  const observer = new MutationObserver(() => {
    if (mutTimer) clearTimeout(mutTimer);
    mutTimer = setTimeout(() => pushUpdate('dom-mutation'), 400);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Composer auto-insert (BOO-36).
  // Lexical (IG) and Draft (FB/Messenger) ignore textContent assignment ...
  // they only register edits that arrive via the input pipeline. execCommand
  // is deprecated but is the one path Meta's composers still honor.

  function findComposer() {
    const candidates = document.querySelectorAll('div[contenteditable="true"][role="textbox"]');
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return el;
    }
    return null;
  }

  function insertIntoComposer(text) {
    if (!text) return { ok: false, reason: 'empty_text' };
    const composer = findComposer();
    if (!composer) return { ok: false, reason: 'composer_not_found' };

    composer.focus();

    // Move caret to end so existing draft text is preserved (append, not replace).
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const current = composer.textContent;
    const needsSeparator = current.trim() && !/\s$/.test(current);
    const payload = needsSeparator ? ' ' + text : text;

    const inserted = document.execCommand('insertText', false, payload);
    if (!inserted) {
      composer.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: payload,
        bubbles: true,
        cancelable: true
      }));
      return { ok: false, reason: 'execCommand_failed' };
    }
    return { ok: true };
  }

  // 3. On-demand requests
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'getCurrentConvo') {
      // Reveal IG voice-note transcripts (if enabled) BEFORE extracting, so the
      // preview includes them. Async → respond from inside the promise. History
      // load is NOT auto-triggered here — the user asks via loadThreadHistory.
      (async () => {
        try { await revealVoiceTranscripts(); } catch {}
        sendResponse({
          platform: detectPlatform(),
          url: location.href,
          threadId: getThreadId(),
          threadOpen: isThreadOpen(),
          ...extractConversation()
        });
      })();
      return true;
    }
    if (request && request.action === 'loadThreadHistory') {
      // User-triggered deep read (Read Full Thread button). Reset the dedup
      // flag so a re-click re-reads even a previously loaded thread. The
      // loader's pushUpdate('history-loaded') refreshes the panel when done.
      const platform = detectPlatform();
      if (!isThreadOpen()) {
        sendResponse({ started: false, reason: 'no_thread_open' });
        return true;
      }
      historyLoadedForThread = null;
      if (platform === 'instagram') loadInstagramHistory();
      else if (platform === 'facebook' || platform === 'messenger') loadMetaHistory();
      sendResponse({ started: true });
      return true;
    }
    if (request && request.action === 'insertIntoComposer') {
      sendResponse(insertIntoComposer(request.data && request.data.text));
      return true;
    }
  });

  // 4. Initial push
  setTimeout(() => pushUpdate('initial'), 800);
})();
