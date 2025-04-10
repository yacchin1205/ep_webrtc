'use strict';

const Sora = require('sora-js-sdk').default;
const EventTargetPolyfill = require('./eventTargetPolyfill');

// Sora JavaScript SDK を利用した Sora クライアント
class SoraClient extends EventTargetPolyfill {
  constructor(
    signalingUrls,
    channelId,
    options = {}
  ) {
    super();
    this.debug = false;
    this.channelId = channelId;
    this.options = options;

    this.sora = Sora.connection(signalingUrls, this.debug);
    // metadata はここでは undefined にして connect 時に指定する
    this.connection = this.sora.sendrecv(this.channelId, undefined, this.options);
    this.connection.on('track', (event) => {
      this.dispatchEvent(new CustomEvent('track', {detail: event}));
    });
    this.connection.on('removetrack', (event) => {
      this.dispatchEvent(new CustomEvent('removeTrack', {detail: event}));
    });
  }

  async connect(stream) {
    const jwt = await this.createAccessToken();
    if (jwt) {
      this.connection.metadata = {
        access_token: jwt,
      };
    }
    // 接続する
    await this.connection.connect(stream);
  }

  async replaceLocalTrack(newTrack) {
    if (newTrack == null) return;
    let transceiver = null;
    if (newTrack.kind === 'video') {
      transceiver = this.connection.getVideoTransceiver();
    } else if (newTrack.kind === 'audio') {
      transceiver = this.connection.getAudioTransceiver();
    }
    if (transceiver == null) {
      return;
    }
    await transceiver.sender.replaceTrack(newTrack);
  }

  async disconnect() {
    // 切断する
    if (this.connection != null) {
      await this.connection.disconnect();
    }
  }

  async createAccessToken() {
    try {
      const res = await fetch('/ep_webrtc/create-access-token', {channelId: this.channelId});
      if (!res.ok) throw new Error('fetch error', res);
      return await res.text();
    } catch (err) {
      return null;
    }
  }

  get clientId() {
    return this.connection.clientId;
  }
}

module.exports = SoraClient;
