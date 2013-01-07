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

var con = require('./lib/constant');
var unpackName = require('netbios-name/unpack');

var Readable = require('readable-stream');
var Duplex = require('readable-stream/duplex');

var util = require('util');

var VALID_TYPES = {
  'establishing': { 'request': true },
  'established': { 'message': true,
                   'keep alive': true }
};

util.inherits(NetbiosSession, Duplex);

function NetbiosSessionState(session, socket, approveFn) {
  this.socket = socket;

  this.inputStream = new Readable();
  this.inputStream.wrap(socket);

  this.mode = 'establishing';

  this.approveFn = approveFn;
  this.readCallback = null;

  this.trailerType = null;
  this.trailerLength = 0;
  this.readFunc = session._readHeader.bind(session);
}

function NetbiosSession(socket, options, approveFn) {
  var self = this instanceof NetbiosSession
           ? this
           : Object.create(NetbiosSession.prototype);

  Readable.call(self, options);

  options = options || {};

  // TODO:  We should probably accept extra arguments here indicating that
  //        this session is calling out instead of receiving a call in.

  self._sessionState = new NetbiosSessionState(self, socket, approveFn);

  // Auto-read from the start since we need to pull in the initial NetBIOS
  // call operation even if the client does not issue a data read() yet.
  self._doRead();

  return self;
}

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
  var offset = 0;
  while (offset < chunk.length) {

    // latch length of this message to maximum allowed by protocol header
    var msgLength = Math.min(chunk.length, con.MAX_TRAILER_LENGTH);

    var header = new Buffer(4);
    this._packHeader(buf, 0, 'message', msgLength);

    var msg = chunk.slice(offset, offset + msgLength);

    // Only report back completion to caller when we write out the
    // last bit of the chunk
    var completeHook = null;
    if (offset + msgLength >= chunk.length) {
      completeHook = function() {
        callback();
      };
    }

    ss.socket.write(header);
    ss.socket.write(msg, completeHook);

    offset += msgLength;
  }
}

NetbiosSession.prototype._packHeader = function(buf, offset, type, length) {
  var type = con.TYPE_FROM_STRING('message');
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

  // The header is a fixed 4-bytes long
  var chunk = ss.inputStream.read(4);
  if (chunk) {
    var bytes = 0;

    // 8-bit type
    var t = chunk.readUInt8(bytes);
    bytes += 1;

    var type = con.TYPE_TO_STRING[t];
    if (!VALID_TYPES[ss.mode][type]) {
      // TODO: send negative response?
      // TODO: emit error?
      // TODO: call readCallback with error???

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
    }
  }
}

NetbiosSession.prototype._readTrailer = function() {
  var ss = this._sessionState;

  var chunk = ss.inputStream.read(ss.trailerLength);
  if (chunk) {
    // Process the trailer data based on the message type.  Ignore keep alives
    // and unexpected types.  Just consume the trailer to clear the message.
    if (ss.trailerType === 'request') {
      this._handleRequest(chunk);
    } else if (ss.trailerType === 'message') {
      this._handleMessage(chunk);
    }

    ss.readFunc = this._readHeader.bind(this);
    ss.trailerType = null;
    ss.trailerLength = 0;
  }
}

NetbiosSession.prototype._handleRequest = function(chunk) {
  var self = this;
  var ss = self._sessionState;

  unpackName(chunk, 0, function(error, calledLen, name, suffix) {
    if (error) {
      console.log('Got error [' + error + '] unpacking called name');
      // TODO:  send negative response?
      // TODO:  call callback with error?
      // TODO:  throw error?
      return;
    }

    var called = name;

    unpackName(chunk, calledLen, function(error, callingLen, name, suffix) {
      if (error) {
        console.log('Got error [' + error + '] unpacking calling name');
        // TODO:  send negative response?
        // TODO:  call callback with error?
        // TODO:  throw error?
        return;
      }

      var calling = name;

      // If called/calling names are acceptable send positive response.  If
      // we have no way to check for approval then default to accepting the
      // session.
      if (typeof ss.approveFn === 'function') {
        var errorCode = ss.approveFn(called, calling);

        // This request is for a bad name, reject
        if (errorCode) {
          self._sendNegativeResponse(errorCode);
          return;
        }
      }
      ss.mode = 'established';
      self._sendPositiveResponse();

      // TODO: refactor send response code into one function to be more DRY
    });
  });
}

NetbiosSession.prototype._handleMessage = function(chunk) {
  var ss = this._sessionState;

  // Since this represents a basic data payload, just pass any bytes read
  // back to the client making the read() function.
  //
  // If there was no outstanding read() callback, then just ignore these
  // bytes.  This should only happen if we get a data message before the
  // session is fully established.  This should not happen given our earlier
  // checks for message type validity based on our mode.
  if (typeof ss.readCallback === 'function') {
    ss.readCallback(null, chunk);
  }
  ss.readCallback = null;
}

NetbiosSession.prototype._sendPositiveResponse = function() {
  var ss = this._sessionState;

  var buf = new Buffer(4);
  var offset = 0;

  buf.writeUInt8(con.TYPE_FROM_STRING['positive response'], offset);
  offset += 1;

  // Flags will always be zero because there is no trailer data
  buf.writeUInt8(0, offset);
  offset += 1;

  // Trailer length is always zero for positive response
  buf.writeUInt16BE(0, offset);
  offset += 2;

  ss.socket.write(buf);
};

NetbiosSession.prototype._sendNegativeResponse = function(errorCode) {
  var ss = this._sessionState;

  var buf = new Buffer(5);
  var offset = 0;

  buf.writeUInt8(con.TYPE_FROM_STRING['negative response'], offset);
  offset += 1;

  // Flags are zero since the trailer is not large enough to need the
  // length extension bit.
  buf.writeUInt8(0, offset);
  offset += 1;

  // Trailer length is always one byte for the error code
  buf.writeUInt16BE(1, offset);
  offset += 2;

  buf.writeUInt8(con.ERROR_CODE_FROM_STRING[errorCode], offset);
  offset += 1;

  ss.socket.write(buf);
};

// TODO:  Implement retarget response when we have a use case

module.exports = NetbiosSession;
