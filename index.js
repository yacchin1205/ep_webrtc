'use strict';
/**
 * Copyright 2013 j <j@mailb.org>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const _ = require('lodash');
const eejs = require('ep_etherpad-lite/node/eejs/');
const sessioninfos = require('ep_etherpad-lite/node/handler/PadMessageHandler').sessioninfos;
const stats = require('ep_etherpad-lite/node/stats');
const util = require('util');
const {SignJWT} = require('jose');

let logger = {};
for (const level of ['debug', 'info', 'warn', 'error']) {
  logger[level] = console[level].bind(console, 'ep_webrtc:');
}

const defaultSettings = {
  // The defaults here are overridden by the values in the `ep_webrtc` object from `settings.json`.
  enabled: true,
  audio: {
    constraints: {
      autoGainControl: {ideal: true},
      echoCancellation: {ideal: true},
      noiseSuppression: {ideal: true},
    },
    disabled: 'none',
  },
  video: {
    constraints: {
      width: {ideal: 160},
      height: {ideal: 120},
    },
    disabled: 'none',
    sizes: {large: 260, small: 160},
  },
  listenClass: null,
  moreInfoUrl: {},
  signalingUrls: [''],
  projectId: '',
  apiKey: '',
  // The type of access token to create.
  // Supported values are 'jwt' and 'meeting.dev'.
  createAccessTokenType: 'jwt',
  // The URL to create an access token for the signaling server.
  createAccessTokenUrl: null,
};
let settings = null;
let socketio;

// Copied from:
// https://github.com/ether/etherpad-lite/blob/f95b09e0b6752a0d226d58d8b246831164dc9533/src/node/handler/PadMessageHandler.js#L1411-L1420
const _getRoomSockets = (padID) => {
  const ns = socketio.sockets; // Default namespace.
  // We could call adapter.clients(), but that method is unnecessarily asynchronous. Replicate what
  // it does here, but synchronously to avoid a race condition. This code will have to change when
  // we update to socket.io v3.
  const room = ns.adapter.rooms?.get(padID);

  if (!room) return [];

  return Array.from(room)
      .map((socketId) => ns.sockets.get(socketId))
      .filter((socket) => socket);
};

/**
 * Handles an RTC Message
 * @param socket The socket.io Socket object for the client that sent the message.
 * @param message the message from the client
 */
const handleRTCMessage = (socket, payload) => {
  const {[socket.id]: {author: userId, padId} = {}} = sessioninfos;
  // The handleMessage hook is executed asynchronously, so the user can disconnect between when the
  // message arrives at Etherpad and when this function is called.
  if (userId == null || padId == null) return;
  const msg = {
    type: 'COLLABROOM',
    data: {
      type: 'RTC_MESSAGE',
      payload: {
        from: userId,
        data: payload.data,
      },
    },
  };
  if (payload.to == null) {
    socket.to(padId).emit('message', msg);
  } else {
    for (const socket of _getRoomSockets(padId)) {
      const session = sessioninfos[socket.id];
      if (session && session.author === payload.to) {
        socket.emit('message', msg);
        break;
      }
    }
  }
};

// Make sure any updates to this are reflected in README
const statErrorNames = [
  'Abort',
  'Hardware',
  'NotFound',
  'Permission',
  'SecureConnection',
  'Unknown',
];

const handleErrorStatMessage = (statName) => {
  if (statErrorNames.includes(statName)) {
    stats.meter(`ep_webrtc_err_${statName}`).mark();
  } else {
    logger.warn(`Invalid ep_webrtc error stat: ${statName}`);
  }
};

exports.clientVars = async (hookName, context) => ({ep_webrtc: {
  ...settings,
  apiKey: '*****', // api key must be secret.
}});

exports.handleMessage = async (hookName, {message, socket}) => {
  if (message.type === 'COLLABROOM' && message.data.type === 'RTC_MESSAGE') {
    handleRTCMessage(socket, message.data.payload);
    return [null];
  }
  if (message.type === 'STATS' && message.data.type === 'RTC_MESSAGE') {
    handleErrorStatMessage(message.data.statName);
    return [null];
  }
};

exports.init_ep_webrtc = async (hookName, {logger: l}) => {
  if (l != null) logger = l;
  // TODO: Remove this once all supported Node.js versions have the fetch API (added in Node.js
  // v17.5.0 behind the --experimental-fetch flag).
  if (!globalThis.fetch) {
    // eslint-disable-next-line node/no-unsupported-features/es-syntax -- https://github.com/mysticatea/eslint-plugin-node/issues/250
    const {default: fetch, Headers, Request, Response} = await import('node-fetch');
    Object.assign(globalThis, {fetch, Headers, Request, Response});
  }
  // TODO: Remove this once all supported Node.js versions have AbortController (>= v15.4.0).
  if (!globalThis.AbortController) {
    // eslint-disable-next-line node/no-unsupported-features/es-syntax -- https://github.com/mysticatea/eslint-plugin-node/issues/250
    globalThis.AbortController = (await import('abort-controller')).default;
  }
};

exports.setSocketIO = (hookName, {io}) => { socketio = io; };

exports.eejsBlock_mySettings = (hookName, context) => {
  context.content += eejs.require('./templates/settings.ejs', {
    audio_hard_disabled: settings.audio.disabled === 'hard',
    video_hard_disabled: settings.video.disabled === 'hard',
  }, module);
};

exports.eejsBlock_styles = (hookName, context) => {
  context.content += eejs.require('./templates/styles.html', {}, module);
};

exports.loadSettings = async (hookName, {settings: {ep_webrtc: s = {}}}) => {
  settings = _.mergeWith({}, defaultSettings, s, (objV, srcV, key, obj, src) => {
    if (Array.isArray(srcV)) return _.cloneDeep(srcV); // Don't merge arrays, replace them.
    if (src === s.video && key === 'constraints') return _.cloneDeep(srcV);
  });
  settings.configError = (() => {
    for (const k of ['audio', 'video']) {
      const {[k]: {disabled} = {}} = settings;
      if (disabled != null && !['none', 'hard', 'soft'].includes(disabled)) {
        logger.error(`Invalid value in settings.json for ep_webrtc.${k}.disabled`);
        return true;
      }
    }
    return false;
  })();
  logger.info('configured:', util.inspect({
    ...settings,
  }, {depth: Infinity}));
};

const createSoraCompliantJWTToken = (apiKey, req, res) => {
  const {channelId} = req.params;
  (new SignJWT({
    channel_id: channelId,
  })
      .setProtectedHeader({alg: 'HS256', typ: 'JWT'})
      .setExpirationTime('30s')
      .sign(new TextEncoder().encode(apiKey)))
      .then((jwt) => {
        res.send(jwt);
      })
      .catch((err) => {
        console.error(
            '[ep_webrtc]',
            'Error occurred',
            err.stack || err.message || String(err),
        );
        res.status(500).send({
          error: err.toString(),
        });
      });
};

const fetchMeetingDevAccessToken = (apiKey, req, res) => {
  const {channelId} = req.params;
  const url = settings.createAccessTokenUrl;
  if (!url) {
    logger.error('createAccessTokenUrl is not set');
    return res.status(500).send({
      error: 'createAccessTokenUrl is not set',
    });
  }
  const body = new URLSearchParams();
  body.append('roomTitle', `ep_webrtc/${channelId}`);
  fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  })
      .then((response) => {
        if (!response.ok) {
          logger.error('Error fetching access token:', response.statusText);
          return res.status(500).send({
            error: 'Error fetching access token',
          });
        }
        return response.text();
      })
      .then((token) => {
        res.send(token);
      })
      .catch((err) => {
        logger.error('Error fetching access token:', err);
        res.status(500).send({
          error: 'Error fetching access token',
        });
      });
};

exports.expressCreateServer = (hookName, args, cb) => {
  logger.info('expressCreateServer');
  const {app} = args;
  app.get('/ep_webrtc/create-access-token', (req, res) => {
    const createAccessTokenType = settings?.createAccessTokenType ?? 'jwt';
    const apiKey = settings?.apiKey ?? '';
    if (createAccessTokenType === 'jwt') {
      return createSoraCompliantJWTToken(apiKey, req, res);
    }
    if (createAccessTokenType !== 'meeting.dev') {
      logger.error('Invalid createAccessTokenType:', createAccessTokenType);
      return res.status(500).send({
        error: 'Invalid createAccessTokenType',
      });
    }
    return fetchMeetingDevAccessToken(apiKey, req, res);
  });
  return cb();
};
