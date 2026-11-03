'use strict';

const assert = require('assert').strict;
const ScreenWakeLock = require('../../../js/screenWakeLock');

describe('Installed app detection', function () {
  for (const {name, displayMode, standalone, expected} of [
    {name: 'standalone app', displayMode: 'standalone', expected: true},
    {name: 'iPad home screen app', displayMode: 'fullscreen', standalone: true, expected: true},
    {name: 'regular browser tab', displayMode: 'browser', expected: false},
    {name: 'Safari browser tab', displayMode: 'browser', standalone: false, expected: false},
    {name: 'browser fullscreen', displayMode: 'fullscreen', expected: false},
  ]) {
    it(name, async function () {
      const window = {
        navigator: {standalone},
        matchMedia: (query) => {
          assert.equal(query, '(display-mode: standalone)');
          return {matches: displayMode === 'standalone'};
        },
      };
      assert.equal(ScreenWakeLock.isStandalone(window), expected);
    });
  }
});

describe('Keep screen on', function () {
  let document;
  let navigator;
  let locks;
  let states;
  let controller;
  let visibilityChanged;

  const makeLock = () => {
    const lock = new EventTarget();
    lock.released = false;
    lock.release = async () => {
      lock.released = true;
      lock.dispatchEvent(new Event('release'));
    };
    return lock;
  };

  beforeEach(async function () {
    document = {
      visibilityState: 'visible',
      addEventListener: (name, listener) => {
        assert.equal(name, 'visibilitychange');
        visibilityChanged = listener;
      },
    };
    locks = [];
    states = [];
    navigator = {wakeLock: {request: async (type) => {
      assert.equal(type, 'screen');
      const lock = makeLock();
      locks.push(lock);
      return lock;
    }}};
    controller = new ScreenWakeLock(navigator, document, (state) => states.push(state));
  });

  it('does not keep the screen on until enabled, and releases it when disabled', async function () {
    await controller.setEnabled(false);
    assert.equal(locks.length, 0);
    await controller.setEnabled(true);
    assert.equal(states.at(-1), 'active');
    await controller.setEnabled(false);
    assert.equal(locks[0].released, true);
    assert.equal(states.at(-1), 'off');
  });

  it('resumes when the pad becomes visible again', async function () {
    await controller.setEnabled(true);
    document.visibilityState = 'hidden';
    await visibilityChanged();
    assert.equal(locks[0].released, true);
    document.visibilityState = 'visible';
    await visibilityChanged();
    assert.equal(locks.length, 2);
    assert.equal(states.at(-1), 'active');
  });

  it('does not request a lock while the pad is hidden', async function () {
    document.visibilityState = 'hidden';
    await controller.setEnabled(true);
    assert.equal(locks.length, 0);
    document.visibilityState = 'visible';
    await visibilityChanged();
    assert.equal(states.at(-1), 'active');
  });

  it('honors disabling while a request is pending', async function () {
    let finishRequest;
    navigator.wakeLock.request = () => new Promise((resolve) => { finishRequest = resolve; });
    const enabling = controller.setEnabled(true);
    const disabling = controller.setEnabled(false);
    const lock = makeLock();
    finishRequest(lock);
    await Promise.all([enabling, disabling]);
    assert.equal(lock.released, true);
    assert.equal(states.at(-1), 'off');
  });

  it('does not acquire duplicate locks for concurrent requests', async function () {
    await Promise.all([
      controller.setEnabled(true), controller.setEnabled(true), visibilityChanged(),
    ]);
    assert.equal(locks.length, 1);
  });

  it('reports release by the browser without repeatedly requesting a new lock', async function () {
    await controller.setEnabled(true);
    await locks[0].release();
    assert.equal(states.at(-1), 'released');
    assert.equal(locks.length, 1);
  });

  it('allows retry after a denied request', async function () {
    const request = navigator.wakeLock.request;
    navigator.wakeLock.request = async () => {
      throw new DOMException('Denied', 'NotAllowedError');
    };
    await controller.setEnabled(true);
    assert.equal(states.at(-1), 'denied');
    navigator.wakeLock.request = request;
    await controller.setEnabled(false);
    await controller.setEnabled(true);
    assert.equal(states.at(-1), 'active');
  });

  it('propagates unexpected errors', async function () {
    const error = new Error('Unexpected failure');
    navigator.wakeLock.request = async () => { throw error; };
    await assert.rejects(controller.setEnabled(true), (err) => err === error);
  });

  it('reports unsupported browsers', async function () {
    controller = new ScreenWakeLock({}, document, (state) => states.push(state));
    await controller.setEnabled(true);
    assert.equal(controller.supported, false);
    assert.equal(states.at(-1), 'unsupported');
  });
});
