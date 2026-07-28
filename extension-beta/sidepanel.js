// REVSetter AI Side Panel - Main Application Logic

const DEFAULT_PROFILE = {
  id: null,
  email: '',
  name: '',
  picture: '',
  role: null,             // 'client' | 'subscriber' | 'admin'
  is_whitelisted: false,
  setup_complete: false,
  business_name: '',
  niche: '',
  ideal_client: '',
  tone_preferences: '',
  target_pain_points: '',
  services_offered: '',
  booking_link: '',
  llm_provider: '',       // 'openai' | 'anthropic' | 'openrouter'
  llm_api_key_last4: '',
  llm_model: null,        // BYOK model pick (user_settings.llm_model); null → provider default
  skool_member: false,    // server-injected; default so badge logic never reads undefined
  tier: null,             // Stripe-webhook plan ('byo_key' set at purchase, BEFORE any key exists)
  local_engine_allowed: false  // BETA: gates the Local Claude Engine toggle (/me projection)
};

// BYOK model menu — UI mirror of backend lib/model-menu.ts (the server
// allowlist is authoritative; this only drives the dropdown). Keep in sync.
// ⚠️ Model ids are Joe-supplied config, live-verified at S5 QA.
const MODEL_MENU = {
  openai: [
    { tier: 'smart', modelId: 'gpt-5.4-mini', label: 'Smart · fast & cheap' },
    { tier: 'smarter', modelId: 'gpt-5.4', label: 'Smarter · balanced' },
    { tier: 'smartest', modelId: 'gpt-5.5', label: 'Smartest · highest quality' }
  ],
  anthropic: [
    { tier: 'smart', modelId: 'claude-haiku-4-5-20251001', label: 'Smart · fast & cheap' },
    { tier: 'smarter', modelId: 'claude-sonnet-5', label: 'Smarter · balanced' },
    { tier: 'smartest', modelId: 'claude-opus-4-8', label: 'Smartest · highest quality' }
  ],
  openrouter: [
    { tier: 'smart', modelId: 'z-ai/glm-5.2', label: 'Smart · fast & cheap' }
  ]
};

const DEFAULT_CREDITS = {
  balance: 0,
  weekly_free_allowance: 25,
  monthly_paid_allowance: 0,
  total_used: 0
};

// External links (set 06.12.26). "How to get a key" reuses the tutorials
// playlist until a dedicated video exists.
const SKOOL_COMMUNITY_URL = 'https://www.skool.com/mastering-claude-for-coaches/about';
const YOUTUBE_TUTORIALS_URL = 'https://youtube.com/playlist?list=PLzHRZMxlmC5Lp2W3gi2nVdSFQR6RtdMUq&si=YWssNY-QtuS-fN_Y';
// PLACEHOLDER — written step-by-step "how to get an API key" instructions page.
// Points at the tutorials playlist until a dedicated page exists; swap when ready.
const KEY_INSTRUCTIONS_URL = YOUTUBE_TUTORIALS_URL;
// PLACEHOLDER — BYOK explainer video (what BYOK is / why $14 unlimited).
// Points at the tutorials playlist until the dedicated video exists.
const BYOK_EXPLAINER_URL = YOUTUBE_TUTORIALS_URL;
// Live hosted Booking Bandit legal pages (Lane 3 shipped 07-06).
const PRIVACY_POLICY_URL = 'https://engineforimpact.com/booking-bandit-privacy/';
const TERMS_OF_SERVICE_URL = 'https://engineforimpact.com/booking-bandit-terms/';

class RevsetterApp {
  constructor() {
    // Auth + routing
    this.signedIn = false;
    this.profile = { ...DEFAULT_PROFILE };
    this.credits = { ...DEFAULT_CREDITS };
    this.engine = 'cloud';   // BETA: 'cloud' | 'local' (mirror of chrome.storage.local.local_engine)
    this.view = 'login';     // 'login' | 'setup' | 'app'

    // App tabs
    this.activeTab = 'generate'; // 'generate' | 'ask'

    // Settings drawer
    this.settingsOpen = false;
    this.activeSettingsTab = 'account'; // 'account' | 'profile' | 'key' | 'help'
    this.upgradeHighlight = false;   // 402 paywall just fired — spotlight the plan block
    this._pendingBillingScroll = false; // one-shot scroll to the plan block on paywall
    this._planPollTimer = null;      // post-checkout /me polling handle
    // Side panel can be closed mid-poll; don't leave the interval firing.
    window.addEventListener('unload', () => this.stopPlanPolling());
    this.usage = null;   // { totalTokens, inputTokens, outputTokens, costUsd, replies } month-to-date
    this.usageError = false; // usageSummary fetch failed — show retry instead of eternal "Loading"
    this.voiceTranscribe = true;   // local pref (chrome.storage.local), hydrated in loadState; default ON
    this._consentNudged = false;   // one-time IG transcription-consent nudge per session

    // Generate Reply state
    this.userNotes = '';
    this.isGenerating = false;
    this.replyResult = null;
    this.replyAlternatives = [];

    // Live conversation mirror (pushed by content.js via background)
    this.livePlatform = null;          // 'instagram' | 'facebook' | 'messenger' | null
    this.liveConvo = null;             // { text, messages, threadOpen, error, messageCount, threadId, truncated, originalCount }
    this.fallbackConvoText = '';       // user's manual paste when extraction fails
    this.isLoadingHistory = false;     // true while content.js scrolls to load older messages

    // Ask AI state
    this.askMessages = [];
    this.isAsking = false;

    // Setup wizard state
    this.setupStep = 1;       // 1 = profile, 2 = key (clients only)
    this.setupKeyInput = '';
    this.setupKeyProvider = 'openai';

    // Settings replace-key state
    this.replacingKey = false;
    this.newKeyInput = '';
    this.newKeyProvider = 'openai';

    // UI flags
    this.isSigningIn = false;
    this.isSavingSetup = false;
    this.isSavingSettings = false;
    this.copiedStates = {};
    this.billingInterval = 'monthly';
    this.browserCompat = null;

    this.init();
  }

  async init() {
    if (typeof BrowserCompat !== 'undefined') {
      this.browserCompat = new BrowserCompat();
      this.browserCompat.logCompatibilityInfo();
    }
    await this.loadState();
    this.routeView();
    this.subscribeToConvoUpdates();
    this.requestCurrentConvo();
    this.render();
  }

  subscribeToConvoUpdates() {
    if (!chrome.runtime || !chrome.runtime.onMessage) return;
    chrome.runtime.onMessage.addListener((request) => {
      if (!request) return;
      if (request.action === 'convoUpdate') {
        this.applyConvoUpdate(request.data);
      } else if (request.action === 'convoLoadingState') {
        this.isLoadingHistory = !!request.data?.loading;
        if (this.view === 'app' && this.activeTab === 'generate') this.render();
      } else if (request.action === 'consentNeeded') {
        // IG transcription needs a one-time Meta consent we won't auto-accept.
        if (!this._consentNudged) {
          this._consentNudged = true;
          this.showToast('Turn on voice transcripts', 'In Instagram, click "View transcription" on a voice note once and hit "Continue". After that, transcripts load here automatically.', 'error');
        }
      }
    });
  }

  async requestCurrentConvo() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'requestCurrentConvo' });
      if (res && !res.error) this.applyConvoUpdate(res);
    } catch {}
  }

  applyConvoUpdate(data) {
    if (!data) return;
    this.livePlatform = data.platform || null;
    this.liveConvo = {
      text: data.text || '',
      messages: data.messages || [],
      messageCount: data.messageCount || 0,
      threadOpen: !!data.threadOpen,
      threadId: data.threadId || null,
      truncated: !!data.truncated,
      originalCount: data.originalCount || 0,
      error: data.error || null
    };
    if (this.view === 'app' && this.activeTab === 'generate') this.render();
  }

  async loadState() {
    try {
      const auth = await chrome.runtime.sendMessage({ action: 'getAuthState' });
      if (auth && !auth.error) {
        this.signedIn = auth.signedIn;
        if (auth.profile) this.profile = { ...DEFAULT_PROFILE, ...auth.profile };
        if (auth.credits) this.credits = { ...DEFAULT_CREDITS, ...auth.credits };
      }
    } catch (e) {
      console.error('loadState failed:', e);
    }
    // Voice-note transcribe toggle (local pref; default ON, only OFF if set false).
    try {
      const vt = await chrome.storage.local.get('voiceTranscribe');
      this.voiceTranscribe = (vt && vt.voiceTranscribe) !== false;
    } catch { this.voiceTranscribe = true; }
    // Background-refresh the real profile from /me (fixes stale stub: "?"
    // avatar, missing name/role/balance). Retries with backoff so a slow /me or a
    // just-created account (profiles row not provisioned yet → transient 404) still
    // resolves to the real profile instead of leaving the stub on screen.
    if (this.signedIn) {
      const refreshWithRetry = async (tries = 3, delayMs = 600) => {
        for (let i = 0; i < tries; i++) {
          try {
            const res = await chrome.runtime.sendMessage({ action: 'refreshProfile' });
            if (res && !res.error && res.profile) {
              this.profile = { ...this.profile, ...res.profile };
              if (res.credits) this.credits = { ...DEFAULT_CREDITS, ...res.credits };
              this.routeView();
              this.render();
              return;
            }
          } catch (e) {
            console.warn('refreshProfile attempt failed:', e?.message || e);
          }
          if (i < tries - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
        }
        console.warn('refreshProfile: all attempts failed; keeping cached profile');
      };
      refreshWithRetry();
    }
  }

  routeView() {
    if (!this.signedIn) {
      this.view = 'login';
    } else if (!this.profile.setup_complete) {
      this.view = 'setup';
      this.setupKeyProvider = this.profile.llm_provider || 'openai';
    } else {
      this.view = 'app';
    }
  }

  // ---------- Event wiring ----------

  attachEventListeners() {
    // Login
    const signInBtn = document.getElementById('signInBtn');
    if (signInBtn) signInBtn.addEventListener('click', () => this.handleSignIn());

    // Setup wizard
    const setupForm = document.getElementById('setupForm');
    if (setupForm) setupForm.addEventListener('submit', (e) => this.handleSetupNext(e));

    const setupBackBtn = document.getElementById('setupBackBtn');
    if (setupBackBtn) setupBackBtn.addEventListener('click', () => { this.setupStep = 1; this.render(); });

    const setupKeyForm = document.getElementById('setupKeyForm');
    if (setupKeyForm) setupKeyForm.addEventListener('submit', (e) => this.handleSetupComplete(e));

    const setupKeyInput = document.getElementById('setupKeyInput');
    if (setupKeyInput) setupKeyInput.addEventListener('input', (e) => { this.setupKeyInput = e.target.value; });

    const setupKeyProvider = document.getElementById('setupKeyProvider');
    if (setupKeyProvider) setupKeyProvider.addEventListener('change', (e) => { this.setupKeyProvider = e.target.value; });

    // Setup field inputs (live-bind to profile draft)
    ['business_name', 'niche', 'ideal_client', 'tone_preferences', 'target_pain_points', 'services_offered', 'booking_link'].forEach(field => {
      const inp = document.getElementById(`setup_${field}`);
      if (inp) inp.addEventListener('input', (e) => { this.profile[field] = e.target.value; });

      const sinp = document.getElementById(`settings_${field}`);
      if (sinp) sinp.addEventListener('input', (e) => { this.profile[field] = e.target.value; });
    });

    // App: tabs
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.activeTab = e.currentTarget.getAttribute('data-tab');
        this.render();
      });
    });

    // Settings: tabs
    document.querySelectorAll('.settings-tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.activeSettingsTab = e.currentTarget.getAttribute('data-stab');
        this.render();
      });
    });

    // Generate Reply form
    const generateForm = document.getElementById('generateForm');
    if (generateForm) generateForm.addEventListener('submit', (e) => this.handleGenerateReply(e));

    const readThreadBtn = document.getElementById('readThreadBtn');
    if (readThreadBtn) readThreadBtn.addEventListener('click', () => this.handleReadThread());

    const voiceTranscribeToggle = document.getElementById('voiceTranscribeToggle');
    if (voiceTranscribeToggle) voiceTranscribeToggle.addEventListener('click', () => this.toggleVoiceTranscribe());

    const backToThreadBtn = document.getElementById('backToThreadBtn');
    if (backToThreadBtn) backToThreadBtn.addEventListener('click', () => { this.replyResult = null; this.replyAlternatives = []; this.render(); });

    const userNotes = document.getElementById('userNotes');
    if (userNotes) userNotes.addEventListener('input', (e) => { this.userNotes = e.target.value; });

    const fallbackConvo = document.getElementById('fallbackConvo');
    if (fallbackConvo) fallbackConvo.addEventListener('input', (e) => { this.fallbackConvoText = e.target.value; });

    // Ask AI form
    const askForm = document.getElementById('askForm');
    if (askForm) askForm.addEventListener('submit', (e) => this.handleAskAI(e));

    // Settings drawer
    const gearBtn = document.getElementById('gearBtn');
    if (gearBtn) gearBtn.addEventListener('click', () => { this.settingsOpen = true; this.activeSettingsTab = 'account'; this.loadUsage(); this.loadEngineState(); this.render(); });

    // BETA: Local Claude Engine toggle (Key tab, whitelisted coaches only).
    const engineCloudBtn = document.getElementById('engineCloudBtn');
    if (engineCloudBtn) engineCloudBtn.addEventListener('click', () => this.handleSetEngine('cloud'));
    const engineLocalBtn = document.getElementById('engineLocalBtn');
    if (engineLocalBtn) engineLocalBtn.addEventListener('click', () => this.handleSetEngine('local'));
    // BETA: self-test buttons + error-card diagnostics copy
    const engineTestBtn = document.getElementById('engineTestBtn');
    if (engineTestBtn) engineTestBtn.addEventListener('click', () => this.handleEngineSelfTest(false));
    const engineDeepTestBtn = document.getElementById('engineDeepTestBtn');
    if (engineDeepTestBtn) engineDeepTestBtn.addEventListener('click', () => this.handleEngineSelfTest(true));
    const copyEngineDiagBtn = document.getElementById('copyEngineDiagBtn');
    if (copyEngineDiagBtn) copyEngineDiagBtn.addEventListener('click', () => {
      const diag = { ...this.engineError, os: navigator.platform, extVersion: chrome.runtime.getManifest().version };
      navigator.clipboard.writeText(JSON.stringify(diag, null, 2))
        .then(() => this.showToast('Copied', 'Diagnostics on the clipboard.', 'success'))
        .catch(() => this.showToast('Copy failed', 'Select the technical detail manually.', 'error'));
    });

    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => { this.settingsOpen = false; this.replacingKey = false; this.upgradeHighlight = false; this.render(); });

    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) settingsForm.addEventListener('submit', (e) => this.handleSaveSettings(e));

    const replaceKeyBtn = document.getElementById('replaceKeyBtn');
    if (replaceKeyBtn) replaceKeyBtn.addEventListener('click', () => { this.replacingKey = true; this.newKeyInput = ''; this.newKeyProvider = this.profile.llm_provider || 'openai'; this.render(); });

    const cancelReplaceKeyBtn = document.getElementById('cancelReplaceKeyBtn');
    if (cancelReplaceKeyBtn) cancelReplaceKeyBtn.addEventListener('click', () => { this.replacingKey = false; this.render(); });

    const saveNewKeyBtn = document.getElementById('saveNewKeyBtn');
    if (saveNewKeyBtn) saveNewKeyBtn.addEventListener('click', () => this.handleSaveNewKey());

    const newKeyInput = document.getElementById('newKeyInput');
    if (newKeyInput) newKeyInput.addEventListener('input', (e) => { this.newKeyInput = e.target.value; });

    const newKeyProvider = document.getElementById('newKeyProvider');
    if (newKeyProvider) newKeyProvider.addEventListener('change', (e) => { this.newKeyProvider = e.target.value; });

    // BYOK model picker — saves on change, reverts the UI if the backend rejects.
    const modelSelect = document.getElementById('modelSelect');
    if (modelSelect) modelSelect.addEventListener('change', (e) => this.handleModelChange(e.target.value));

    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) signOutBtn.addEventListener('click', () => this.handleSignOut());

    const upgradeFoundingBtn = document.getElementById('upgradeFoundingBtn');
    if (upgradeFoundingBtn) upgradeFoundingBtn.addEventListener('click', () => this.handleCheckout('founding'));

    const upgradeByokBtn = document.getElementById('upgradeByokBtn');
    if (upgradeByokBtn) upgradeByokBtn.addEventListener('click', () => this.handleCheckout('byok'));

    const intervalMonthlyBtn = document.getElementById('intervalMonthlyBtn');
    if (intervalMonthlyBtn) intervalMonthlyBtn.addEventListener('click', () => { this.billingInterval = 'monthly'; this.render(); });
    const intervalAnnualBtn = document.getElementById('intervalAnnualBtn');
    if (intervalAnnualBtn) intervalAnnualBtn.addEventListener('click', () => { this.billingInterval = 'annual'; this.render(); });
    const packTasterBtn = document.getElementById('packTasterBtn');
    if (packTasterBtn) packTasterBtn.addEventListener('click', () => this.handlePackCheckout('taster'));
    const pack200Btn = document.getElementById('pack200Btn');
    if (pack200Btn) pack200Btn.addEventListener('click', () => this.handlePackCheckout(pack200Btn.dataset.pack));

    const managePlanBtn = document.getElementById('managePlanBtn');
    if (managePlanBtn) managePlanBtn.addEventListener('click', () => this.handleManagePlan());

    // BYOK paid-but-no-key card → deep-link straight into the key entry form
    const byokAddKeyCta = document.getElementById('byokAddKeyCta');
    if (byokAddKeyCta) byokAddKeyCta.addEventListener('click', () => {
      this.activeSettingsTab = 'key';
      this.replacingKey = true;
      this.newKeyInput = '';
      this.newKeyProvider = this.profile.llm_provider || 'openai';
      this.render();
    });

    // Locked KEY tab → purchase CTA. Founding subscribers switch plans in the
    // Stripe portal (prorated, avoids a second subscription); everyone else
    // gets a fresh BYOK checkout.
    const unlockByokBtn = document.getElementById('unlockByokBtn');
    if (unlockByokBtn) unlockByokBtn.addEventListener('click', () => {
      if (this.profile.tier === 'founding') this.handleManagePlan();
      else this.handleCheckout('byok');
    });

    const refreshPlanBtn = document.getElementById('refreshPlanBtn');
    if (refreshPlanBtn) refreshPlanBtn.addEventListener('click', () => this.handleRefreshPlan());

    const retryUsageBtn = document.getElementById('retryUsageBtn');
    if (retryUsageBtn) retryUsageBtn.addEventListener('click', () => { this.usage = null; this.usageError = false; this.render(); this.loadUsage(); });

    // Paywall flow: settings just opened on a 402 — bring the plan block into
    // view once (rAF so layout has settled; one-shot so poll re-renders don't
    // yank the user back after they scroll away).
    if (this._pendingBillingScroll && this.settingsOpen) {
      this._pendingBillingScroll = false;
      requestAnimationFrame(() => {
        const billingBlock = document.getElementById('billingBlock');
        if (billingBlock) billingBlock.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    // Copy buttons (data-copy required: Read Thread / Back buttons share the
    // class for styling but must not trigger the copy handler)
    document.querySelectorAll('.btn-copy[data-copy]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const button = e.currentTarget;
        this.copyToClipboard(button.getAttribute('data-copy'), button.getAttribute('data-title'));
      });
    });

    // Insert-into-DM buttons (BOO-36) — hooked by data-text, styled as primary
    document.querySelectorAll('button[data-text]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.insertSuggestedReply(e.currentTarget.getAttribute('data-text'));
      });
    });

    // Auto-refresh convo when sidepanel becomes visible (Joe's 2026-05-26 ask).
    // Wired once at app init; re-attaching is harmless since we use a named handler.
    if (!this._visibilityWired) {
      this._visibilityWired = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) this.requestCurrentConvo();
      });
      window.addEventListener('focus', () => this.requestCurrentConvo());
    }
  }

  // ---------- Auth handlers ----------

  async handleSignIn() {
    this.isSigningIn = true;
    this.render();
    try {
      const res = await chrome.runtime.sendMessage({ action: 'signInWithGoogle' });
      if (res.error) {
        this.showToast('Sign-in Failed', res.error, 'error');
      } else {
        this.signedIn = true;
        this.profile = { ...DEFAULT_PROFILE, ...res.profile };
        this.credits = { ...DEFAULT_CREDITS, ...(res.credits || {}) };
        this.routeView();
        const greeting = this.profile.role === 'client' ? 'Welcome, REVXL Client.' : `Welcome, ${this.profile.name || this.profile.email}.`;
        this.showToast('Signed In', greeting, 'success');
      }
    } catch (e) {
      this.showToast('Sign-in Failed', e.message, 'error');
    } finally {
      this.isSigningIn = false;
      this.render();
    }
  }

  async handleSignOut() {
    try {
      await chrome.runtime.sendMessage({ action: 'signOut' });
      this.signedIn = false;
      this.profile = { ...DEFAULT_PROFILE };
      this.credits = { ...DEFAULT_CREDITS };
      this.settingsOpen = false;
      this.view = 'login';
      this.showToast('Signed Out', 'You have been signed out.', 'success');
      this.render();
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    }
  }

  // ---------- Setup wizard ----------

  handleSetupNext(e) {
    e.preventDefault();
    if (!this.profile.niche || !this.profile.ideal_client || !this.profile.booking_link) {
      this.showToast('Missing Fields', 'Niche, ideal client, and booking link are required.', 'error');
      return;
    }
    if (!/^https?:\/\//i.test(this.profile.booking_link)) {
      this.showToast('Invalid Link', 'Booking link must start with http:// or https://', 'error');
      return;
    }
    if (this.profile.role === 'client') {
      this.setupStep = 2;
      this.render();
    } else {
      // Subscribers skip the key step
      this.completeSetup();
    }
  }

  handleSetupComplete(e) {
    e.preventDefault();
    if (!this.setupKeyInput || this.setupKeyInput.length < 8) {
      this.showToast('Invalid Key', 'Please paste a valid API key.', 'error');
      return;
    }
    this.completeSetup({
      llm_provider: this.setupKeyProvider,
      llm_api_key: this.setupKeyInput
    });
  }

  async completeSetup(extra = {}) {
    this.isSavingSetup = true;
    this.render();
    try {
      const res = await chrome.runtime.sendMessage({
        action: 'completeSetup',
        data: {
          business_name: this.profile.business_name,
          niche: this.profile.niche,
          ideal_client: this.profile.ideal_client,
          tone_preferences: this.profile.tone_preferences,
          target_pain_points: this.profile.target_pain_points,
          services_offered: this.profile.services_offered,
          booking_link: this.profile.booking_link,
          ...extra
        }
      });
      if (res.error) {
        this.showToast('Setup Failed', res.error, 'error');
      } else {
        this.profile = { ...DEFAULT_PROFILE, ...res.profile };
        this.view = 'app';
        this.activeTab = 'generate';
        if (res.key_verified === false) {
          this.showToast('Setup done, but check your key', 'The provider rejected your API key on a live check. Replace it in Settings or replies will fail.', 'error');
        } else {
          this.showToast('All Set', 'Setup complete. You\'re in.', 'success');
        }
      }
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    } finally {
      this.isSavingSetup = false;
      this.render();
    }
  }

  // ---------- Settings handlers ----------

  async handleSaveSettings(e) {
    e.preventDefault();
    this.isSavingSettings = true;
    this.render();
    try {
      if (!this.profile.booking_link || !/^https?:\/\//i.test(this.profile.booking_link)) {
        this.showToast('Invalid Booking Link', 'Booking link is required and must start with http(s)://', 'error');
        this.isSavingSettings = false;
        this.render();
        return;
      }
      const res = await chrome.runtime.sendMessage({
        action: 'updateProfile',
        data: {
          business_name: this.profile.business_name,
          niche: this.profile.niche,
          ideal_client: this.profile.ideal_client,
          tone_preferences: this.profile.tone_preferences,
          target_pain_points: this.profile.target_pain_points,
          services_offered: this.profile.services_offered,
          booking_link: this.profile.booking_link
        }
      });
      if (res.error) {
        this.showToast('Save Failed', res.error, 'error');
      } else {
        this.profile = { ...DEFAULT_PROFILE, ...res.profile };
        this.showToast('Settings Saved', 'Your profile is up to date.', 'success');
      }
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    } finally {
      this.isSavingSettings = false;
      this.render();
    }
  }

  async handleSaveNewKey() {
    if (!this.newKeyInput || this.newKeyInput.length < 8) {
      this.showToast('Invalid Key', 'Please paste a valid API key.', 'error');
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({
        action: 'updateLLMKey',
        data: { llm_provider: this.newKeyProvider, llm_api_key: this.newKeyInput }
      });
      if (res.error) {
        this.showToast('Update Failed', res.error, 'error');
      } else {
        this.profile = { ...DEFAULT_PROFILE, ...res.profile };
        this.replacingKey = false;
        if (res.key_verified === false) {
          this.showToast('Key saved, but...', 'The provider rejected this key on a live check. Double-check it or replies will fail.', 'error');
        } else {
          this.showToast('Key Updated', 'Your API key has been replaced and verified.', 'success');
        }
      }
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    } finally {
      this.render();
    }
  }

  // ---------- Billing handlers ----------

  async handleCheckout(plan) {
    try {
      const res = await chrome.runtime.sendMessage({
        action: 'billingCheckout',
        data: { plan, interval: this.billingInterval || 'monthly' }
      });
      if (res?.error) {
        this.showToast('Checkout unavailable', res.error, 'error');
      } else if (res?.url) {
        this.showToast('Opening checkout', 'Finish in the new tab, then come back.', 'default');
        this.startPlanPolling();
      }
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    }
  }

  async handlePackCheckout(pack) {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'billingPackCheckout', data: { pack } });
      if (res?.error) {
        this.showToast('Purchase unavailable', res.error, 'error');
      } else if (res?.url) {
        this.showToast('Opening checkout', 'Finish in the new tab, then come back.', 'default');
        this.startPlanPolling();
      }
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    }
  }

  // After checkout opens, poll /me every 5s (max ~2 min) so the webhook's tier
  // flip shows up without the user reopening the panel. Stops early on a plan
  // change or when a manual refresh happens.
  startPlanPolling() {
    this.stopPlanPolling();
    const startPlan = this.entitlement().plan;
    let ticks = 0;
    this._planPollTimer = setInterval(async () => {
      ticks += 1;
      if (ticks > 24) { this.stopPlanPolling(); return; }
      try {
        const res = await chrome.runtime.sendMessage({ action: 'refreshProfile' });
        if (res && !res.error) {
          if (res.profile) this.profile = { ...this.profile, ...res.profile };
          if (res.credits) this.credits = { ...DEFAULT_CREDITS, ...res.credits };
          const nowPlan = this.entitlement().plan;
          // Only repaint when the plan actually flips — NOT every tick. A per-tick
          // full re-render flashes the panel every 5s and clears any input the user
          // is typing (e.g. the key-entry field). Poll silently until the flip lands.
          if (nowPlan !== startPlan) {
            this.stopPlanPolling();
            this.upgradeHighlight = false;
            this.showToast('Plan updated', `You're on ${this.entitlement().label} now.`, 'success');
            this.render();
          }
        }
      } catch { /* keep polling */ }
    }, 5000);
  }

  stopPlanPolling() {
    if (this._planPollTimer) { clearInterval(this._planPollTimer); this._planPollTimer = null; }
  }

  async handleRefreshPlan() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'refreshProfile' });
      if (res && !res.error) {
        if (res.profile) this.profile = { ...this.profile, ...res.profile };
        if (res.credits) this.credits = { ...DEFAULT_CREDITS, ...res.credits };
        this.showToast('Plan refreshed', `You're on ${this.entitlement().label}.`, 'success');
      } else {
        this.showToast('Refresh failed', res?.error || 'Try again in a moment.', 'error');
      }
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    } finally {
      this.render();
    }
  }

  async handleManagePlan() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'billingPortal' });
      if (res?.error) this.showToast('Unavailable', res.error, 'error');
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    }
  }

  // Promo redemption happens at Stripe checkout (native code field); client
  // access is granted via backend whitelist. The old in-panel redeem handler
  // was never wired to UI and was removed — background `redeemCode` + the
  // backend /billing/redeem route stay intact for a future invite-code flow.

  async handleModelChange(modelId) {
    const previous = this.profile.llm_model;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'updateModel', data: { llm_model: modelId } });
      if (res?.error) {
        this.showToast('Model not saved', res.error, 'error');
        this.render(); // revert the select to the stored value
        return;
      }
      if (res?.profile) this.profile = { ...this.profile, ...res.profile };
      this.showToast('Model updated', 'New replies will use this model.', 'success');
    } catch (e) {
      this.profile.llm_model = previous;
      this.showToast('Error', e.message, 'error');
      this.render();
    }
  }

  async loadUsage() {
    this.usageError = false;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'usageSummary' });
      if (res && !res.error) { this.usage = res; }
      else { this.usageError = true; }
    } catch { this.usageError = true; }
    this.render();
  }

  // ---------- App handlers ----------

  async handleGenerateReply(e) {
    e.preventDefault();
    this.replyResult = null;
    this.replyAlternatives = [];

    const conversationText = (this.liveConvo && this.liveConvo.text) || this.fallbackConvoText || '';
    if (!conversationText.trim()) {
      this.showToast('No Conversation', 'Open a thread on Instagram or Messenger, or paste manually.', 'error');
      return;
    }
    // No client-side quota gate: the backend entitlement engine decides
    // (free-weekly / sub / byok / balance) and returns 402 when truly out.
    this.isGenerating = true;
    this.engineError = null;   // BETA: clear any prior local-engine error card
    this.render();
    this.startDecryptFx();
    try {
      const res = await chrome.runtime.sendMessage({
        action: 'generateReply',
        data: {
          requestId: crypto.randomUUID(),
          conversationText,
          messages: this.liveConvo?.messages || null,
          userNotes: this.userNotes,
          platform: this.livePlatform || 'manual',
          threadId: this.liveConvo?.threadId || null
        }
      });
      if (res.error) {
        if (res.paywall || res.error === 'insufficient_credits') {
          // Structured 402: paywallInfo carries weeklyUsed/weeklyAllowance or
          // monthlyUsed/monthlyCap so the toast can say exactly what ran out.
          const info = res.paywallInfo || {};
          const detail = info.monthlyCap
            ? `You've used all ${info.monthlyCap} replies in your plan this month. Add your own key for unlimited.`
            : info.weeklyAllowance
              ? `You've used all ${info.weeklyAllowance} free replies this week. Upgrade, or add your own key for unlimited.`
              : 'You\'ve used your replies for now. Upgrade, or add your own key for unlimited.';
          this.settingsOpen = true;
          this.activeSettingsTab = 'account';
          this.upgradeHighlight = true;
          this._pendingBillingScroll = true;
          this.showToast('Out of replies', detail, 'error');
        } else if (res.engineError) {
          // BETA: local-engine failure → persistent error card in the output area
          // (friendly line + collapsible technical detail + copyable diagnostics),
          // instead of a transient toast that vanishes before anyone can read it.
          this.engineError = {
            code: res.engineError,
            message: res.error,
            detail: res.engineDetail || '',
            ts: new Date().toISOString()
          };
          this.showToast('Local engine error', 'Details below.', 'error');
        } else {
          this.showToast('Error', res.error, 'error');
        }
      } else {
        this.replyResult = res.reply;
        this.replyAlternatives = res.alternatives || [];
        if (res.credits) this.credits = { ...DEFAULT_CREDITS, ...res.credits };
        this.showToast('Reply Generated', '', 'success');
      }
    } catch (e) {
      this.showToast('Error', e.message, 'error');
    } finally {
      this.isGenerating = false;
      this.stopDecryptFx();
      this.render();
    }
  }

  async handleReadThread() {
    // User-triggered deep history read (replaces the old auto-scroll).
    try {
      const res = await chrome.runtime.sendMessage({ action: 'loadThreadHistory' });
      if (res?.started) {
        this.isLoadingHistory = true;
        this.render();
      } else {
        this.showToast('No Thread', 'Open a DM thread first.', 'error');
      }
    } catch (e) {
      this.showToast('Error', e.message || 'Could not reach the page.', 'error');
    }
  }

  async handleAskAI(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const question = fd.get('question');
    if (!question || !question.toString().trim()) return;
    e.target.reset();
    this.askMessages.push({ role: 'user', content: question });
    this.isAsking = true;
    this.render();
    this.scrollAskBottom();
    try {
      const res = await chrome.runtime.sendMessage({
        action: 'askAI',
        data: { question, history: this.askMessages }
      });
      if (res.error) {
        if (res.paywall || res.error === 'insufficient_credits') {
          // Same paywall flow as Generate: open settings on the plan block.
          const info = res.paywallInfo || {};
          const detail = info.monthlyCap
            ? `You've used all ${info.monthlyCap} replies in your plan this month. Add your own key for unlimited.`
            : info.weeklyAllowance
              ? `You've used all ${info.weeklyAllowance} free replies this week. Upgrade, or add your own key for unlimited.`
              : 'You\'ve used your replies for now. Upgrade, or add your own key for unlimited.';
          this.settingsOpen = true;
          this.activeSettingsTab = 'account';
          this.upgradeHighlight = true;
          this._pendingBillingScroll = true;
          this.showToast('Out of replies', detail, 'error');
        } else {
          this.showToast('Error', res.error, 'error');
        }
        this.askMessages.pop();
      } else {
        this.askMessages.push({ role: 'ai', content: res.answer });
        if (res.credits) this.credits = { ...DEFAULT_CREDITS, ...res.credits };
      }
    } catch (e) {
      this.showToast('Error', e.message, 'error');
      this.askMessages.pop();
    } finally {
      this.isAsking = false;
      this.render();
      this.scrollAskBottom();
    }
  }

  // ---------- Helpers ----------

  copyToClipboard(text, title) {
    navigator.clipboard.writeText(text).then(() => {
      this.showToast('Copied', `"${title}" copied.`, 'success');
      this.copiedStates[title] = true;
      this.render();
      setTimeout(() => { this.copiedStates[title] = false; this.render(); }, 1800);
    });
  }

  async insertSuggestedReply(text) {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'insertIntoComposer', data: { text } });
      if (res && res.ok) {
        this.showToast('Inserted', 'Reply inserted into the DM. Review and send.', 'success');
      } else {
        const reason = (res && res.reason) || 'unknown';
        const msg = reason === 'composer_not_found' ? 'Open the DM thread first, then try again.'
                  : reason === 'no_active_tab' ? 'No active DM tab.'
                  : reason === 'empty_text' ? 'Nothing to insert.'
                  : 'Insert failed. Try Copy instead.';
        this.showToast('Could not insert', msg, 'error');
      }
    } catch (err) {
      this.showToast('Could not insert', err.message, 'error');
    }
  }

  async toggleVoiceTranscribe() {
    this.voiceTranscribe = !this.voiceTranscribe;
    try { await chrome.storage.local.set({ voiceTranscribe: this.voiceTranscribe }); } catch {}
    if (this.voiceTranscribe) this._consentNudged = false; // allow the consent nudge again after re-enabling
    this.render();
    this.showToast(
      `Voice transcribe ${this.voiceTranscribe ? 'ON' : 'OFF'}`,
      this.voiceTranscribe
        ? 'Instagram voice notes will auto-transcribe when you read a thread.'
        : 'Voice notes stay as audio (no transcript).',
      'default'
    );
  }

  showToast(title, description, variant = 'default') {
    const c = document.getElementById('toastContainer');
    if (!c) return;
    const t = document.createElement('div');
    t.className = `toast toast-${variant}`;
    // Errors stick around long enough to read — users miss 3s flashes (BOO-26-era feedback).
    const duration = variant === 'error' ? 10000 : 3000;
    t.innerHTML = `<div class="toast-title">${this.escapeHtml(title)}</div>${description ? `<div class="toast-description">${this.escapeHtml(description)}</div>` : ''}`;
    if (variant === 'error') {
      const close = document.createElement('button');
      close.className = 'toast-close';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.addEventListener('click', () => { t.classList.remove('toast-show'); setTimeout(() => t.remove(), 300); });
      t.appendChild(close);
    }
    c.appendChild(t);
    setTimeout(() => t.classList.add('toast-show'), 10);
    setTimeout(() => { t.classList.remove('toast-show'); setTimeout(() => t.remove(), 300); }, duration);
  }

  scrollAskBottom() {
    setTimeout(() => {
      const el = document.getElementById('askMessages');
      if (el) el.scrollTop = el.scrollHeight;
    }, 100);
  }

  escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text == null ? '' : String(text);
    return d.innerHTML;
  }

  // ---------- Decrypt loading FX (Booking Bandit "cracking the thread") ----------
  // Sapphire glyph rain + self-decoding status kicker + live timer, contained in
  // the loading card. Survives re-render()s by re-querying elements each tick.
  // Honors prefers-reduced-motion (rain off; stages + timer still update).

  startDecryptFx() {
    this.stopDecryptFx();
    const CHARS = '0123456789$#%&@ABCDEF';
    const STAGES = ['READING THREAD', 'CRACKING PATTERNS', 'DRAFTING REPLY'];
    const t0 = performance.now();
    this._fx = { raf: null, timer: null, stager: null, subs: [] };
    let drops = null;
    let stage = 0;

    const scrambleTo = (target) => {
      let frame = 0;
      const total = 16;
      const id = setInterval(() => {
        const el = document.getElementById('bbStatusKicker');
        frame++;
        if (!el || frame >= total) {
          if (el) el.textContent = target;
          clearInterval(id);
          return;
        }
        const prog = frame / total;
        el.textContent = target.split('').map((c, i) =>
          c === ' ' ? ' ' : (i / target.length < prog ? c : CHARS[Math.floor(Math.random() * CHARS.length)])
        ).join('');
      }, 40);
      this._fx.subs.push(id);
    };

    this._fx.timer = setInterval(() => {
      const el = document.getElementById('bbTimer');
      if (el) el.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
    }, 100);

    scrambleTo(STAGES[0]);
    this._fx.stager = setInterval(() => {
      stage++;
      if (stage < STAGES.length) scrambleTo(STAGES[stage]);
      if (stage >= STAGES.length - 1) clearInterval(this._fx.stager);
    }, 2600);

    const draw = () => {
      if (!this._fx) return;
      const canvas = document.getElementById('bbDecryptCanvas');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        const colW = 11;
        if (!drops) drops = Array.from({ length: Math.floor(canvas.width / colW) }, () => Math.random() * -20);
        ctx.fillStyle = 'rgba(13, 15, 19, 0.22)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = "11px 'JetBrains Mono', monospace";
        for (let i = 0; i < drops.length; i++) {
          const gold = Math.random() < 0.035;
          ctx.fillStyle = gold ? 'rgba(217, 166, 72, 0.9)' : `rgba(125, 159, 240, ${0.25 + Math.random() * 0.5})`;
          ctx.fillText(CHARS[Math.floor(Math.random() * CHARS.length)], i * colW, drops[i] * 11);
          if (drops[i] * 11 > canvas.height && Math.random() > 0.975) drops[i] = 0;
          drops[i] += 0.55;
        }
      }
      this._fx.raf = requestAnimationFrame(draw);
    };
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this._fx.raf = requestAnimationFrame(draw);
    }
  }

  stopDecryptFx() {
    if (!this._fx) return;
    if (this._fx.raf) cancelAnimationFrame(this._fx.raf);
    clearInterval(this._fx.timer);
    clearInterval(this._fx.stager);
    (this._fx.subs || []).forEach(clearInterval);
    this._fx = null;
  }

  parseSuggestedMessage(text) {
    if (!text) return null;
    const patterns = [
      /\*\*SUGGESTED NEXT MESSAGE:\*\*\s*([\s\S]*?)(?=\n\*\*[\w\s]+:\*\*|$)/i,
      /\*\*SUGGESTED MESSAGE:\*\*\s*([\s\S]*?)(?=\n\*\*[\w\s]+:\*\*|$)/i,
      /\*\*SUGGESTED REPLY:\*\*\s*([\s\S]*?)(?=\n\*\*[\w\s]+:\*\*|$)/i
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m && m[1]) {
        return { title: 'Suggested Reply', content: m[1].trim().replace(/^"|"$/g, '').replace(/\*/g, '') };
      }
    }
    return null;
  }

  parseMarkdownBold(text) {
    return this.escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  // ---------- Render: top-level ----------

  render() {
    const root = document.getElementById('root');
    let body = '';
    if (this.view === 'login') body = this.renderLogin();
    else if (this.view === 'setup') body = this.renderSetup();
    else body = this.renderApp();

    root.innerHTML = `${body}${this.settingsOpen ? this.renderSettingsDrawer() : ''}<div id="toastContainer" class="toast-container"></div>`;
    this.attachEventListeners();
    this.maybeScrollConvoToBottom();
  }

  // BOO-40: keep the latest message in view as new ones stream in. Only scrolls
  // when the message count grows — preserves a user who has scrolled up to read.
  maybeScrollConvoToBottom() {
    const preview = document.querySelector('.convo-preview');
    if (!preview) return;
    const currentCount = (this.liveConvo && this.liveConvo.messageCount) || 0;
    const lastCount = this._lastConvoCount || 0;
    if (currentCount > lastCount) {
      preview.scrollTop = preview.scrollHeight;
    }
    this._lastConvoCount = currentCount;
  }

  // ---------- Render: Login ----------

  renderLogin() {
    return `
      <div class="screen screen-center">
        <div class="login-card">
          <div class="logo-container">
            <img class="logo-icon-large" src="icons/icon128.png" alt="" style="border-radius: 12px;" />
            <h1 class="app-title-large">
              <span class="text-white">BOOKING</span> <span class="wordmark-accent">BANDIT</span>
            </h1>
          </div>
          <p class="login-tagline">DM coach + reply generator for coaches.</p>
          <button id="signInBtn" class="btn btn-google btn-block" ${this.isSigningIn ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            ${this.isSigningIn ? 'Signing in...' : 'Sign in / Sign up with Google'}
          </button>
          <p class="login-footer">
            REVXL Clients are pre-whitelisted.<br>
            New users get <strong>25 free replies per week</strong>.
          </p>
        </div>
      </div>
    `;
  }

  // ---------- Render: Setup wizard ----------

  renderSetup() {
    if (this.setupStep === 2 && this.profile.role === 'client') {
      return this.renderSetupKey();
    }
    return this.renderSetupProfile();
  }

  renderSetupProfile() {
    return `
      <div class="screen screen-scroll">
        <div class="setup-card">
          <div class="setup-progress">
            <div class="setup-step active">1. Profile</div>
            ${this.profile.role === 'client' ? '<div class="setup-step">2. API Key</div>' : ''}
          </div>
          <h2 class="setup-title">Welcome${this.profile.name ? ', ' + this.escapeHtml(this.profile.name.split(' ')[0]) : ''}.</h2>
          <p class="setup-subtitle">Tell Booking Bandit about your business so it can write in your voice.</p>

          <form id="setupForm">
            <div class="settings-field">
              <label for="setup_business_name">Business Name <span class="optional">(optional)</span></label>
              <input type="text" id="setup_business_name" class="input" placeholder="e.g. Acme Coaching" value="${this.escapeHtml(this.profile.business_name)}" />
            </div>

            <div class="settings-field">
              <label for="setup_niche">Niche <span class="required">*</span></label>
              <input type="text" id="setup_niche" class="input" placeholder="e.g. Health and wellness coaches" value="${this.escapeHtml(this.profile.niche)}" required />
            </div>

            <div class="settings-field">
              <label for="setup_ideal_client">Ideal Client <span class="required">*</span></label>
              <textarea id="setup_ideal_client" class="textarea textarea-sm" placeholder="Who's the perfect-fit client? Demographics, pain, situation..." required>${this.escapeHtml(this.profile.ideal_client)}</textarea>
            </div>

            <div class="settings-field">
              <label for="setup_target_pain_points">Target Pain Points <span class="optional">(optional)</span></label>
              <textarea id="setup_target_pain_points" class="textarea textarea-sm" placeholder="The pain you solve">${this.escapeHtml(this.profile.target_pain_points)}</textarea>
            </div>

            <div class="settings-field">
              <label for="setup_services_offered">Services Offered <span class="optional">(optional)</span></label>
              <textarea id="setup_services_offered" class="textarea textarea-sm" placeholder="Programs, packages, deliverables">${this.escapeHtml(this.profile.services_offered)}</textarea>
            </div>

            <div class="settings-field">
              <label for="setup_tone_preferences">Tone Preferences <span class="optional">(optional)</span></label>
              <input type="text" id="setup_tone_preferences" class="input" placeholder="e.g. Casual, peer-to-peer, no jargon" value="${this.escapeHtml(this.profile.tone_preferences)}" />
            </div>

            <div class="settings-field">
              <label for="setup_booking_link">Booking Link <span class="required">*</span></label>
              <input type="url" id="setup_booking_link" class="input" placeholder="https://booking.yourdomain.com" value="${this.escapeHtml(this.profile.booking_link)}" required />
              <small class="settings-hint">Where prospects book a call. The AI will share this when it's time.</small>
            </div>

            <button type="submit" class="btn btn-primary btn-block" ${this.isSavingSetup ? 'disabled' : ''}>
              ${this.profile.role === 'client' ? 'Next: Add API Key' : (this.isSavingSetup ? 'Saving...' : 'Finish Setup')}
            </button>
          </form>
        </div>
      </div>
    `;
  }

  renderSetupKey() {
    return `
      <div class="screen screen-scroll">
        <div class="setup-card">
          <div class="setup-progress">
            <div class="setup-step done">1. Profile</div>
            <div class="setup-step active">2. API Key</div>
          </div>
          <h2 class="setup-title">Add your AI provider key</h2>
          <p class="setup-subtitle">As a REVXL Client, you bring your own key. We store it encrypted in Supabase. You won't see it again — only the last 4 characters.</p>

          <form id="setupKeyForm">
            <div class="settings-field">
              <label for="setupKeyProvider">Provider</label>
              <select id="setupKeyProvider" class="input">
                <option value="openai" ${this.setupKeyProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
                <option value="anthropic" ${this.setupKeyProvider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option>
                <option value="openrouter" ${this.setupKeyProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
              </select>
            </div>

            <div class="settings-field">
              <label for="setupKeyInput">API Key</label>
              <input type="password" id="setupKeyInput" class="input" placeholder="sk-..." autocomplete="off" spellcheck="false" required />
              <small class="settings-hint">Stored encrypted. Never sent back to the extension after saving.</small>
            </div>

            <div class="setup-actions">
              <button type="button" id="setupBackBtn" class="btn btn-secondary">Back</button>
              <button type="submit" class="btn btn-primary" ${this.isSavingSetup ? 'disabled' : ''}>${this.isSavingSetup ? 'Saving...' : 'Finish Setup'}</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // ---------- Render: App ----------

  renderApp() {
    return `
      <div class="app-container">
        ${this.renderAppHeader()}
        <div class="sidebar-content">
          <div class="tab-content ${this.activeTab === 'generate' ? 'tab-content-active' : ''}">
            ${this.renderGenerateTab()}
          </div>
          <div class="tab-content ${this.activeTab === 'ask' ? 'tab-content-active' : ''}">
            ${this.renderAskTab()}
          </div>
        </div>
      </div>
    `;
  }

  renderAppHeader() {
    return `
      <div class="sidebar-header">
        <div class="header-row">
          <div class="logo-container">
            <img class="logo-icon" src="icons/icon48.png" alt="" style="border-radius: 6px;" />
            <h1 class="app-title">
              <span class="text-white">BOOKING</span> <span class="wordmark-accent">BANDIT</span>
            </h1>
          </div>
          ${this.renderPlatformIcons()}
          <button id="gearBtn" class="btn-icon" title="Settings">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
        ${this.renderStatusBadge()}
        <div class="tab-navigation">
          <button class="tab-button ${this.activeTab === 'generate' ? 'tab-active' : ''}" data-tab="generate">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            Generate Reply
          </button>
          <button class="tab-button ${this.activeTab === 'ask' ? 'tab-active' : ''}" data-tab="ask">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            Ask AI
          </button>
        </div>
      </div>
    `;
  }

  renderPlatformIcons() {
    const igActive = this.livePlatform === 'instagram';
    const fbActive = this.livePlatform === 'facebook' || this.livePlatform === 'messenger';
    return `
      <div class="platform-icons" title="Detected platform">
        <span class="platform-icon ${igActive ? 'platform-active platform-instagram' : 'platform-inactive'}" title="Instagram${igActive ? ' (active)' : ''}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23a3.7 3.7 0 0 1-.9 1.38 3.7 3.7 0 0 1-1.38.9c-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.85 5.85 0 0 0-2.13 1.38A5.85 5.85 0 0 0 .63 4.14C.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91.31.79.73 1.46 1.38 2.13a5.85 5.85 0 0 0 2.13 1.38c.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.85 5.85 0 0 0 2.13-1.38 5.85 5.85 0 0 0 1.38-2.13c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.85 5.85 0 0 0-1.38-2.13A5.85 5.85 0 0 0 19.86.63C19.1.33 18.22.13 16.95.07 15.67.01 15.26 0 12 0z"/>
            <path d="M12 5.84A6.16 6.16 0 0 0 5.84 12 6.16 6.16 0 0 0 12 18.16 6.16 6.16 0 0 0 18.16 12 6.16 6.16 0 0 0 12 5.84zm0 10.16A4 4 0 1 1 12 8a4 4 0 0 1 0 8z"/>
            <circle cx="18.41" cy="5.59" r="1.44"/>
          </svg>
        </span>
        <span class="platform-icon ${fbActive ? 'platform-active platform-facebook' : 'platform-inactive'}" title="Facebook / Messenger${fbActive ? ' (active)' : ''}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.69.24 2.69.24v2.97h-1.52c-1.5 0-1.96.93-1.96 1.89v2.26h3.34l-.53 3.49h-2.81V24C19.61 23.1 24 18.1 24 12.07z"/>
          </svg>
        </span>
      </div>
    `;
  }

  renderStatusBadge() {
    if (this.profile.role === 'client') {
      return `<div class="status-badge status-client">
        <svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
        REVXL CLIENT
      </div>`;
    }
    // Admin / whitelisted accounts have no meter to show — badge says so
    // instead of rendering nothing (previously fell through to '').
    if (this.profile.role === 'admin' || this.profile.is_whitelisted) {
      return `<div class="status-badge status-client">Unlimited</div>`;
    }
    if (this.profile.role === 'subscriber') {
      const ent = this.entitlement();
      const isPaid = ['founding', 'byok', 'unlimited'].includes(ent.plan);
      const left = (ent.repliesLeft === null || ent.repliesLeft === undefined)
        ? '' : ` · ${ent.repliesLeft} left`;
      // Paid BYOK with no usable key — surface it, never quietly show "Free".
      if (this.isByokNoKey()) {
        return `<div class="status-badge status-skool">BYOK · add key</div>`;
      }
      // Skool members get a boosted free tier — badge should say so, not "Free".
      if (!isPaid && this.profile.skool_member) {
        return `<div class="status-badge status-skool">Skool${left}</div>`;
      }
      return `<div class="status-badge ${isPaid ? 'status-pro' : 'status-free'}">
        ${this.escapeHtml(ent.label)}${left}
      </div>`;
    }
    return '';
  }

  renderGenerateTab() {
    const suggested = this.parseSuggestedMessage(this.replyResult);
    const isCopied = this.copiedStates['Suggested Reply'];
    const offPlatform = !this.livePlatform;
    const onPlatformNoThread = this.livePlatform && this.liveConvo && !this.liveConvo.threadOpen;
    const extractionFailed = this.livePlatform && this.liveConvo && this.liveConvo.threadOpen && this.liveConvo.error;
    const hasConvo = this.liveConvo && this.liveConvo.text && !this.liveConvo.error;

    return `
      <div class="analysis-section ${offPlatform ? 'analysis-section-disabled' : ''}">
        ${offPlatform ? `
          <div class="off-platform-overlay">
            <div class="off-platform-card">
              <div class="off-platform-title">No Meta Platform Detected</div>
              <div class="off-platform-subtitle">Open Instagram or Facebook Messenger to start.</div>
            </div>
          </div>
        ` : ''}

        <div class="card">
          <div class="card-header">
            <div class="card-title">User Notes <span class="optional">(optional)</span></div>
            <p class="card-description">Anything the AI should know? Profile signals, prior context, vibe.</p>
          </div>
          <div class="card-content">
            <textarea id="userNotes" class="textarea textarea-sm" placeholder="e.g. Their profile shows they like dogs and run a Pilates studio." ${this.isGenerating ? 'disabled' : ''}>${this.escapeHtml(this.userNotes)}</textarea>
          </div>
        </div>

        ${(this.isGenerating || this.replyResult) ? '' : `
        <div class="card">
          <div class="card-header">
            <div class="card-title">
              Conversation Preview
              ${this.isLoadingHistory
                ? '<span class="loading-pill">Reading thread...</span>'
                : (this.livePlatform && this.liveConvo?.threadOpen
                  ? '<button type="button" id="readThreadBtn" class="btn-copy" title="Scroll back through this thread and load the full history">Read Full Thread</button>'
                  : '')}
            </div>
            <button type="button" id="voiceTranscribeToggle" class="vt-toggle ${this.voiceTranscribe ? 'vt-on' : ''}" title="Auto-reveal Instagram voice-note transcripts so the AI can read them">Voice note transcribe: <span class="vt-state">${this.voiceTranscribe ? 'ON' : 'OFF'}</span></button>
            ${hasConvo ? `<p class="card-description">${this.liveConvo.messageCount} message${this.liveConvo.messageCount === 1 ? '' : 's'} from ${this.escapeHtml(this.platformLabel(this.livePlatform))}${this.liveConvo.truncated ? ` <span class="truncate-note">(last ${this.liveConvo.messageCount} of ${this.liveConvo.originalCount})</span>` : ''}</p>` : ''}
          </div>
          <div class="card-content">
            ${onPlatformNoThread ? `
              <div class="convo-empty">Select a conversation in your inbox.</div>
            ` : extractionFailed ? `
              <div class="convo-error">
                <div class="convo-error-title">Couldn't read this thread</div>
                <div class="convo-error-msg">Paste the conversation manually below as a fallback.</div>
                <textarea id="fallbackConvo" class="textarea" placeholder="Paste conversation here..." ${this.isGenerating ? 'disabled' : ''}>${this.escapeHtml(this.fallbackConvoText)}</textarea>
              </div>
            ` : hasConvo ? `
              <div class="convo-preview">
                ${this.liveConvo.messages.map(m => `
                  <div class="convo-line convo-line-${m.role}">
                    <span class="convo-role">${m.role === 'you' ? 'YOU' : 'THEM'}</span>
                    <span class="convo-text">${this.escapeHtml(m.text)}</span>
                  </div>
                `).join('')}
              </div>
            ` : `
              <div class="convo-empty">Waiting for conversation...</div>
            `}
          </div>
        </div>
        `}

        <form id="generateForm">
          <button type="submit" class="btn btn-primary btn-block" ${this.isGenerating || (offPlatform || (onPlatformNoThread && !this.fallbackConvoText)) ? 'disabled' : ''}>
            ${this.isGenerating ? 'Generating...' : 'Generate Reply'}
          </button>
        </form>

        ${this.isGenerating ? `
          <div class="card bb-decrypt-active">
            <div class="card-content" style="position: relative; overflow: hidden; min-height: 340px;">
              <canvas class="bb-decrypt-canvas" id="bbDecryptCanvas" width="280" height="360"></canvas>
              <div style="position: relative; display: flex; justify-content: space-between; align-items: center;">
                <span class="bb-status-kicker" id="bbStatusKicker">READING THREAD</span>
                <span class="bb-timer" id="bbTimer">0.0s</span>
              </div>
            </div>
          </div>` : ''}

        ${this.engineError ? `
          <div class="card" style="border-color: var(--destructive, #b91c1c);">
            <div class="card-header"><div class="card-title">Local engine failed</div></div>
            <div class="card-content">
              <p class="analysis-text">${this.escapeHtml(this.engineError.message)}</p>
              ${this.engineError.detail ? `
                <details style="margin-top: 8px;">
                  <summary style="cursor: pointer; font-size: 12px; opacity: .8;">Technical detail</summary>
                  <p class="analysis-text" style="font-family: monospace; font-size: 11px; word-break: break-all;">${this.escapeHtml(this.engineError.detail)}</p>
                </details>` : ''}
              <button type="button" id="copyEngineDiagBtn" class="btn-copy" style="margin-top: 10px;">Copy diagnostics</button>
            </div>
          </div>
        ` : ''}

        ${this.replyResult ? `
          <div class="analysis-results-container">
            <button type="button" id="backToThreadBtn" class="btn-copy" style="align-self: flex-start;">&larr; Back to Thread</button>
            ${suggested ? `
              <div class="card">
                <div class="card-header"><div class="card-title">Suggested Reply</div></div>
                <div class="card-content">
                  <div class="suggestion-section">
                    <div class="suggestion-header">
                      <h4 class="suggestion-title">Insert into the DM</h4>
                      <div class="suggestion-actions">
                        <button class="btn btn-primary btn-sm" data-text="${this.escapeHtml(suggested.content)}">
                          Insert
                        </button>
                        <button class="btn-copy" data-copy="${this.escapeHtml(suggested.content)}" data-title="Suggested Reply">
                          ${isCopied ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                    <p class="suggestion-content">${this.escapeHtml(suggested.content)}</p>
                  </div>
                </div>
              </div>` : ''}
            ${(this.replyAlternatives || []).length ? `
              <div class="card">
                <div class="card-header">
                  <div class="card-title">Alternative Angles</div>
                  <p class="card-description">Different plays for the same moment. Insert whichever fits.</p>
                </div>
                <div class="card-content">
                  ${this.replyAlternatives.map((alt, i) => alt && alt.text ? `
                    <div class="suggestion-section" ${i > 0 ? 'style="margin-top: 12px;"' : ''}>
                      <div class="suggestion-header">
                        <h4 class="suggestion-title">${this.escapeHtml((alt.angle || `Option ${i + 1}`).toUpperCase())}${typeof alt.bridge_score === 'number' ? ` · ${alt.bridge_score}/27` : ''}</h4>
                        <div class="suggestion-actions">
                          <button class="btn btn-primary btn-sm" data-text="${this.escapeHtml(alt.text)}">Insert</button>
                          <button class="btn-copy" data-copy="${this.escapeHtml(alt.text)}" data-title="Alternative ${i + 1}">
                            ${this.copiedStates[`Alternative ${i + 1}`] ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                      </div>
                      <p class="suggestion-content">${this.escapeHtml(alt.text)}</p>
                    </div>
                  ` : '').join('')}
                </div>
              </div>` : ''}
            <div class="card">
              <div class="card-header"><div class="card-title">Full Analysis</div></div>
              <div class="card-content"><p class="analysis-text">${this.parseMarkdownBold(this.replyResult)}</p></div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  platformLabel(p) {
    if (p === 'instagram') return 'Instagram';
    if (p === 'messenger') return 'Messenger';
    if (p === 'facebook') return 'Facebook';
    return '';
  }

  renderAskTab() {
    return `
      <div class="chat-section">
        <div class="card card-chat">
          <div class="card-header">
            <div class="card-title">Ask AI</div>
            <p class="card-description">Quick questions, definitions, lookups. Doesn't use your DM framework.</p>
            <p class="settings-hint" style="margin:2px 0 0;">Uses 1 credit per prompt.</p>
          </div>
          <div class="card-content">
            <div class="chat-messages" id="askMessages">
              ${this.askMessages.length === 0 ? '<div class="chat-empty"><p>Ask me anything...</p></div>' : this.askMessages.map(m => `
                <div class="message message-${m.role}">
                  <div class="message-content message-content-${m.role}">${this.escapeHtml(m.content)}</div>
                </div>
              `).join('')}
              ${this.isAsking ? '<div class="message message-ai"><div class="message-content message-content-ai"><span>Thinking...</span></div></div>' : ''}
            </div>
          </div>
          <div class="card-footer">
            <form id="askForm">
              <input type="text" name="question" class="input" placeholder="Ask anything..." autocomplete="off" ${this.isAsking ? 'disabled' : ''} />
              <button type="submit" class="btn btn-secondary" ${this.isAsking ? 'disabled' : ''}>Ask</button>
            </form>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- Render: Settings drawer ----------

  renderSettingsDrawer() {
    const tab = this.activeSettingsTab || 'account';
    const tabBtn = (id, label) =>
      `<button class="settings-tab ${tab === id ? 'settings-tab-active' : ''}" data-stab="${id}">${label}</button>`;

    let content = '';
    if (tab === 'account') {
      content = `${this.renderSettingsAccount()}${this.renderSettingsBilling()}${this.renderSettingsUsage()}`;
    } else if (tab === 'profile') {
      content = this.renderSettingsProfile();
    } else if (tab === 'key') {
      // BETA: Local Claude Engine toggle sits above the Key content, shown only to
      // whitelisted beta coaches (server-authoritative local_engine_allowed flag).
      content = `${this.profile.local_engine_allowed ? this.renderEngineToggle() : ''}${this.renderSettingsKey()}`;
    } else if (tab === 'help') {
      content = this.renderSettingsHelp();
    }

    return `
      <div class="drawer-overlay" id="drawerOverlay">
        <div class="drawer">
          <div class="drawer-header">
            <h2>Settings</h2>
            <button id="closeSettingsBtn" class="btn-icon" title="Close">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="settings-tabs">
            ${tabBtn('account', 'Account')}
            ${tabBtn('profile', 'Profile')}
            ${tabBtn('key', 'Key')}
            ${tabBtn('help', 'Help')}
          </div>
          <div class="drawer-body">
            ${content}
          </div>
        </div>
      </div>
    `;
  }

  renderSettingsAccount() {
    const initial = (this.profile.email || '?')[0].toUpperCase();
    return `
      <div class="settings-block">
        <div class="user-pill">
          ${this.profile.picture
            ? `<img class="user-avatar" src="${this.escapeHtml(this.profile.picture)}" alt="" />`
            : `<div class="user-avatar user-avatar-fallback">${initial}</div>`}
          <div class="user-meta">
            <div class="user-name">${this.escapeHtml(this.profile.name || this.profile.email)}</div>
            <div class="user-email">${this.escapeHtml(this.profile.email)}</div>
          </div>
        </div>
        <button id="signOutBtn" class="btn btn-danger btn-sm">Sign out</button>
      </div>
    `;
  }

  entitlement() {
    return this.credits.entitlement || { plan: 'free', label: 'Free', repliesLeft: this.credits.balance ?? 0 };
  }

  // Paid for BYOK but no key saved yet. Detect via profiles.tier (set by the
  // Stripe webhook at purchase) — the entitlement engine reports this user as
  // plan 'free' (they fall back to the weekly quota until a key exists), so
  // entitlement().plan can never see this state.
  isByokNoKey() {
    return this.profile.tier === 'byo_key' && !this.profile.llm_api_key_last4;
  }

  planMetaLine(ent) {
    if (this.isByokNoKey()) return 'BYOK &middot; add your key to activate';
    if (ent.plan === 'unlimited') return 'Unlimited access';
    if (ent.plan === 'byok') return 'Unlimited on your own API key';
    if (ent.plan === 'founding') return 'Founding member ... rate locked for life';
    if (ent.plan === 'credits') return 'Credit balance';
    return this.profile.skool_member
      ? 'Free + Skool boost ... 50 replies/week'
      : 'Free ... 15 replies/week';
  }

  renderSettingsBilling() {
    const ent = this.entitlement();
    const plan = ent.plan;
    const left = ent.repliesLeft;
    const unlimited = left === null || left === undefined;
    const isPaid = ['founding', 'byok', 'unlimited'].includes(plan);
    const isAdmin = this.profile.role === 'admin' || this.profile.is_whitelisted;
    const byokNoKey = this.isByokNoKey();
    const highlight = this.upgradeHighlight ? ' billing-highlight' : '';
    const annual = this.billingInterval === 'annual';
    const foundingPrice = annual
      ? '$270/yr &middot; 500 replies/mo &middot; rate locked for life'
      : '$27/mo &middot; 500 replies/mo &middot; rate locked for life';
    const byokPrice = annual
      ? '$140/yr &middot; unlimited replies on your key'
      : '$14/mo &middot; unlimited replies on your key';
    // Active subscribers get the discounted 200-pack ($13 vs $17).
    const pack200Id = isPaid ? 'sub_refill' : 'refill';
    const pack200Label = isPaid ? '$13 &middot; member price' : '$17';

    // Middle section is chosen per plan state — one green conversion CTA max.
    let planActions;
    if (isAdmin) {
      // Whitelisted/admin accounts have nothing to buy or manage.
      planActions = '';
    } else if (byokNoKey) {
      // Paid BYOK, no key yet: the ONLY job is getting a key in. No upsells.
      planActions = `
        <button id="byokAddKeyCta" class="byok-cta-card">
          <span style="font-family:'Barlow Condensed',sans-serif; font-size:14px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:var(--success);">Add your key now</span>
          <span class="settings-hint" style="margin:0; text-align:center;">Your BYOK plan is active. Connect your provider key to unlock unlimited replies.</span>
        </button>
        <button id="managePlanBtn" class="btn btn-secondary btn-block" style="margin-top:8px;">Manage billing</button>`;
    } else if (isPaid) {
      planActions = `<button id="managePlanBtn" class="btn btn-secondary btn-block">Manage billing</button>`;
    } else if (plan === 'credits') {
      // Pack buyer: balance speaks for itself; top-ups live in the packs block below.
      planActions = '';
    } else {
      // Free (incl. Skool boost): full upgrade stack.
      planActions = `
        <div class="interval-toggle">
          <button id="intervalMonthlyBtn" class="btn btn-sm ${annual ? 'btn-secondary' : 'btn-primary'}">Monthly</button>
          <button id="intervalAnnualBtn" class="btn btn-sm ${annual ? 'btn-primary' : 'btn-secondary'}">Annual <span style="font-size:10px; opacity:0.85;">&middot; save 2 mo</span></button>
        </div>
        <button id="upgradeFoundingBtn" class="btn btn-confirm btn-block">
          Become a Founding Member
          <span style="display:block; font-weight:400; font-size:11px; opacity:0.92;">${foundingPrice}</span>
        </button>
        <button id="upgradeByokBtn" class="btn btn-secondary btn-block" style="margin-top:8px;">
          Use your own AI key
          <span style="display:block; font-weight:400; font-size:11px; opacity:0.75;">${byokPrice}</span>
        </button>
        <p class="settings-note">Have a code? Enter it at checkout.</p>
        <a href="${SKOOL_COMMUNITY_URL}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm btn-block">Get a promo code &rarr;</a>`;
    }

    const packsBlock = isAdmin ? '' : `
      <div class="settings-block">
        <h3 class="settings-block-title">Need more replies?</h3>
        <p class="settings-hint">One-time credit packs. They kick in when your plan's replies run out.</p>
        <button id="packTasterBtn" class="btn btn-secondary btn-block">50 replies <span style="opacity:0.7;">&middot; $5</span></button>
        <button id="pack200Btn" data-pack="${pack200Id}" class="btn btn-secondary btn-block" style="margin-top:8px;">200 replies <span style="opacity:0.7;">&middot; ${pack200Label}</span></button>
      </div>`;

    return `
      <div class="settings-block${highlight}" id="billingBlock">
        <h3 class="settings-block-title">Your plan</h3>
        <p class="settings-hint">How many replies you can generate.</p>
        <div class="credit-display">
          <div class="credit-balance">${unlimited ? '&infin;' : left}</div>
          <div class="credit-label">${unlimited ? this.escapeHtml(ent.label) : 'replies left'}</div>
        </div>
        <div class="credit-meta">${this.planMetaLine(ent)}</div>
        ${planActions}
        <button id="refreshPlanBtn" class="btn btn-secondary btn-sm btn-block" style="margin-top:8px;">Refresh plan</button>
      </div>
      ${packsBlock}
    `;
  }

  renderSettingsHelp() {
    return `
      <div class="settings-block">
        <h3 class="settings-block-title">Help &amp; tutorials</h3>
        <p class="settings-hint">New here? Watch the quick walkthroughs.</p>
        <a href="${YOUTUBE_TUTORIALS_URL}" target="_blank" rel="noopener" class="btn btn-secondary btn-block">Watch tutorials &rarr;</a>
      </div>
      <div class="settings-block">
        <a href="${SKOOL_COMMUNITY_URL}" target="_blank" rel="noopener" style="display:block; line-height:0;">
          <img src="icons/community-join-banner.png" alt="Join Mastering Claude for Coaches &amp; Online Businesses on Skool" style="width:100%; height:auto; display:block;" />
        </a>
        <p class="settings-note" style="margin:10px 0 0;">Skool members get 50 free replies/week in Booking Bandit.</p>
      </div>
      <div class="settings-block">
        <h3 class="settings-block-title">Legal</h3>
        <div class="legal-links">
          <a href="${PRIVACY_POLICY_URL}" target="_blank" rel="noopener" class="key-link">Privacy Policy &rarr;</a>
          <a href="${TERMS_OF_SERVICE_URL}" target="_blank" rel="noopener" class="key-link">Terms of Service &rarr;</a>
        </div>
      </div>
    `;
  }

  formatNum(n) { return (n ?? 0).toLocaleString(); }

  renderSettingsUsage() {
    const u = this.usage;
    let body;
    if (u) {
      body = `
          <div class="usage-grid">
            <div class="usage-cell"><div class="usage-figure">${this.formatNum(u.totalTokens)}</div><div class="usage-cap">tokens</div></div>
            <div class="usage-cell"><div class="usage-figure">${u.replies ?? 0}</div><div class="usage-cap">replies</div></div>
            <div class="usage-cell"><div class="usage-figure">$${(u.costUsd ?? 0).toFixed(2)}</div><div class="usage-cap">est. cost</div></div>
          </div>
          <div class="credit-meta">${this.formatNum(u.inputTokens)} in / ${this.formatNum(u.outputTokens)} out</div>`;
    } else if (this.usageError) {
      body = `<p class="settings-hint" style="margin:0;">Couldn't load usage. <button id="retryUsageBtn" class="btn btn-secondary btn-sm" style="margin-left:6px;">Retry</button></p>`;
    } else {
      body = `<p class="settings-hint" style="margin:0;">Loading usage...</p>`;
    }
    return `
      <div class="settings-block">
        <h3 class="settings-block-title">Usage <span class="optional">(this month)</span></h3>
        ${body}
      </div>
    `;
  }

  renderSettingsKey() {
    // BYOK is a paid plan — everyone else sees the locked pitch, not a dead form.
    // Gate on profiles.tier, NOT entitlement().plan: a paid-BYOK-no-key user
    // resolves to plan 'free' server-side and must still reach the key form.
    if (this.profile.tier !== 'byo_key') {
      // Founding subscribers switch plans in the Stripe portal (prorated);
      // free/credits users get a fresh checkout. Admin/whitelisted have no
      // Stripe customer — portal would error — so they get checkout too.
      const hasSub = this.profile.tier === 'founding';
      return `
        <div class="settings-block">
          <h3 class="settings-block-title">Bring your own AI key</h3>
          <p class="settings-hint">Connect your own OpenAI or Anthropic API key and generate <strong>unlimited</strong> replies for $14/mo. You pay your AI provider directly for usage (typically pennies per reply) ... we never mark it up.</p>
          <button id="unlockByokBtn" class="btn btn-confirm btn-block">
            ${hasSub ? 'Switch to BYOK' : 'Unlock BYOK'}
            <span style="display:block; font-weight:400; font-size:11px; opacity:0.92;">$14/mo &middot; unlimited replies on your key${hasSub ? ' &middot; prorated switch' : ''}</span>
          </button>
          <div class="key-links">
            <a href="${BYOK_EXPLAINER_URL}" target="_blank" rel="noopener" class="key-link">What is BYOK? Watch the explainer &rarr;</a>
            <a href="${YOUTUBE_TUTORIALS_URL}" target="_blank" rel="noopener" class="key-link">How to get a key &rarr;</a>
          </div>
        </div>
      `;
    }
    if (this.replacingKey) {
      return `
        <div class="settings-block">
          <h3 class="settings-block-title">Replace API Key</h3>
          <div class="settings-field">
            <label for="newKeyProvider">Provider</label>
            <select id="newKeyProvider" class="input">
              <option value="openai" ${this.newKeyProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
              <option value="anthropic" ${this.newKeyProvider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option>
              <option value="openrouter" ${this.newKeyProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
            </select>
          </div>
          <div class="settings-field">
            <label for="newKeyInput">New API Key</label>
            <input type="password" id="newKeyInput" class="input" placeholder="sk-..." autocomplete="off" spellcheck="false" value="${this.escapeHtml(this.newKeyInput || '')}" />
            <a href="${YOUTUBE_TUTORIALS_URL}" target="_blank" rel="noopener" style="display:inline-block; margin-top:6px; font-size:12px; opacity:0.85;">How to get a key &rarr;</a>
          </div>
          <div class="setup-actions">
            <button id="cancelReplaceKeyBtn" class="btn btn-secondary btn-sm">Cancel</button>
            <button id="saveNewKeyBtn" class="btn btn-primary btn-sm">Save Key</button>
          </div>
        </div>
      `;
    }
    const hasKey = !!this.profile.llm_api_key_last4;
    return `
      <div class="settings-block">
        <h3 class="settings-block-title">Use your own AI key <span class="optional">(optional)</span></h3>
        <p class="settings-hint">Connect your own provider key for unlimited replies on the $14/mo plan.</p>
        <div class="key-display">
          <div class="key-row">
            <span class="key-label">Provider</span>
            <span class="key-value">${this.escapeHtml(this.profile.llm_provider || '—')}</span>
          </div>
          <div class="key-row">
            <span class="key-label">Key</span>
            <span class="key-value key-masked">${hasKey ? `••••••••••••${this.escapeHtml(this.profile.llm_api_key_last4)}` : '—'}</span>
          </div>
        </div>
        <button id="replaceKeyBtn" class="btn ${hasKey ? 'btn-secondary' : 'btn-confirm'} btn-sm">${hasKey ? 'Replace Key' : 'Add Your Key'}</button>
        <div class="key-links">
          <a href="${KEY_INSTRUCTIONS_URL}" target="_blank" rel="noopener" class="key-link">Setup instructions &rarr;</a>
          <a href="${YOUTUBE_TUTORIALS_URL}" target="_blank" rel="noopener" class="key-link">How to get a key &rarr;</a>
        </div>
      </div>
      ${hasKey ? this.renderModelPicker() : ''}
    `;
  }

  // BYOK model picker — only rendered once a key is saved. Provider-filtered:
  // the user picks from THEIR provider's menu; usage bills to their own account.
  renderModelPicker() {
    const menu = MODEL_MENU[this.profile.llm_provider] || [];
    if (!menu.length) return '';
    const current = this.profile.llm_model;
    return `
      <div class="settings-block">
        <h3 class="settings-block-title">Model</h3>
        <p class="settings-hint">Which of your provider's AI models to use. Smarter models cost more per reply ... billed by <strong>your</strong> AI provider, not us. Engine For Impact is not responsible for your provider charges.</p>
        <select id="modelSelect" class="input">
          ${menu.map(m => `<option value="${m.modelId}" ${current === m.modelId ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>
        <div class="key-links">
          <a href="${YOUTUBE_TUTORIALS_URL}" target="_blank" rel="noopener" class="key-link">How to track your provider usage &rarr;</a>
        </div>
      </div>
    `;
  }

  // BETA — Local Claude Engine toggle (Key tab). Only rendered when the server
  // says local_engine_allowed. Two-button segmented control; the panel's
  // this.engine mirrors chrome.storage.local via get/setEngineState.
  renderEngineToggle() {
    const isLocal = this.engine === 'local';
    const t = this.engineTest;
    const testCard = t ? (t.running ? `
          <p class="settings-hint" style="margin-top:8px;">Testing the local helper${t.deep ? ' (deep — runs a tiny real draft, ~10-20s)' : ''}&hellip;</p>` : `
          <div style="margin-top:8px; padding:8px 10px; border-radius:6px; border:1px solid ${t.ok ? 'var(--confirm, #15803d)' : 'var(--destructive, #b91c1c)'};">
            <p class="settings-hint" style="margin:0; font-weight:600;">${t.ok ? '&#9679; Local engine OK' : '&#9679; Local engine NOT working'} <span style="opacity:.7; font-weight:400;">(${t.ms}ms)</span></p>
            ${t.ok ? `
              <p class="settings-hint" style="margin:4px 0 0; font-size:11px;">helper ${this.escapeHtml(String(t.helperVersion || '?'))} &middot; claude: ${this.escapeHtml(String(t.claudePath || '?'))} (${this.escapeHtml(String(t.resolvedFrom || ''))})${t.deep ? ` &middot; deep draft: ${t.deep.class === 'ok' ? 'OK' : this.escapeHtml(String(t.deep.class))}` : ''}</p>` : `
              <p class="settings-hint" style="margin:4px 0 0;">${this.escapeHtml(String(t.friendly || 'Unknown failure.'))}</p>
              ${t.detail ? `<p class="settings-hint" style="margin:4px 0 0; font-family:monospace; font-size:10px; word-break:break-all;">${this.escapeHtml(String(t.detail))}</p>` : ''}`}
          </div>`) : '';
    return `
      <div class="settings-block">
        <h3 class="settings-block-title">Draft engine <span class="optional">(beta)</span></h3>
        <p class="settings-hint">Cloud drafts on our servers (instant). Local drafts on <strong>your</strong> machine via Claude Code on your Max plan ... higher quality, ~30s, zero cost. Local needs the one-time helper installer (<code>install-windows.ps1</code>).</p>
        <div class="engine-toggle" style="display:flex; gap:8px;">
          <button id="engineCloudBtn" class="btn ${isLocal ? 'btn-secondary' : 'btn-primary'} btn-sm" style="flex:1;">Cloud</button>
          <button id="engineLocalBtn" class="btn ${isLocal ? 'btn-primary' : 'btn-secondary'} btn-sm" style="flex:1;">Local (Claude)</button>
        </div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button id="engineTestBtn" class="btn btn-secondary btn-sm" style="flex:1;" ${t && t.running ? 'disabled' : ''}>Test local engine</button>
          <button id="engineDeepTestBtn" class="btn btn-secondary btn-sm" style="flex:1;" ${t && t.running ? 'disabled' : ''}>Deep test (real draft)</button>
        </div>
        ${testCard}
      </div>
    `;
  }

  // BETA: exercise the real connectNative chain (ping; deep = tiny real claude run).
  async handleEngineSelfTest(deep) {
    this.engineTest = { running: true, deep };
    this.render();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ action: 'selfTestLocalEngine', data: { deep } });
    } catch (e) {
      res = { ok: false, ms: 0, friendly: e.message || 'Could not reach the background worker.' };
    }
    this.engineTest = { ...(res || { ok: false, ms: 0, friendly: 'No response.' }), deep };
    this.render();
  }

  async loadEngineState() {
    if (!this.profile.local_engine_allowed) return;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getEngineState' });
      if (res && res.engine && res.engine !== this.engine) { this.engine = res.engine; this.render(); }
    } catch { /* leave the default 'cloud' */ }
  }

  async handleSetEngine(engine) {
    if (this.engine === engine) return;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'setEngineState', data: { engine } });
      this.engine = (res && res.engine) || engine;
      this.render();
      if (this.engine === 'local') {
        this.showToast('Local engine on', 'Drafts now run on your machine via Claude Code (your Max plan). First run needs the one-time helper installer. Use "Test local engine" below to confirm it\'s ready. ~30s per draft.', 'success');
      } else {
        this.showToast('Cloud engine on', 'Drafts now run on our servers.', 'success');
      }
    } catch (e) {
      this.showToast('Could not switch engine', e.message || 'Try again.', 'error');
    }
  }

  renderSettingsProfile() {
    return `
      <div class="settings-block">
        <h3 class="settings-block-title">Business Profile</h3>
        <form id="settingsForm">
          <div class="settings-field">
            <label for="settings_business_name">Business Name</label>
            <input type="text" id="settings_business_name" class="input" value="${this.escapeHtml(this.profile.business_name)}" />
          </div>
          <div class="settings-field">
            <label for="settings_niche">Niche</label>
            <input type="text" id="settings_niche" class="input" value="${this.escapeHtml(this.profile.niche)}" />
          </div>
          <div class="settings-field">
            <label for="settings_ideal_client">Ideal Client</label>
            <textarea id="settings_ideal_client" class="textarea textarea-sm">${this.escapeHtml(this.profile.ideal_client)}</textarea>
          </div>
          <div class="settings-field">
            <label for="settings_target_pain_points">Target Pain Points</label>
            <textarea id="settings_target_pain_points" class="textarea textarea-sm">${this.escapeHtml(this.profile.target_pain_points)}</textarea>
          </div>
          <div class="settings-field">
            <label for="settings_services_offered">Services Offered</label>
            <textarea id="settings_services_offered" class="textarea textarea-sm">${this.escapeHtml(this.profile.services_offered)}</textarea>
          </div>
          <div class="settings-field">
            <label for="settings_tone_preferences">Tone Preferences</label>
            <input type="text" id="settings_tone_preferences" class="input" value="${this.escapeHtml(this.profile.tone_preferences)}" />
          </div>
          <div class="settings-field">
            <label for="settings_booking_link">Booking Link <span class="required">*</span></label>
            <input type="url" id="settings_booking_link" class="input" placeholder="https://booking.yourdomain.com" value="${this.escapeHtml(this.profile.booking_link)}" required />
            <small class="settings-hint">Required. The AI shares this when it's time to book.</small>
          </div>
          <button type="submit" class="btn btn-primary btn-block" ${this.isSavingSettings ? 'disabled' : ''}>
            ${this.isSavingSettings ? 'Saving...' : 'Save Profile'}
          </button>
        </form>
      </div>
    `;
  }
}

document.addEventListener('DOMContentLoaded', () => { new RevsetterApp(); });
