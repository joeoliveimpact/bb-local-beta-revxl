importScripts('vendor/supabase.js');
// BETA patch point 1/4 — Local Claude Engine logic (see extension-beta/BETA-DIFF.md).
importScripts('local-engine.js');

// =====================================================================
// Booking Bandit AI — background.js (active; landed from BOO-26 draft 2026-05-26)
// =====================================================================
// Implements BOO-26 (rewrite to new contract), BOO-3 (real Supabase Auth),
// BOO-31 (convo relay bridge), BOO-36 (insertIntoComposer relay),
// BOO-37 (auto-send server-side gate).
//
// Implements the canonical message contract defined in
// REVSetter PRO v1.2 - Build-in-progress/preview/chrome-shim.js — that
// file is the spec. The real background.js must match its action set
// and response shapes exactly so sidepanel.js works unchanged.
//
// Architecture:
//   sidepanel.js  <--chrome.runtime-->  background.js  <--fetch-->  backend (Hono on VPS)
//                                            ^
//                                            | chrome.tabs.sendMessage
//                                            v
//                                       content.js (IG/FB/Messenger)
//
// What this file does:
//   1. Action router — every action sidepanel.js sends has a handler here
//   2. Auth — Supabase Auth (Google provider). TODOs marked for the
//      supabase-js integration that arrives in BOO-2 / BOO-3.
//   3. Profile + LLM key — proxies to backend /profile endpoints
//   4. Generate / Ask — proxies to backend /generate, /ask
//      (Ask AI routing decision deferred to BOO-32; see ASK_AI_ENDPOINT)
//   5. Convo relay — listens for convoUpdate/convoLoadingState from
//      content.js, forwards to sidepanel; bridges requestCurrentConvo
//      (sidepanel name) -> getCurrentConvo (content.js name)
//   6. Configurable backend URL via chrome.storage; falls back to a
//      sensible default for development.
//
// What this file does NOT do (intentional, until other issues land):
//   - Vendor or import @supabase/supabase-js (BOO-2)
//   - Bake in real Supabase URL / anon key (loaded from storage, set by
//      BOO-1 SETUP.md completion)
//   - Make.com webhook calls (deprecated; removed)
//   - Direct OpenAI calls (deprecated; removed)
//   - direct chrome.identity Google OAuth (deprecated; Supabase handles it)
//
// =====================================================================

const STORAGE_KEYS = {
  // Persisted auth/profile state (mirror of preview shim's state shape)
  AUTH_SESSION: 'auth_session',          // { access_token, refresh_token, expires_at }
  USER_PROFILE: 'user_profile',          // matches DEFAULT_PROFILE in sidepanel.js
  USER_CREDITS: 'user_credits',          // matches DEFAULT_CREDITS in sidepanel.js
  // Config
  BACKEND_URL: 'backend_url',
  SUPABASE_URL: 'supabase_url',
  SUPABASE_ANON_KEY: 'supabase_anon_key'
};

// Default backend; override via chrome.storage during dev/staging.
// Production is set on first install via an install handler (TODO) or
// hardcoded to the deployed VPS URL once BOO-4 lands.
const DEFAULT_BACKEND_URL = 'https://revxl-vps.tailc17742.ts.net';  // Tailscale Funnel; swap to api.bookingbandit.<TLD> when BOO-18 domain registers

// Ask AI routing: preview/chrome-shim.js notes this should hit an n8n
// stock-LLM endpoint, NOT the main /generate path. Decision pending in
// BOO-32. For now we proxy to /ask on the main backend; switch this
// constant when BOO-32 resolves.
const ASK_AI_ENDPOINT = '/ask';  // TODO BOO-32: may change to n8n webhook URL

// Supabase config (anon key is safe to ship; protected by RLS server-side).
const SUPABASE_URL = 'https://vcoadeogmfoewlhnvgvq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjb2FkZW9nbWZvZXdsaG52Z3ZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2ODA2ODMsImV4cCI6MjA5NDI1NjY4M30.XFo8AdWNMVo1WvcpA1rDvIes4mvdhAZoNtFbrXRRtoE';

// Lazy supabase client init. Service worker can be killed/restarted; client
// re-creates on first use. In-memory session is rehydrated from storage on
// every signIn/signOut path.
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return _supabase;
}

// ---------------------------------------------------------------------
// Action router
// ---------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Messages from content.js (convo updates) come through here too.
  // They have no expected response; just forward to sidepanel.
  if (request?.action === 'convoUpdate' || request?.action === 'convoLoadingState' || request?.action === 'consentNeeded') {
    forwardToSidepanel(request);
    return false;
  }

  const handler = ACTION_HANDLERS[request?.action];
  if (!handler) {
    // Unknown action: respond with a clear error so sidepanel can surface it.
    sendResponse({ error: `Unknown action: ${request?.action}` });
    return false;
  }

  // All handlers are async; bridge via Promise.
  handler(request.data, sender)
    .then(result => sendResponse(result))
    .catch(err => {
      console.error(`[background] ${request.action} failed:`, err);
      // Paywall errors carry the 402 body through to the panel (set in backendFetch).
      // BETA: local-engine errors carry their code + technical detail through too,
      // so the panel can render an actionable error card (see local-engine.js).
      sendResponse({
        error: err.message || 'Unknown error',
        ...(err.paywall ? { paywall: true, paywallInfo: err.paywallInfo || {} } : {}),
        ...(err.localEngine ? { engineError: err.engineError || 'unknown', engineDetail: err.engineDetail || '' } : {})
      });
    });
  return true;  // keep the message channel open for async sendResponse
});

// ---------------------------------------------------------------------
// Side panel open trigger (toolbar icon click)
// ---------------------------------------------------------------------

// Primary: let Chrome open the side panel natively on icon click. This is
// gesture-safe even when the service worker was asleep (the onClicked path
// below can lose the user-gesture while the worker spins up after a reload).
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(err => console.error('[background] setPanelBehavior failed:', err));
}

// Fallback for older Chrome without openPanelOnActionClick.
chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(err => {
      console.error('[background] sidePanel.open failed:', err);
    });
  }
});

// ---------------------------------------------------------------------
// Convo relay (content.js -> sidepanel)
// ---------------------------------------------------------------------

function forwardToSidepanel(request) {
  // chrome.runtime.sendMessage with no recipient broadcasts to extension
  // listeners (sidepanel + popup + other background contexts). The
  // sidepanel's onMessage listener picks it up by action name.
  chrome.runtime.sendMessage(request).catch(() => {
    // Sidepanel may not be open; silent.
  });
}

// ---------------------------------------------------------------------
// requestCurrentConvo (sidepanel) -> getCurrentConvo (content.js)
// ---------------------------------------------------------------------
// Bridges the action-name mismatch identified in BOO-31. Queries the
// active tab's content script and returns the convo snapshot.

async function requestCurrentConvo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { platform: null, threadOpen: false, messages: [], error: 'No active tab' };

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'getCurrentConvo' });
    return res || { platform: null, threadOpen: false, messages: [], error: 'No response from content script' };
  } catch (err) {
    // Likely: content script not injected on this tab (off-platform).
    return { platform: null, threadOpen: false, messages: [], error: null };
  }
}

// ---------------------------------------------------------------------
// Auth — Supabase Google OAuth
// ---------------------------------------------------------------------
// IMPLEMENTATION NOTE: real Supabase Auth integration arrives in BOO-2
// (vendor @supabase/supabase-js) + BOO-3 (wire flow). This stub stores
// the post-OAuth profile shape so the rest of the contract can be
// tested against the preview shim and against a stub backend.
//
// When supabase-js is vendored:
//   - replace performSupabaseSignIn() with supabase.auth.signInWithOAuth({ provider: 'google' })
//   - replace performSupabaseSignOut() with supabase.auth.signOut()
//   - replace getAccessToken() with supabase.auth.getSession()
//
// The action contract here does NOT change.

async function getAuthState() {
  const { [STORAGE_KEYS.AUTH_SESSION]: session,
          [STORAGE_KEYS.USER_PROFILE]: profile,
          [STORAGE_KEYS.USER_CREDITS]: credits } = await chrome.storage.local.get([
    STORAGE_KEYS.AUTH_SESSION,
    STORAGE_KEYS.USER_PROFILE,
    STORAGE_KEYS.USER_CREDITS
  ]);

  return {
    signedIn: !!session,
    profile: profile || null,
    credits: credits || null
  };
}

async function signInWithGoogle() {
  // PKCE-via-chrome.identity pattern: Supabase's default signInWithOAuth uses
  // a browser-level redirect that doesn't work in an extension. Instead we
  // open Supabase's /authorize endpoint in chrome.identity's auth popup, let
  // Supabase complete the OAuth dance, then capture the tokens it appends
  // to the redirect URL fragment when it bounces us back to chromiumapp.org.
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUri)}`;

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (url) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!url) reject(new Error('OAuth cancelled'));
        else resolve(url);
      }
    );
  });

  const fragment = new URL(responseUrl).hash.slice(1);
  const params = new URLSearchParams(fragment);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const expiresIn = parseInt(params.get('expires_in') || '3600', 10);

  if (!accessToken) {
    throw new Error('Sign-in returned no access token. Check that the extension\'s chromiumapp.org redirect URL is in Supabase Auth → URL Configuration → Redirect URLs.');
  }

  // Install session in the supabase client so subsequent SDK calls work.
  await getSupabase().auth.setSession({ access_token: accessToken, refresh_token: refreshToken });

  const { data: { user } } = await getSupabase().auth.getUser();

  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn
  };

  // Profile + credits will be replaced by backend /me when BOO-4 deploy lands.
  // Until then, derive a minimal profile from Supabase user + safe defaults.
  const profile = {
    email: user?.email || '',
    name: user?.user_metadata?.full_name || user?.email || '',
    picture: user?.user_metadata?.avatar_url || user?.user_metadata?.picture || null,
    role: 'subscriber',
    setup_complete: false
  };
  // Stub until /me returns real entitlement: free tier = 0 purchasable credits,
  // 25 replies/week (matches backend WEEKLY_FREE_BASE).
  const credits = { balance: 0, weekly_free_allowance: 25, monthly_paid_allowance: 0, total_used: 0 };

  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTH_SESSION]: session,
    [STORAGE_KEYS.USER_PROFILE]: profile,
    [STORAGE_KEYS.USER_CREDITS]: credits
  });

  // Replace the stub with the real server profile (role, name, picture,
  // setup_complete, balance). Fail-soft: a /me hiccup falls back to the stub.
  try {
    const fresh = await refreshProfile();
    return { signedIn: true, ...fresh };
  } catch {
    return { signedIn: true, profile, credits };
  }
}

// Pull the real profile + balance from backend /me and merge over the locally
// stored profile (which starts life as a sign-in stub). Fixes the "?" avatar /
// blank settings after OAuth: local state never reflected the server profile.
async function refreshProfile() {
  // /me carries identity/tier/balance; /profile carries the business fields
  // (niche, booking_link, ...) + key last4 + model. Pull both so a fresh install
  // rehydrates the full profile from the server, not only from local cache.
  // /profile is fail-soft: a hiccup keeps whatever business fields were cached.
  const [me, settingsRes] = await Promise.all([
    backendGet('/me'),
    backendGet('/profile').catch(() => null)
  ]);
  const settings = settingsRes?.profile || null;
  const { [STORAGE_KEYS.USER_PROFILE]: existing,
          [STORAGE_KEYS.USER_CREDITS]: cred } = await chrome.storage.local.get([
    STORAGE_KEYS.USER_PROFILE,
    STORAGE_KEYS.USER_CREDITS
  ]);
  const profile = {
    ...(existing || {}),
    ...(settings || {}),
    email: me.profile.email,
    name: me.profile.full_name || me.profile.email || '',
    picture: me.profile.picture_url || null,
    role: me.profile.role,
    is_whitelisted: me.profile.is_whitelisted,
    setup_complete: me.profile.setup_complete,
    tier: me.profile.tier,
    skool_member: me.profile.skool_member,
    // BETA: carry the local-engine whitelist flag through so the panel can show
    // the Draft engine toggle (refreshProfile rebuilds profile from a fixed list).
    local_engine_allowed: me.profile.local_engine_allowed
  };
  const credits = { ...(cred || {}), balance: me.balance, entitlement: me.entitlement || null };
  await chrome.storage.local.set({
    [STORAGE_KEYS.USER_PROFILE]: profile,
    [STORAGE_KEYS.USER_CREDITS]: credits
  });
  return { profile, credits };
}

async function signOut() {
  try {
    await getSupabase().auth.signOut();
  } catch (err) {
    // Clear local state even if remote sign-out fails (network issue, etc).
    console.warn('[background] supabase.auth.signOut failed:', err);
  }
  await chrome.storage.local.remove([
    STORAGE_KEYS.AUTH_SESSION,
    STORAGE_KEYS.USER_PROFILE,
    STORAGE_KEYS.USER_CREDITS
  ]);
  return { signedIn: false };
}

// ---------------------------------------------------------------------
// Backend HTTP helpers
// ---------------------------------------------------------------------

async function getBackendUrl() {
  const { [STORAGE_KEYS.BACKEND_URL]: url } = await chrome.storage.local.get(STORAGE_KEYS.BACKEND_URL);
  return url || DEFAULT_BACKEND_URL;
}

// Throwaway helper: detects the pre-BOO-4 placeholder so profile writes can
// short-circuit to chrome.storage.local and let Joe click through the app
// before the VPS backend is live. Delete after BOO-4 deploys.
function isPlaceholderBackend(url) {
  return !url || url.includes('bookingbandit.example');
}

// Refresh the Supabase session using the stored refresh token. Returns the
// new access token, or null if refresh failed (user must sign in again).
async function refreshSession() {
  const { [STORAGE_KEYS.AUTH_SESSION]: session } = await chrome.storage.local.get(STORAGE_KEYS.AUTH_SESSION);
  if (!session?.refresh_token) return null;
  try {
    const { data, error } = await getSupabase().auth.refreshSession({ refresh_token: session.refresh_token });
    if (error || !data?.session?.access_token) {
      console.warn('[background] session refresh failed:', error?.message || 'no session returned');
      return null;
    }
    const fresh = {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token || session.refresh_token,
      expires_at: data.session.expires_at || Math.floor(Date.now() / 1000) + 3600
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.AUTH_SESSION]: fresh });
    return fresh.access_token;
  } catch (err) {
    console.warn('[background] session refresh threw:', err);
    return null;
  }
}

async function getAccessToken() {
  // BOO-3: return real Supabase session access token.
  // Proactively refresh when the token is expired or within 60s of expiry,
  // so requests stop dying with invalid_token an hour after sign-in.
  const { [STORAGE_KEYS.AUTH_SESSION]: session } = await chrome.storage.local.get(STORAGE_KEYS.AUTH_SESSION);
  if (!session?.access_token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at && session.expires_at - now < 60) {
    const refreshed = await refreshSession();
    if (refreshed) return refreshed;
  }
  return session.access_token;
}

async function backendFetch(method, path, body = null, _isRetry = false, timeoutMs = 0) {
  const baseUrl = await getBackendUrl();
  const token = await getAccessToken();
  if (!token) throw new Error('Not signed in');

  const url = `${baseUrl}${path}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const init = { method, headers };
  if (body) init.body = JSON.stringify(body);

  // BETA (opt-in per call): abort a hung request instead of pinning the caller
  // forever. Cloud callsites pass no timeout and keep their existing behavior.
  let abortTimer = null;
  if (timeoutMs > 0) {
    const ctrl = new AbortController();
    init.signal = ctrl.signal;
    abortTimer = setTimeout(() => ctrl.abort(), timeoutMs);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`Backend ${method} ${path} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }

  // Stale/expired token: refresh once and retry the request transparently.
  if (res.status === 401 && !_isRetry) {
    const refreshed = await refreshSession();
    if (refreshed) return backendFetch(method, path, body, true, timeoutMs);
    throw new Error('Session expired. Please sign in again.');
  }

  // 402 = paywall. Keep the body (weeklyUsed/weeklyAllowance/monthlyCap...) so
  // the panel can show "X of Y used" instead of a bare error string.
  if (res.status === 402) {
    let body = null;
    try { body = await res.json(); } catch {}
    const err = new Error(body?.error || 'insufficient_credits');
    err.paywall = true;
    err.paywallInfo = body || {};
    throw err;
  }

  if (!res.ok) {
    let errBody = null;
    try { errBody = await res.json(); } catch {}
    throw new Error(errBody?.error || `Backend ${method} ${path} failed: HTTP ${res.status}`);
  }
  return res.json();
}

const backendGet   = (path) => backendFetch('GET',   path);
const backendPost  = (path, body) => backendFetch('POST',  path, body);
const backendPatch = (path, body) => backendFetch('PATCH', path, body);
// BETA: timed POST for the local-engine calls (see local-engine.js).
const backendPostTimed = (path, body, timeoutMs) => backendFetch('POST', path, body, false, timeoutMs);

// ---------------------------------------------------------------------
// Profile / setup handlers
// ---------------------------------------------------------------------

async function completeSetup(data) {
  // data shape (from sidepanel.js handleSetupNext/handleSetupComplete):
  //   { business_name, niche, ideal_client, tone_preferences,
  //     target_pain_points, services_offered, booking_link,
  //     llm_provider?, llm_api_key? }
  // Backend persists, sets setup_complete=true, returns updated profile.
  const url = await getBackendUrl();
  if (isPlaceholderBackend(url)) {
    const existing = (await chrome.storage.local.get(STORAGE_KEYS.USER_PROFILE))[STORAGE_KEYS.USER_PROFILE] || {};
    // Strip the raw API key before persisting (plaintext would be a risk
    // even locally). Keep provider + last4 only.
    const { llm_api_key, ...safeData } = data;
    const llmFields = llm_api_key ? { llm_provider: data.llm_provider, llm_api_key_last4: llm_api_key.slice(-4) } : {};
    const profile = { ...existing, ...safeData, ...llmFields, setup_complete: true };
    await chrome.storage.local.set({ [STORAGE_KEYS.USER_PROFILE]: profile });
    return { profile };
  }
  const result = await backendPost('/profile/setup', data);
  await chrome.storage.local.set({ [STORAGE_KEYS.USER_PROFILE]: result.profile });
  // /profile/setup's profile view lacks name/picture/role — re-pull /me so the
  // header doesn't blank out after onboarding. Best-effort.
  const refreshed = await refreshProfile().catch(() => null);
  return { profile: refreshed?.profile || result.profile, key_verified: result.key_verified ?? null };
}

async function updateProfile(data) {
  const url = await getBackendUrl();
  if (isPlaceholderBackend(url)) {
    const existing = (await chrome.storage.local.get(STORAGE_KEYS.USER_PROFILE))[STORAGE_KEYS.USER_PROFILE] || {};
    const profile = { ...existing, ...data };
    await chrome.storage.local.set({ [STORAGE_KEYS.USER_PROFILE]: profile });
    return { profile };
  }
  const result = await backendPatch('/profile', data);
  await chrome.storage.local.set({ [STORAGE_KEYS.USER_PROFILE]: result.profile });
  // Same name/picture gap as completeSetup — re-pull /me. Best-effort.
  const refreshed = await refreshProfile().catch(() => null);
  return { profile: refreshed?.profile || result.profile };
}

async function updateLLMKey(data) {
  // data: { llm_provider, llm_api_key }
  // Backend encrypts + stores; response carries llm_provider + last4 only.
  const url = await getBackendUrl();
  if (isPlaceholderBackend(url)) {
    // Local mode: store provider + last4, NOT the raw key. Generating
    // won't work without the real key anyway (also needs backend).
    const existing = (await chrome.storage.local.get(STORAGE_KEYS.USER_PROFILE))[STORAGE_KEYS.USER_PROFILE] || {};
    const profile = { ...existing, llm_provider: data.llm_provider, llm_api_key_last4: (data.llm_api_key || '').slice(-4) };
    await chrome.storage.local.set({ [STORAGE_KEYS.USER_PROFILE]: profile });
    return { profile };
  }
  const result = await backendPatch('/profile/key', data);
  await chrome.storage.local.set({ [STORAGE_KEYS.USER_PROFILE]: result.profile });
  // key_verified: true = live-checked OK, false = provider rejected it, null = no check ran.
  return { profile: result.profile, key_verified: result.key_verified ?? null };
}

async function updateModel(data) {
  // data: { llm_model } — BYOK model pick. Backend validates against the
  // per-provider allowlist (the user's active key decides the provider).
  const result = await backendPatch('/profile/model', data);
  await chrome.storage.local.set({ [STORAGE_KEYS.USER_PROFILE]: result.profile });
  return { profile: result.profile };
}

// ---------------------------------------------------------------------
// Generate / Ask handlers
// ---------------------------------------------------------------------

async function generateReply(data) {
  // data: { requestId, conversationText, messages, userNotes, platform, threadId }
  // Adapter: backend /generate speaks a structured contract
  //   (request: requestId + conversation array; response: { reply, confidence,
  //   reasoning, phase, newBalance }). The sidepanel still consumes markdown with
  //   **SUGGESTED REPLY:** / **REASONING:** / **PHASE:** sections plus a credits
  //   object, so both directions are remapped here and ONLY here.

  // Structured messages when the content script provided them; otherwise
  // reconstruct from the flat "YOU:/THEM:" text (manual paste mode).
  const conversation = (data.messages && data.messages.length)
    ? data.messages.map(m => ({ role: m.role, text: m.text, ...(m.sender ? { sender: m.sender } : {}) }))
    : (data.conversationText || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const isYou = /^YOU\s*:/i.test(line);
          return { role: isYou ? 'you' : 'them', text: line.replace(/^(YOU|THEM)\s*:\s*/i, '') };
        })
        .filter(m => m.text);

  // BETA patch point 2/4 — when the local engine is on, draw the draft on the
  // user's own machine (all logic in local-engine.js). Shares `conversation`.
  if (await getEngine() === 'local') return generateReplyLocal(data, conversation);

  const result = await backendPost('/generate', {
    requestId: data.requestId || crypto.randomUUID(),
    platform: data.platform,
    conversation,
    userNotes: data.userNotes || undefined,
    threadId: data.threadId || undefined
  });

  // BETA patch point 3/4 — markdown rebuild extracted to adaptRichReplyToPanel
  // (local-engine.js) so the cloud AND local paths emit identical panel markdown.
  const reply = adaptRichReplyToPanel(result);

  // Entitlement summary + balance → credits object the sidepanel merges/stores.
  let credits = null;
  if (typeof result.newBalance === 'number' || result.entitlement) {
    const existing = (await chrome.storage.local.get(STORAGE_KEYS.USER_CREDITS))[STORAGE_KEYS.USER_CREDITS] || {};
    credits = { ...existing };
    if (typeof result.newBalance === 'number') credits.balance = result.newBalance;
    if (result.entitlement) credits.entitlement = result.entitlement;
    await chrome.storage.local.set({ [STORAGE_KEYS.USER_CREDITS]: credits });
  }
  // Structured extras ride alongside the markdown so the panel can render
  // interactive alternative cards (insert/copy per option).
  return {
    reply,
    credits,
    alternatives: result.alternatives || [],
    stage: result.stage ?? null,
    bridgeScore: result.bridgeScore ?? null
  };
}

async function askAI(data) {
  // data: { question, history }
  // Response: { answer: string, credits: object }
  // Routing: BOO-32 decision pending. Currently hits ASK_AI_ENDPOINT
  // (default /ask on main backend). May switch to direct n8n webhook.
  const result = await backendPost(ASK_AI_ENDPOINT, data);
  if (result.credits) {
    await chrome.storage.local.set({ [STORAGE_KEYS.USER_CREDITS]: result.credits });
  }
  return { answer: result.answer, credits: result.credits };
}

// ---------------------------------------------------------------------
// Auto-insert / auto-send handlers (BOO-36 / BOO-37)
// ---------------------------------------------------------------------
// Light wrappers — heavy lifting (DOM manipulation, framework-state
// dispatch) lives in content.js. Background just routes to the active
// tab's content script. BOO-37 (auto-send) additionally checks
// role+whitelist server-side before forwarding the send signal.

async function insertIntoComposer(data) {
  // data: { text }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return chrome.tabs.sendMessage(tab.id, { action: 'insertIntoComposer', data });
}

// User-triggered deep history read (Read Full Thread button). Replaces the
// old auto-scroll-on-thread-open behavior. Active tab only, by design.
async function loadThreadHistory() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return chrome.tabs.sendMessage(tab.id, { action: 'loadThreadHistory' });
}

async function insertAndSendComposer(data) {
  // BOO-37: server-side gate. Re-fetch /me before forwarding, even though
  // sidepanel only renders the toggle for whitelisted clients. Defense
  // in depth against a tampered UI.
  const me = await backendGet('/me');
  if (me?.profile?.role !== 'client' || !me?.profile?.is_whitelisted) {
    throw new Error('Auto-send is only available to whitelisted REVXL clients.');
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return chrome.tabs.sendMessage(tab.id, { action: 'insertAndSendComposer', data });
}

// ---------------------------------------------------------------------
// Action handler registry
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Billing (launch model: Free / BYOK / Founding + promo codes)
// ---------------------------------------------------------------------

async function billingState() {
  return backendGet('/billing/state');
}

// Start a Stripe Checkout session for a plan and open it in a new tab.
async function billingCheckout(data) {
  const { url } = await backendPost('/billing/checkout', {
    plan: data?.plan,
    interval: data?.interval || 'monthly'
  });
  if (url) await chrome.tabs.create({ url });
  return { ok: !!url, url: url || null };
}

// Start a Stripe Checkout session for a one-time credit pack.
async function billingPackCheckout(data) {
  const { url } = await backendPost('/billing/pack-checkout', { pack: data?.pack });
  if (url) await chrome.tabs.create({ url });
  return { ok: !!url, url: url || null };
}

// Open the Stripe customer portal in a new tab.
async function billingPortal() {
  const { url } = await backendPost('/billing/portal', {});
  if (url) await chrome.tabs.create({ url });
  return { ok: !!url, url: url || null };
}

// Redeem a promo / invite code.
async function redeemCode(data) {
  return backendPost('/billing/redeem', { code: data?.code });
}

// Month-to-date token + cost usage.
async function usageSummary() {
  return backendGet('/usage/summary');
}

const ACTION_HANDLERS = {
  // Auth
  getAuthState,
  signInWithGoogle,
  signOut,
  refreshProfile,
  // Profile / setup
  completeSetup,
  updateProfile,
  updateLLMKey,
  updateModel,
  // AI
  generateReply,
  askAI,
  // BETA patch point 4/4 — Local Claude Engine toggle + self-test (handlers in local-engine.js).
  getEngineState,
  setEngineState,
  selfTestLocalEngine,
  // Billing
  billingState,
  billingCheckout,
  billingPackCheckout,
  billingPortal,
  redeemCode,
  usageSummary,
  // Convo relay
  requestCurrentConvo,
  loadThreadHistory,
  // BOO-36 / BOO-37
  insertIntoComposer,
  insertAndSendComposer
};

// ---------------------------------------------------------------------
// First-install hook (optional, useful for dev)
// ---------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' || reason === 'update') {
    // Set default backend URL if not already set, or migrate stale placeholder URL.
    const { [STORAGE_KEYS.BACKEND_URL]: url } = await chrome.storage.local.get(STORAGE_KEYS.BACKEND_URL);
    if (!url || url.includes('bookingbandit.example')) {
      await chrome.storage.local.set({ [STORAGE_KEYS.BACKEND_URL]: DEFAULT_BACKEND_URL });
    }
  }
});
