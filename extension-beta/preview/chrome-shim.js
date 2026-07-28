// Chrome API shim for preview-only rendering.
// Mocks chrome.* surface AND mocks the background's message handlers.
// All "AI" calls return canned content. Use the dev panel (top-right) to
// flip between user states (logged out / free / pro / client / setup).

(function () {
  const STORAGE_PREFIX = 'revsetter-preview:';
  const STATE_KEY = 'revsetter-preview-state';
  const lsKey = k => STORAGE_PREFIX + k;

  // ---------- Mock chrome.storage.local ----------
  const storageLocal = {
    get(keys, cb) {
      const out = {};
      const list = Array.isArray(keys) ? keys : (keys ? [keys] : []);
      list.forEach(k => {
        const raw = localStorage.getItem(lsKey(k));
        if (raw !== null) {
          try { out[k] = JSON.parse(raw); } catch { out[k] = raw; }
        }
      });
      if (cb) { setTimeout(() => cb(out), 0); return; }
      return Promise.resolve(out); // MV3 promise form (sidepanel reads voiceTranscribe via await)
    },
    set(items, cb) {
      Object.keys(items).forEach(k => localStorage.setItem(lsKey(k), JSON.stringify(items[k])));
      if (cb) { setTimeout(cb, 0); return; }
      return Promise.resolve();
    },
    remove(keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach(k => localStorage.removeItem(lsKey(k)));
      if (cb) setTimeout(cb, 0);
    }
  };

  // ---------- Preview state (the fake "logged-in user") ----------

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY)) || defaultState(); }
    catch { return defaultState(); }
  }
  function saveState(s) { localStorage.setItem(STATE_KEY, JSON.stringify(s)); }
  function defaultState() {
    return {
      signedIn: false,
      profile: null,
      credits: null
    };
  }

  // Preset user fixtures (chosen via dev toggle)
  const FIXTURES = {
    'free-new': {
      profile: {
        id: 'sub-001', email: 'free.user@example.com', name: 'Free User',
        picture: 'https://api.dicebear.com/7.x/initials/svg?seed=Free%20User',
        role: 'subscriber', is_whitelisted: false, setup_complete: false,
        business_name: '', niche: '', ideal_client: '',
        tone_preferences: '', target_pain_points: '', services_offered: '',
        llm_provider: '', llm_api_key_last4: ''
      },
      credits: { balance: 5, weekly_free_allowance: 5, monthly_paid_allowance: 0, total_used: 0 }
    },
    'free-set': {
      profile: {
        id: 'sub-002', email: 'sara@example.com', name: 'Sara',
        picture: 'https://api.dicebear.com/7.x/initials/svg?seed=Sara',
        role: 'subscriber', is_whitelisted: false, setup_complete: true,
        business_name: 'Sara Coaching', niche: 'New moms returning to fitness',
        ideal_client: 'Postpartum moms 30-45 wanting to feel strong again without giving up an hour a day.',
        tone_preferences: 'Warm, peer, no jargon',
        target_pain_points: 'No time, low energy, body image',
        services_offered: '12-week 1:1 program',
        booking_link: 'https://cal.com/sara-coaching/discovery',
        llm_provider: '', llm_api_key_last4: ''
      },
      credits: { balance: 3, weekly_free_allowance: 5, monthly_paid_allowance: 0, total_used: 2 }
    },
    'pro-set': {
      profile: {
        id: 'sub-003', email: 'pro@example.com', name: 'Pro User',
        picture: 'https://api.dicebear.com/7.x/initials/svg?seed=Pro%20User',
        role: 'subscriber', is_whitelisted: false, setup_complete: true,
        business_name: 'Pro Coaching Co.', niche: 'Strength coaches',
        ideal_client: 'Strength coaches with $5k-$20k/mo wanting to scale.',
        tone_preferences: 'Direct, technical',
        target_pain_points: 'Lead flow, high-ticket close',
        services_offered: 'Mastermind + 1:1',
        booking_link: 'https://calendly.com/pro-coaching/15min',
        llm_provider: '', llm_api_key_last4: ''
      },
      credits: { balance: 240, weekly_free_allowance: 0, monthly_paid_allowance: 300, total_used: 60 }
    },
    'client-new': {
      profile: {
        id: 'cli-001', email: 'newclient@revxl.com', name: 'New REVXL Client',
        picture: 'https://api.dicebear.com/7.x/initials/svg?seed=New%20Client',
        role: 'client', is_whitelisted: true, setup_complete: false,
        business_name: '', niche: '', ideal_client: '',
        tone_preferences: '', target_pain_points: '', services_offered: '',
        llm_provider: '', llm_api_key_last4: ''
      },
      credits: { balance: 0, weekly_free_allowance: 0, monthly_paid_allowance: 0, total_used: 0 }
    },
    'client-set': {
      profile: {
        id: 'cli-002', email: 'joe@bizzfixx.com', name: 'Joe Olive',
        picture: 'https://api.dicebear.com/7.x/initials/svg?seed=Joe%20Olive',
        role: 'client', is_whitelisted: true, setup_complete: true,
        business_name: 'Engine For Impact / REVXL',
        niche: 'Health, wellness, fitness coaches',
        ideal_client: 'Coaches with $3k-$25k/mo wanting to add a setter system without losing voice.',
        tone_preferences: 'Casual, peer, dry humor, no corporate-speak',
        target_pain_points: 'Ghosts, low DM-to-call conversion, time drain',
        services_offered: 'REVSetter AI + REVXL mentorship',
        booking_link: 'https://booking.engineforimpact.com',
        llm_provider: 'openai', llm_api_key_last4: 'A4Bx'
      },
      credits: { balance: 0, weekly_free_allowance: 0, monthly_paid_allowance: 0, total_used: 0 }
    }
  };

  let state = loadState();

  // Fake platform/convo state for the dev toggle
  const PLATFORM_FIXTURES = {
    'none': null,
    'ig-thread': {
      platform: 'instagram',
      url: 'https://instagram.com/direct/t/12345/',
      threadId: '12345',
      threadOpen: true,
      messages: [
        { role: 'them', text: 'Hey! Saw your post about the 12-week program. Curious about it' },
        { role: 'you', text: 'Hey, thanks for reaching out. What stood out about it?' },
        { role: 'them', text: 'I\'ve tried doing it on my own and just keep falling off' },
        { role: 'them', text: 'Mostly because of how busy I am with the kids' },
        { role: 'you', text: 'Yeah, totally hear that. How much time do you usually have to give it?' },
        { role: 'them', text: 'Honestly maybe 30 min if I\'m lucky' }
      ],
      messageCount: 6,
      text: 'THEM: Hey! Saw your post about the 12-week program. Curious about it\nYOU: Hey, thanks for reaching out. What stood out about it?\nTHEM: I\'ve tried doing it on my own and just keep falling off\nTHEM: Mostly because of how busy I am with the kids\nYOU: Yeah, totally hear that. How much time do you usually have to give it?\nTHEM: Honestly maybe 30 min if I\'m lucky',
      error: null
    },
    'ig-inbox': {
      platform: 'instagram',
      url: 'https://instagram.com/direct/inbox/',
      threadId: null,
      threadOpen: false,
      messages: [],
      messageCount: 0,
      text: '',
      error: null
    },
    'fb-thread': {
      platform: 'facebook',
      url: 'https://facebook.com/messages/t/67890/',
      threadId: '67890',
      threadOpen: true,
      messages: [
        { role: 'them', text: 'I saw the post about the new opt-in. is this for beginners too?' },
        { role: 'you', text: 'Hey! Yes ... we have folks at every level. What are you working on now?' },
        { role: 'them', text: 'Just trying to get back into shape after a long break' }
      ],
      messageCount: 3,
      text: 'THEM: I saw the post about the new opt-in. is this for beginners too?\nYOU: Hey! Yes ... we have folks at every level. What are you working on now?\nTHEM: Just trying to get back into shape after a long break',
      error: null
    },
    'msg-thread': {
      platform: 'messenger',
      url: 'https://messenger.com/t/abc/',
      threadId: 'abc',
      threadOpen: true,
      messages: [
        { role: 'you', text: 'Hey, what made you DM me?' },
        { role: 'them', text: 'Saw your reel and felt called out lol' }
      ],
      messageCount: 2,
      text: 'YOU: Hey, what made you DM me?\nTHEM: Saw your reel and felt called out lol',
      error: null
    },
    'ig-truncated': (() => {
      const msgs = [];
      const turns = ['them', 'you'];
      for (let i = 0; i < 50; i++) {
        msgs.push({
          role: turns[i % 2],
          text: i === 0 ? 'Hey thanks for following back!' :
                i === 49 ? 'Sounds good — what time works for you?' :
                `Message #${i + 1} in this thread, just filler so you can see scrolling.`
        });
      }
      return {
        platform: 'instagram',
        url: 'https://instagram.com/direct/t/long/',
        threadId: 'long',
        threadOpen: true,
        messages: msgs,
        messageCount: 50,
        text: msgs.map(m => `${m.role === 'you' ? 'YOU' : 'THEM'}: ${m.text}`).join('\n'),
        truncated: true,
        originalCount: 247,
        error: null
      };
    })(),
    'extract-fail': {
      platform: 'instagram',
      url: 'https://instagram.com/direct/t/broken/',
      threadId: 'broken',
      threadOpen: true,
      messages: [],
      messageCount: 0,
      text: '',
      error: 'Could not parse conversation. DOM may have changed.'
    }
  };

  let currentPlatformFixture = localStorage.getItem('revsetter-platform-fixture') || 'none';

  function getCurrentConvo() {
    const fx = PLATFORM_FIXTURES[currentPlatformFixture];
    if (!fx) return { platform: null, threadOpen: false, messages: [], text: '', error: null };
    return fx;
  }

  function setPlatformFixture(name) {
    currentPlatformFixture = name;
    localStorage.setItem('revsetter-platform-fixture', name);
  }

  // ---------- Action handlers (mirror background.js contract) ----------

  function getAuthState() {
    return Promise.resolve({
      signedIn: state.signedIn,
      profile: state.profile,
      credits: state.credits
    });
  }

  async function signInWithGoogle() {
    await new Promise(r => setTimeout(r, 500));
    // Default to "free-new" on first sign-in unless dev panel preset something
    if (!state.profile) {
      state = { signedIn: true, ...FIXTURES['free-new'] };
    } else {
      state.signedIn = true;
    }
    saveState(state);
    return { signedIn: true, profile: state.profile, credits: state.credits };
  }

  function signOut() {
    state = defaultState();
    saveState(state);
    return Promise.resolve({ signedIn: false });
  }

  async function completeSetup({ business_name, niche, ideal_client, tone_preferences, target_pain_points, services_offered, llm_provider, llm_api_key }) {
    await new Promise(r => setTimeout(r, 400));
    state.profile = {
      ...state.profile,
      business_name, niche, ideal_client,
      tone_preferences, target_pain_points, services_offered,
      setup_complete: true
    };
    if (llm_api_key) {
      state.profile.llm_provider = llm_provider;
      state.profile.llm_api_key_last4 = llm_api_key.slice(-4);
    }
    saveState(state);
    return { profile: state.profile };
  }

  async function updateProfile(data) {
    await new Promise(r => setTimeout(r, 300));
    state.profile = { ...state.profile, ...data };
    saveState(state);
    return { profile: state.profile };
  }

  async function updateLLMKey({ llm_provider, llm_api_key }) {
    await new Promise(r => setTimeout(r, 300));
    state.profile.llm_provider = llm_provider;
    state.profile.llm_api_key_last4 = llm_api_key.slice(-4);
    saveState(state);
    return { profile: state.profile };
  }

  async function generateReply({ conversationText }) {
    await new Promise(r => setTimeout(r, 800));
    if (state.profile?.role === 'subscriber') {
      state.credits.balance = Math.max(0, state.credits.balance - 1);
      state.credits.total_used += 1;
      saveState(state);
    }
    const snippet = (conversationText || '').slice(0, 100).replace(/\s+/g, ' ').trim();
    const reply =
      `**PREVIEW MODE**\n\n` +
      `**SUGGESTED REPLY:**\n` +
      `Hey ... totally hear you on that. Curious, what's actually been the biggest blocker for you so far?\n\n` +
      `**REASONING:** Mirrors prospect energy, opens a low-pressure question, advances toward pain naming.\n\n` +
      `**PHASE:** Discovery (yellow signal)\n\n` +
      `**Input snippet:** ${snippet || '(empty)'}`;
    return { reply, credits: state.credits };
  }

  async function askAI({ question }) {
    await new Promise(r => setTimeout(r, 600));
    if (state.profile?.role === 'subscriber') {
      state.credits.balance = Math.max(0, state.credits.balance - 1);
      state.credits.total_used += 1;
      saveState(state);
    }
    return {
      answer: `[Preview Mode] You asked: "${question}". In production this hits your n8n endpoint, which calls a stock LLM for general queries.`,
      credits: state.credits
    };
  }

  const ACTIONS = {
    getAuthState: () => getAuthState(),
    signInWithGoogle: () => signInWithGoogle(),
    signOut: () => signOut(),
    completeSetup: (req) => completeSetup(req.data),
    updateProfile: (req) => updateProfile(req.data),
    updateLLMKey: (req) => updateLLMKey(req.data),
    generateReply: (req) => generateReply(req.data),
    askAI: (req) => askAI(req.data),
    requestCurrentConvo: () => Promise.resolve(getCurrentConvo()),
    insertIntoComposer: (req) => Promise.resolve({ ok: true, preview: true, text: req.data && req.data.text })
  };

  // ---------- Mock chrome.* surface ----------
  const messageListeners = [];
  function broadcastMessage(msg) {
    messageListeners.forEach(fn => { try { fn(msg, {}, () => {}); } catch {} });
  }

  window.chrome = {
    storage: { local: storageLocal },
    runtime: {
      sendMessage(request) {
        return new Promise(resolve => {
          const handler = ACTIONS[request && request.action];
          if (!handler) {
            resolve({ error: `Preview shim: unknown action "${request?.action}"` });
            return;
          }
          handler(request).then(resolve).catch(err => resolve({ error: err.message }));
        });
      },
      onMessage: {
        addListener(fn) { messageListeners.push(fn); }
      },
      lastError: null
    },
    identity: {
      getRedirectURL() { return 'https://<extension-id>.chromiumapp.org/  (preview placeholder)'; },
      launchWebAuthFlow(_o, cb) { setTimeout(() => cb('https://<extension-id>.chromiumapp.org/#access_token=preview'), 300); }
    },
    action: { onClicked: { addListener() {} } },
    notifications: { create() {} },
    sidePanel: { open() {} }
  };

  // ---------- Dev toggle UI ----------
  document.addEventListener('DOMContentLoaded', () => {
    // Top banner
    const banner = document.createElement('div');
    banner.textContent = 'PREVIEW MODE — Chrome APIs mocked, AI responses faked.';
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      background: #fbbf24; color: #1f1f1f; font-size: 11px; font-weight: 600;
      text-align: center; padding: 4px 8px; font-family: -apple-system, sans-serif;
    `;
    document.body.appendChild(banner);

    // Dev panel — collapsible so it doesn't cover the UI
    const devOpen = localStorage.getItem('revsetter-dev-open') === '1';

    const devToggle = document.createElement('button');
    devToggle.id = 'revsetter-dev-toggle';
    devToggle.textContent = devOpen ? '✕' : 'DEV';
    devToggle.style.cssText = `
      position: fixed; top: 30px; right: 12px; z-index: 9999;
      background: #dc2626; color: #fff; border: none;
      width: 36px; height: 36px; border-radius: 50%;
      font-family: -apple-system, sans-serif; font-size: 11px; font-weight: 700;
      cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(devToggle);

    const dev = document.createElement('div');
    dev.id = 'revsetter-dev-panel';
    dev.style.cssText = `
      position: fixed; top: 76px; right: 12px; z-index: 9998;
      background: #1f1f1f; color: #fff; padding: 8px 10px; border-radius: 8px;
      font-family: -apple-system, sans-serif; font-size: 11px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4); border: 1px solid #444;
      display: ${devOpen ? 'flex' : 'none'}; flex-direction: column; gap: 6px;
      min-width: 200px; max-height: calc(100vh - 100px); overflow-y: auto;
    `;
    dev.innerHTML = `
      <div style="font-weight: 700; opacity: 0.7;">DEV: User as</div>
      <button data-fixture="logout" style="${devBtn()}">Logged out</button>
      <button data-fixture="free-new" style="${devBtn()}">Free (new, setup pending)</button>
      <button data-fixture="free-set" style="${devBtn()}">Free (3/5 credits)</button>
      <button data-fixture="pro-set" style="${devBtn()}">Pro subscriber (240)</button>
      <button data-fixture="client-new" style="${devBtn()}">REVXL client (new)</button>
      <button data-fixture="client-set" style="${devBtn()}">REVXL client (full)</button>
      <div style="font-weight: 700; opacity: 0.7; margin-top: 8px;">DEV: Platform</div>
      <button data-platform="none" style="${devBtn()}">No platform</button>
      <button data-platform="ig-thread" style="${devBtn()}">Instagram (thread open)</button>
      <button data-platform="ig-inbox" style="${devBtn()}">Instagram (inbox, no thread)</button>
      <button data-platform="fb-thread" style="${devBtn()}">Facebook (thread open)</button>
      <button data-platform="msg-thread" style="${devBtn()}">Messenger (thread open)</button>
      <button data-platform="ig-truncated" style="${devBtn()}">Instagram (50 of 247, truncated)</button>
      <button data-platform="extract-fail" style="${devBtn()}">Extraction failed</button>
      <button data-action="fake-loading" style="${devBtn()}">Toggle "Loading history..." pill</button>
      <button data-fixture="reset" style="${devBtn(true)}">Wipe preview state</button>
    `;
    document.body.appendChild(dev);

    devToggle.addEventListener('click', () => {
      const isOpen = dev.style.display !== 'none';
      dev.style.display = isOpen ? 'none' : 'flex';
      devToggle.textContent = isOpen ? 'DEV' : '✕';
      localStorage.setItem('revsetter-dev-open', isOpen ? '0' : '1');
    });

    dev.addEventListener('click', (e) => {
      const fx = e.target.getAttribute && e.target.getAttribute('data-fixture');
      const plat = e.target.getAttribute && e.target.getAttribute('data-platform');
      if (fx) {
        if (fx === 'logout') { state = defaultState(); }
        else if (fx === 'reset') { localStorage.clear(); state = defaultState(); }
        else if (FIXTURES[fx]) { state = { signedIn: true, ...JSON.parse(JSON.stringify(FIXTURES[fx])) }; }
        saveState(state);
        window.location.reload();
        return;
      }
      if (plat) {
        setPlatformFixture(plat);
        broadcastMessage({ action: 'convoUpdate', data: getCurrentConvo() });
      }
      const action = e.target.getAttribute && e.target.getAttribute('data-action');
      if (action === 'fake-loading') {
        broadcastMessage({ action: 'convoLoadingState', data: { loading: true } });
        setTimeout(() => broadcastMessage({ action: 'convoLoadingState', data: { loading: false } }), 3500);
      }
    });

    document.body.style.paddingTop = '24px';
  });

  function devBtn(danger = false) {
    return `
      background: ${danger ? '#7f1d1d' : '#2a2a2a'};
      color: #fff; border: 1px solid ${danger ? '#dc2626' : '#444'};
      padding: 6px 8px; border-radius: 4px; cursor: pointer; text-align: left;
      font-family: inherit; font-size: 11px;
    `;
  }
})();
