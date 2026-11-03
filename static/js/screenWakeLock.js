'use strict';

module.exports = class ScreenWakeLock {
  static isStandalone(window) {
    return window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true;
  }

  constructor(navigator, document, onStateChange) {
    this._navigator = navigator;
    this._document = document;
    this._onStateChange = onStateChange;
    this._enabled = false;
    this._sentinel = null;
    this._pending = null;
    this.supported = 'wakeLock' in navigator;
    document.addEventListener('visibilitychange', () => this.update());
  }

  async setEnabled(enabled) {
    this._enabled = enabled;
    await this.update();
  }

  async update() {
    while (this._pending) await this._pending;
    this._pending = this._update();
    try {
      await this._pending;
    } finally {
      this._pending = null;
    }
  }

  async _update() {
    if (!this.supported) {
      this._onStateChange('unsupported');
      return;
    }
    if (!this._enabled || this._document.visibilityState !== 'visible') {
      if (this._sentinel) await this._sentinel.release();
      this._onStateChange(this._enabled ? 'released' : 'off');
      return;
    }
    if (this._sentinel && !this._sentinel.released) return;
    let sentinel;
    try {
      sentinel = await this._navigator.wakeLock.request('screen');
    } catch (err) {
      if (err.name !== 'NotAllowedError') throw err;
      this._onStateChange('denied', err);
      return;
    }
    this._sentinel = sentinel;
    sentinel.addEventListener('release', () => {
      if (this._sentinel !== sentinel) return;
      this._sentinel = null;
      this._onStateChange(this._enabled ? 'released' : 'off');
    });
    // The user can turn this off or hide the pad while the request is pending.
    if (!this._enabled || this._document.visibilityState !== 'visible') {
      await sentinel.release();
    } else {
      this._onStateChange(sentinel.released ? 'released' : 'active');
    }
  }
};
