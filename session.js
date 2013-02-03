// Copyright (c) 2013, Benjamin J. Kelly ("Author")
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
// ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

'use strict';

module.exports = NetbiosSession;
module.exports.MAX_MESSAGE_LENGTH = MAX_TRAILER_LENGTH;

var NBName = require('netbios-name');
var EventEmitter = require('events').EventEmitter;
var Readable = require('readable-stream');
var net = require('net');
var util = require('util');

// TODO: Implement retarget response when we have a use case

var VALID_TYPES = {
  'establishingIn': { 'request': true },
  'establishingOut': { 'positive response': true,
                       'negative response': true },
  'established': { 'message': true,
                   'keep alive': true }
};

var DEFAULT_PORT = 139;

var TYPE_TO_STRING = {
  0x00: 'message',
  0x81: 'request',
  0x82: 'positive response',
  0x83: 'negative response',
  0x84: 'retarget response',
  0x85: 'keep alive'
};

var TYPE_FROM_STRING = {
  'message': 0x00,
  'request': 0x81,
  'positive response': 0x82,
  'negative response': 0x83,
  'retarget response': 0x84,
  'keep alive': 0x85
};

var FLAGS_E_MASK = 0x80;
var FLAGS_RESERVED_MASK = 0x7f;

var ERROR_CODE_TO_STRING = {
  0x80: 'Not listening on called name',
  0x81: 'Not listening for calling name',
  0x82: 'Called name not present',
  0x83: 'Called name present, but insufficient resources',
  0x8f: 'Unspecified error'
};

var ERROR_CODE_FROM_STRING = {
  'Not listening on called name': 0x80,
  'Not listening for calling name': 0x81,
  'Called name not present': 0x82,
  'Called name present, but insufficient resources': 0x83,
  'Unspecified error': 0x8f
};

var EXTENSION_LENGTH = 1 << 16;
var MAX_TRAILER_LENGTH = (1 << 17) - 1;
var HEADER_LENGTH = 4;

util.inherits(NetbiosSession, EventEmitter);

function NetbiosSessionState(session, opts) {
  this.mode = null;

  this.direct = !!opts.direct;
  this.autoAccept = !!opts.autoAccept;

  this.paused = !!opts.paused;

  this.attachCallback = null;
  this.connectCallback = null;

  this.trailerType = null;
  this.trailerLength = 0;
  this.readFunc = session._readHeader.bind(session);
}

function NetbiosSession(opts) {
  var self = this instanceof NetbiosSession
           ? this
           : Object.create(NetbiosSession.prototype);

  opts = opts || {};

  EventEmitter.call(self, opts);

  self._sessionState = new NetbiosSessionState(self, opts);

  self.once('finish', function() {
    var ss = self._sessionState;
    if (ss.socket) {
      ss.socket.end();
      ss.socket = null;
    }
    ss.mode = null;
  });

  return self;
}

NetbiosSession.prototype.connect = function(port, addr, callFrom, callTo, cb) {
  var self = this;
  var ss = self._sessionState;

  if (ss.mode || ss.socket) {
    if (typeof cb === 'function') {
      var error = new Error('Cannot connect Session already active.');
      process.nextTick(cb.bind(null, error));
    }
    return;
  }

  if (typeof port !== 'number') {
    port = DEFAULT_PORT;
  }

  var socket = net.createConnection(port, addr, function() {
    self._connectSocket(socket, callFrom, callTo, cb);
  });
};

NetbiosSession.prototype._connectSocket = function(socket, callFrom, callTo, cb) {
  var ss = this._sessionState;

  ss.socket = socket;
  this._initInputStream();

  ss.mode = 'establishingOut';

  if (ss.direct) {
    if (typeof cb === 'function') {
      cb();
    }
    this._established();
    this._doRead();
    return;
  }
  this._sendRequest(callTo, callFrom, cb);
  this._doRead();
};

NetbiosSession.prototype.attach = function(socket, callback) {
  var ss = this._sessionState;

  if (ss.mode || ss.socket) {
    if (typeof callback === 'function') {
      var error = new Error('Cannot attach Session already active.');
      process.nextTick(callback.bind(null, error));
    }
    return;
  }

  ss.socket = socket;
  this._initInputStream();

  if (ss.direct) {
    this._established();
    this._doRead();
    return;
  }

  ss.mode = 'establishingIn';
  ss.attachCallback = callback;
  this._doRead();
};

NetbiosSession.prototype.pause = function() {
  this._sessionState.paused = true;
};

NetbiosSession.prototype.resume = function() {
  var ss = this._sessionState;
  if (ss.paused) {
    ss.paused = false;
    this._doRead();
  }
};

NetbiosSession.prototype._initInputStream = function() {
  var ss = this._sessionState;
  // TODO:  Work around bug in Net.Socket with reading large buffers. Remove
  //        when node master has been updated.
  ss.inputStream = new Readable({highWaterMark: MAX_TRAILER_LENGTH +
                                                HEADER_LENGTH});
  ss.inputStream.wrap(ss.socket);
  ss.inputStream.on('error', this.emit.bind(this, 'error'));
  ss.inputStream.on('end', this.emit.bind(this, 'end'));
}

NetbiosSession.prototype._sendRequest = function(callTo, callFrom, callback) {
  var ss = this._sessionState;
  var bytes = 0;

  var buf = new Buffer(HEADER_LENGTH + MAX_TRAILER_LENGTH);

  // Skip the header for the moment while we write the variable length names
  bytes += HEADER_LENGTH;

  var res = callTo.write(buf, bytes);
  if (res.error) {
    if (typeof callback === 'function') {
      process.nextTick(callback.bind(null, res.error));
    }
    return;
  }

  bytes += res.bytesWritten;

  res = callFrom.write(buf, bytes);
  if (res.error) {
    if (typeof callback === 'function') {
      process.nextTick(callback.bind(null, res.error));
    }
    return;
  };

  bytes += res.bytesWritten;

  var trailerLen = bytes - HEADER_LENGTH;

  // Now go back and write header
  bytes = 0;
  var len = this._packHeader(buf, bytes, 'request', trailerLen);
  bytes += len
  bytes += trailerLen;

  ss.connectCallback = callback;

  ss.socket.write(buf.slice(0, bytes));
};

NetbiosSession.prototype.write = function(msg, callback) {
  var ss = this._sessionState;

  if (msg.length > MAX_TRAILER_LENGTH) {
    var error = new Error('Message length [' + msg.length +
                          '] exceeds maximum [' + MAX_TRAILER_LENGTH + ']');
    this.emit('error', error);
    if (typeof callback === 'function') {
      process.nextTick(callback.bind(null, error));
    }

    return true;
  }

  var buf = new Buffer(HEADER_LENGTH);
  this._packHeader(buf, 0, 'message', msg.length);

  var flushed = ss.socket.write(buf);

  if (!flushed) {
    ss.needDrain = true;
    ss.socket.once('drain', this._writeMsg.bind(this, msg, callback));
    return false;
  }

  return this._writeMsg(msg, callback);
};

NetbiosSession.prototype._writeMsg = function(msg, callback) {
  var ss = this._sessionState;

  var flushed = ss.socket.write(msg);

  if (!flushed) {
    ss.needDrain = true;
    ss.socket.once('drain', this._doDrain.bind(this, callback));
    return false;
  }

  this._doDrain(callback);
  return true;
};

NetbiosSession.prototype._doDrain = function(callback) {
  var ss = this._sessionState;
  if (ss.needDrain) {
    ss.needDrain = false;
    this.emit('drain');
  }

  if (typeof callback === 'function') {
    process.nextTick(callback);
  }
}

NetbiosSession.prototype.end = function() {
  var ss = this._sessionState;
  if (ss.socket) {
    ss.mode = null;
    ss.paused = false;
    ss.socket.end();
    ss.socket = null;
  }
};

NetbiosSession.prototype._packHeader = function(buf, offset, typeString, length) {
  var type = TYPE_FROM_STRING[typeString];
  buf.writeUInt8(type, offset);
  offset += 1;

  var flags = 0;
  if (length >= EXTENSION_LENGTH) {
    flags |= FLAGS_E_MASK;
    length -= EXTENSION_LENGTH;
  }
  buf.writeUInt8(flags, offset);
  offset += 1;

  buf.writeUInt16BE(length, offset);
  offset += 2;

  return offset;
}

NetbiosSession.prototype._doRead = function() {
  var self = this;
  var ss = self._sessionState;

  // Always execute whatever reading function we have in nextTick to avoid
  // issuing callbacks synchronously on connect(), attach(), resume(), etc.
  process.nextTick(function() {
    var complete = ss.readFunc();

    if (ss.mode === 'established' && ss.paused) {
      return;
    }

    if (!complete) {
      ss.inputStream.once('readable', self._doRead.bind(self));
      return;
    }

    self._doRead();
  });
}

NetbiosSession.prototype._readHeader = function() {
  var ss = this._sessionState;

  var chunk = ss.inputStream.read(HEADER_LENGTH);
  if (!chunk) {
    return false;
  }

  var bytes = 0;

  // 8-bit type
  var t = chunk.readUInt8(bytes);
  bytes += 1;

  var type = TYPE_TO_STRING[t];
  if (!VALID_TYPES[ss.mode][type]) {
    // Even though this was unexpected, we need to complete reading
    // the trailer to clear the message.  Simply ignore any bytes read.
    type = 'ignore';
  }
  ss.trailerType = type;

  // 8-bit flags
  var flags = chunk.readUInt8(bytes);
  bytes += 1;

  // 16-bit length of following trailer (plus 1-bit from the 8-bit flags above)
  var length = chunk.readUInt16BE(bytes);
  bytes += 2;

  // if the extension flag is set, then add it as a high order bit to the
  // length
  if (flags & FLAGS_E_MASK) {
    length += EXTENSION_LENGTH;
  }

  ss.trailerLength = length;

  if (ss.trailerLength > 0) {
    ss.readFunc = this._readTrailer.bind(this);
    return ss.readFunc();
  }

  ss.trailerType = null;
  ss.trailerLength = 0;

  if (type === 'positive response') {
    this._handlePositiveResponse();
  }

  return true;
};

NetbiosSession.prototype._readTrailer = function() {
  var ss = this._sessionState;

  var chunk = ss.inputStream.read(ss.trailerLength);
  if (!chunk) {
    return false;
  }

  var type = ss.trailerType;

  ss.readFunc = this._readHeader.bind(this);
  ss.trailerType = null;
  ss.trailerLength = 0;

  // Process the trailer data based on the message type.  Ignore keep alives
  // and unexpected types.  Just consume the trailer to clear the message.
  if (type === 'request') {
    this._handleRequest(chunk);
  } else if (type === 'message') {
    this._handleMessage(chunk);
  } else if (type === 'negative response') {
    this._handleNegativeResponse(chunk);
  }

  return true;
};

NetbiosSession.prototype._handleRequest = function(chunk) {
  var self = this;
  var ss = self._sessionState;

  var nbname = NBName.fromBuffer(chunk, 0);
  if (nbname.error) {
    if (typeof ss.attachCallback === 'function') {
      ss.attachCallback(nbname.error);
    }
  }

  var callTo = nbname;

  nbname = NBName.fromBuffer(chunk, callTo.bytesRead);
  if (nbname.error) {
    if (typeof ss.attachCallback === 'function') {
      ss.attachCallback(nbname.error);
    }
    return;
  }

  var callFrom = nbname;

  // If we have a callback, then make the call passing a request object.
  // The callback can then use the request object to accept() or reject()
  // the session.  One of these methods must be made, but it can occur
  // asynchronously at a later time.  If a callback is not supplied then
  // the default policy is applied.  Normally this is reject by default,
  // but this can be overriden by passing {autoAccept: true} to the
  // constructor.
  var errorString = null;
  if (typeof ss.attachCallback === 'function') {
    var request = {
      callTo: callTo,
      callFrom: callFrom,
      accept: function() {
        self._established();
        self._sendPositiveResponse();
        request.accept = null;
        request.reject = null;
      },
      reject: function(s) {
        self._sendNegativeResponse(s);
        request.accept = null;
        request.reject = null;
      }
    };
    ss.attachCallback(null, request);
    return;
  }

  // No callback to check for acceptance, so use the default policy
  if (!ss.acceptDefault) {
    self._established();
    self._sendPositiveResponse();
  } else {
    self._sendNegativeResponse(null);
  }
};

NetbiosSession.prototype._established = function() {
  this._sessionState.mode = 'established';
  this.emit('connect');
};

NetbiosSession.prototype._handleMessage = function(chunk) {
  this.emit('message', chunk);
};

NetbiosSession.prototype._handlePositiveResponse = function(chunk) {
  var ss = this._sessionState;

  if (ss.mode !== 'establishingOut') {
    return;
  }

  var cb = ss.connectCallback;
  ss.connectCallback = null;
  this._established();

  if (typeof cb === 'function') {
    cb();
  }
};

NetbiosSession.prototype._handleNegativeResponse = function(chunk) {
  var ss = this._sessionState;

  if (ss.mode !== 'establishingOut') {
    return;
  }

  var cb = ss.connectCallback;
  ss.connectCallback = null;

  if (chunk.length !== 1) {
    if (typeof cb === 'function') {
      cb(new Error('Malformed negative response.  Connection failed.'));
      this.end();
      return;
    }
  }

  var errCode = chunk.readUInt8(0);
  var errString = ERROR_CODE_TO_STRING[errCode];
  if (!errString) {
    errString = 'unknown error';
  }

  if (typeof cb === 'function') {
    cb(new Error('Connection failed with response code [' + errString + ']'));
  }

  this.end();
};

NetbiosSession.prototype._sendPositiveResponse = function() {
  var ss = this._sessionState;

  var buf = new Buffer(HEADER_LENGTH);
  var bytes = 0;

  var len = this._packHeader(buf, bytes, 'positive response', 0);
  bytes += len;

  ss.socket.write(buf);
};

NetbiosSession.prototype._sendNegativeResponse = function(errorString) {
  var ss = this._sessionState;

  var buf = new Buffer(HEADER_LENGTH + 1);
  var bytes = 0;

  var len = this._packHeader(buf, bytes, 'negative response', 1);
  bytes += len;

  var errorCode = ERROR_CODE_FROM_STRING[errorString];
  if (!errorCode) {
    errorCode = ERROR_CODE_FROM_STRING['Unspecified error'];
  }

  buf.writeUInt8(errorCode, bytes);
  bytes += 1;

  // Write out the negative response back to the client trying to connect
  // to us.  Since this represents a session failure, automatically close
  // the stream once the bytes have been sent.
  if(ss.socket.write(buf)) {
    this.end();
  } else {
    ss.socket.once('drain', this.end.bind(this));
  }
};
