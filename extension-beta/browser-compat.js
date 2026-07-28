// Browser Compatibility Detection Utility

class BrowserCompat {
  constructor() {
    this.browserInfo = this.detectBrowser();
    this.features = this.detectFeatures();
  }

  detectBrowser() {
    const userAgent = navigator.userAgent;
    let browserName = 'Unknown';
    let browserVersion = 0;

    // Detect Chrome
    if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) {
      browserName = 'Chrome';
      const match = userAgent.match(/Chrome\/(\d+)/);
      if (match) browserVersion = parseInt(match[1]);
    }
    // Detect Edge
    else if (userAgent.includes('Edg')) {
      browserName = 'Edge';
      const match = userAgent.match(/Edg\/(\d+)/);
      if (match) browserVersion = parseInt(match[1]);
    }
    // Detect Firefox
    else if (userAgent.includes('Firefox')) {
      browserName = 'Firefox';
      const match = userAgent.match(/Firefox\/(\d+)/);
      if (match) browserVersion = parseInt(match[1]);
    }
    // Detect Safari
    else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
      browserName = 'Safari';
      const match = userAgent.match(/Version\/(\d+)/);
      if (match) browserVersion = parseInt(match[1]);
    }
    // Detect Brave (harder to detect, but try)
    else if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
      browserName = 'Brave';
      const match = userAgent.match(/Chrome\/(\d+)/);
      if (match) browserVersion = parseInt(match[1]);
    }

    return { name: browserName, version: browserVersion };
  }

  detectFeatures() {
    const features = {
      hasSidePanel: false,
      hasManifestV3: false,
      hasModernJS: true,
      hasFlexbox: true,
      minVersionMet: false
    };

    // Check for Side Panel API
    features.hasSidePanel = typeof chrome !== 'undefined' &&
                            chrome.sidePanel !== undefined;

    // Check for Manifest V3 support (service workers)
    features.hasManifestV3 = typeof chrome !== 'undefined' &&
                             chrome.runtime !== undefined &&
                             chrome.runtime.getManifest !== undefined &&
                             chrome.runtime.getManifest().manifest_version === 3;

    // Check minimum browser versions
    const { name, version } = this.browserInfo;
    switch (name) {
      case 'Chrome':
      case 'Brave':
        features.minVersionMet = version >= 114;
        break;
      case 'Edge':
        features.minVersionMet = version >= 114;
        break;
      case 'Firefox':
        // Firefox doesn't support Side Panel API yet
        features.minVersionMet = false;
        break;
      case 'Safari':
        // Safari doesn't support Side Panel API
        features.minVersionMet = false;
        break;
      default:
        features.minVersionMet = false;
    }

    return features;
  }

  isFullyCompatible() {
    return this.features.hasSidePanel &&
           this.features.hasManifestV3 &&
           this.features.minVersionMet;
  }

  getCompatibilityMessage() {
    const { name, version } = this.browserInfo;
    const { hasSidePanel, minVersionMet } = this.features;

    if (this.isFullyCompatible()) {
      return {
        compatible: true,
        message: 'Your browser is fully compatible with REVSetter AI.'
      };
    }

    let message = '';
    let recommendations = [];

    if (!hasSidePanel) {
      if (name === 'Chrome' || name === 'Edge' || name === 'Brave') {
        message = `Your ${name} version (${version}) does not support the Side Panel API.`;
        recommendations.push(`Please update to ${name} version 114 or later.`);
      } else if (name === 'Firefox') {
        message = 'Firefox does not currently support Chrome Side Panel API.';
        recommendations.push('Please use Google Chrome (v114+), Microsoft Edge (v114+), or Brave browser.');
      } else if (name === 'Safari') {
        message = 'Safari does not support Chrome extensions.';
        recommendations.push('Please use Google Chrome (v114+), Microsoft Edge (v114+), or Brave browser.');
      } else {
        message = 'Your browser does not support the required features.';
        recommendations.push('Please use Google Chrome (v114+), Microsoft Edge (v114+), or Brave browser.');
      }
    } else if (!minVersionMet) {
      message = `Your ${name} version (${version}) is outdated.`;
      recommendations.push(`Please update to ${name} version 114 or later.`);
    }

    return {
      compatible: false,
      message: message,
      recommendations: recommendations,
      browserInfo: { name, version }
    };
  }

  logCompatibilityInfo() {
    console.group('REVSetter AI - Browser Compatibility Check');
    console.log('Browser:', this.browserInfo.name);
    console.log('Version:', this.browserInfo.version);
    console.log('Side Panel Support:', this.features.hasSidePanel);
    console.log('Manifest V3 Support:', this.features.hasManifestV3);
    console.log('Minimum Version Met:', this.features.minVersionMet);
    console.log('Fully Compatible:', this.isFullyCompatible());
    console.groupEnd();
  }
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.BrowserCompat = BrowserCompat;
}
