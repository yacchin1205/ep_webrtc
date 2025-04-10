'use strict';

const Sora = require('sora-js-sdk').default;
const EventTargetPolyfill = require('./eventTargetPolyfill');

// Sora JavaScript SDK を利用した Sora クライアント
class SoraClient extends EventTargetPolyfill {
  constructor(
    signalingUrls,
    channelId,
    userDisplayName,
    options = {}
  ) {
    super();
    this.debug = false;
    this.channelId = channelId;
    this.userDisplayName = userDisplayName;
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
    const response = await this.createAccessToken();
    // eslint-disable-next-line camelcase
    const {metadata, signaling_notify_metadata} = response;
    if (metadata) {
      this.connection.metadata = Object.assign({}, metadata);
      if (metadata.channel_id) {
        // Fix channelId for meeting.dev
        this.connection.channelId = metadata.channel_id;
        this.channelId = metadata.channel_id;
      }
    }
    // eslint-disable-next-line camelcase
    if (signaling_notify_metadata) {
      this.connection.options = Object.assign(
          this.connection.options,
          {
            // eslint-disable-next-line camelcase
            signalingNotifyMetadata: signaling_notify_metadata,
          }
      );
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
      const req = {
        channelId: this.channelId,
        userDisplayName: this.userDisplayName,
      };
      const res = await fetch('/ep_webrtc/create-access-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error('fetch error', res);
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  get clientId() {
    return this.connection.clientId;
  }
}

module.exports = SoraClient;
