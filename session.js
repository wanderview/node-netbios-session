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

var con = require('./lib/constant');
var NBName = require('netbios-name');

var Readable = require('readable-stream');
var Duplex = require('readable-stream/duplex');

var net = require('net');
var util = require('util');

// TODO: Move constants into session.js
// TODO: Implement retarget response when we have a use case

var VALID_TYPES = {
  'establishingIn': { 'request': true },
  'establishingOut': { 'positive response': true,
                       'negative response': true },
  'established': { 'message': true,
                   'keep alive': true }
};

util.inherits(NetbiosSession, Duplex);

var DEFAULT_PORT = 139;

function NetbiosSessionState(session, opts) {
  this.mode = null;

  this.defaultAccept = !!opts.defaultAccept;

  this.attachCallback = null;
  this.connectCallback = null;
  this.readCallback = null;

  this.trailerType = null;
  this.trailerLength = 0;
  this.readFunc = session._readHeader.bind(session);
}

function NetbiosSession(opts) {
  var self = this instanceof NetbiosSession
           ? this
           : Object.create(NetbiosSession.prototype);

  opts = opts || {};

  Duplex.call(self, opts);

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
      cb(new Error('Cannot connect Session already active.'));
    }
    return;
  }

  if (typeof port !== 'number') {
    port = DEFAULT_PORT;
  }

  ss.mode = 'establishingOut';
  ss.socket = net.createConnection(port, addr, function() {
    self._sendRequest(callTo, callFrom, cb);
  });

  self._initInputStream();
};

NetbiosSession.prototype.attach = function(socket, callback) {
  var ss = this._sessionState;

  if (ss.mode || ss.socket) {
    if (typeof callback === 'function') {
      callback(new Error('Cannot attach Session already active.'));
    }
    return;
  }

  ss.mode = 'establishingIn';
  ss.socket = socket;
  ss.attachCallback = callback;
  this._initInputStream();
  this._doRead();
};

NetbiosSession.prototype._initInputStream = function() {
  var ss = this._sessionState;
  // TODO:  Work around bug in Net.Socket with reading large buffers. Remove
  //        when node master has been updated.
  ss.inputStream = new Readable({highWaterMark: con.MAX_TRAILER_LENGTH +
                                                con.HEADER_LENGTH});
  ss.inputStream.wrap(ss.socket);
  ss.inputStream.on('error', this.emit.bind(this, 'error'));
}

NetbiosSession.prototype._sendRequest = function(callTo, callFrom, callback) {
  var ss = this._sessionState;
  var bytes = 0;

  var buf = new Buffer(con.HEADER_LENGTH + con.MAX_TRAILER_LENGTH);

  // Skip the header for the moment while we wmainlinerite the variable length names
  bytes += con.HEADER_LENGTH;

  var res = callTo.write(buf, bytes);
  if (res.error) {
    if (typeof callback === 'function') {
      callback(res.error);
    }
    return;
  }

  bytes += res.bytesWritten;

  res = callFrom.write(buf, bytes);
  if (res.error) {
    if (typeof callback === 'function') {
      callback(res.error);
    }
    return;
  };

  bytes += res.bytesWritten;

  var trailerLen = bytes - con.HEADER_LENGTH;

  // Now go back and write header
  bytes = 0;
  var len = this._packHeader(buf, bytes, 'request', trailerLen);
  bytes += len
  bytes += trailerLen;

  ss.connectCallback = callback;

  ss.socket.write(buf.slice(0, bytes));

  // Start the read flow to begin looking for response packets
  this._doRead();
};

NetbiosSession.prototype._read = function(size, callback) {
  var ss = this._sessionState;

  if (ss.readCallback) {
    throw new Error('Cannot call _read() again before previous callback occurs');
  }

  ss.readCallback = callback;

  this._doRead();
}

NetbiosSession.prototype._write = function(chunk, callback) {
  // Each NetBIOS session message is limited to a maximum number of bytes
  // due to the size of the length field in the header.  Therefore we
  // may not be able to write this chunk out in one message.  To handle
  // this situation iterator over the chunk and write out a header for
  // each section equaling this maximum message size.

  this._writeChunk(chunk, 0, callback);
};

NetbiosSession.prototype._writeChunk = function(chunk, offset, callback) {
  var self = this;
  var ss = self._sessionState;

  // latch length of this message to maximum allowed by protocol header
  var msgLength = Math.min(chunk.length - offset, con.MAX_TRAILER_LENGTH);

  // Write the header out for this bit of the chunk
  var buf = new Buffer(con.HEADER_LENGTH);
  self._packHeader(buf, 0, 'message', msgLength);
  _writeFlow(ss.socket, buf, function() {

    // Write the trailer out.  When done, either write the next part of
    // the chunk out or call the original _write() completion callback
    var end = offset + msgLength;
    var completeHook = callback;
    if (end < chunk.length) {
      completeHook = self._writeChunk.bind(self, chunk, end, callback);
    }
    _writeFlow(ss.socket, chunk.slice(offset, end), completeHook);
  });
};

function _writeFlow(stream, buf, callback) {
  if (stream.write(buf)) {
    callback();
    return;
  }
  stream.once('drain', callback);
}

NetbiosSession.prototype._packHeader = function(buf, offset, typeString, length) {
  var type = con.TYPE_FROM_STRING[typeString];
  buf.writeUInt8(type, offset);
  offset += 1;

  var flags = 0;
  if (length >= con.EXTENSION_LENGTH) {
    flags |= con.FLAGS_E_MASK;
    length -= con.EXTENSION_LENGTH;
  }
  buf.writeUInt8(flags, offset);
  offset += 1;

  buf.writeUInt16BE(length, offset);
  offset += 2;

  return offset;
}

NetbiosSession.prototype._doRead = function() {
  var ss = this._sessionState;

  ss.readFunc();

  // We need to keep reading if:
  //  - we are still trying to establish a NetBIOS call
  //  - we still have bytes left to read in the trailer, meaning a particular
  //    NetBIOS message has only been partially read
  //  - we have a callback registered from our parent reader indicating there
  //    is an outstanding read() in progress
  if (ss.mode !== 'established' || ss.trailerLength > 0 || ss.readCallback) {
    ss.inputStream.once('readable', this._doRead.bind(this));
  }
}

NetbiosSession.prototype._readHeader = function() {
  var ss = this._sessionState;

  var chunk = ss.inputStream.read(con.HEADER_LENGTH);
  if (chunk) {
    var bytes = 0;

    // 8-bit type
    var t = chunk.readUInt8(bytes);
    bytes += 1;

    var type = con.TYPE_TO_STRING[t];
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
    if (flags & con.FLAGS_E_MASK) {
      length += con.EXTENSION_LENGTH;
    }

    ss.trailerLength = length;

    if (ss.trailerLength > 0) {
      ss.readFunc = this._readTrailer.bind(this);
      ss.readFunc();
      return;
    }

    ss.trailerType = null;
    ss.trailerLength = 0;

    if (type === 'positive response') {
      this._handlePositiveResponse();
    }
  }
};

NetbiosSession.prototype._readTrailer = function() {
  var ss = this._sessionState;

  var chunk = ss.inputStream.read(ss.trailerLength);
  if (chunk) {
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
  }
};

NetbiosSession.prototype._handleRequest = function(chunk) {
  var self = this;
  var ss = self._sessionState;

  var nbname = NBName.fromBuffer(chunk, 0);
  if (nbname.error) {
    if (typeof ss.attachCallback === 'function') {
      ss.attachCallback(nbname.error);
    }
    return;
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
  // but this can be overriden by passing {defaultAccept: true} to the
  // constructor.
  var errorString = null;
  if (typeof ss.attachCallback === 'function') {
    var request = {
      callTo: callTo,
      callFrom: callFrom,
      accept: function() {
        ss.mode = 'established';
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
    ss.mode = 'established';
    self._sendPositiveResponse();
  } else {
    self._sendNegativeResponse(null);
  }
};

NetbiosSession.prototype._handleMessage = function(chunk) {
  var ss = this._sessionState;

  // Since this represents a basic data payload, just pass any bytes read
  // back to the client making the read() function.
  //
  // If there was no outstanding read() callback, then just ignore these
  // bytes.  This should only happen if we get a data message before the
  // session is fully established.  This should not happen given our earlier
  // checks for message type validity based on our mode.
  //
  // NOTE: We must clear our state before calling the callback function
  //       since it may directly lead to another _read() call.

  var cb = ss.readCallback;
  ss.readCallback = null;

  if (typeof cb === 'function') {
    cb(null, chunk);
  }
};

NetbiosSession.prototype._handlePositiveResponse = function(chunk) {
  var ss = this._sessionState;

  if (ss.mode !== 'establishingOut') {
    return;
  }

  var cb = ss.connectCallback;
  ss.connectCallback = null;
  ss.mode = 'established';

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
  var errString = con.ERROR_CODE_TO_STRING[errCode];
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

  var buf = new Buffer(con.HEADER_LENGTH);
  var bytes = 0;

  var len = this._packHeader(buf, bytes, 'positive response', 0);
  bytes += len;

  ss.socket.write(buf);
};

NetbiosSession.prototype._sendNegativeResponse = function(errorString) {
  var ss = this._sessionState;

  var buf = new Buffer(con.HEADER_LENGTH + 1);
  var bytes = 0;

  var len = this._packHeader(buf, bytes, 'negative response', 1);
  bytes += len;

  var errorCode = con.ERROR_CODE_FROM_STRING[errorString];
  if (!errorCode) {
    errorCode = con.ERROR_CODE_FROM_STRING['Unspecified error'];
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
