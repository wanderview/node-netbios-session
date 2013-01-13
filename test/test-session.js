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

var Session = require('../session');

var net = require('net');
var NBName = require('netbios-name');

module.exports.testSession = function(test) {
  var bytes = 1024 * 1024;
  test.expect(bytes);
  var server = net.createServer();

  var callee = new NBName({name: 'DST', suffix: 0x20});
  var caller = new NBName({name: 'SRC', suffix: 0x20});

  var testBuf = new Buffer(bytes);
  for (var i = 0; i < bytes; ++i) {
    testBuf.writeUInt8((i % 256), i);
  }

  server.on('connection', function(socket) {
    var recv = new Session({socket: socket}, function(called, calling) {
      if (called.toString() === callee.toString()){
        return null;
      }
      return 'Called name not present';
    });

    _testRead(recv, bytes, function(recvBuf) {
      for (var i = 0; i < bytes && i < recvBuf.length; ++i) {
        test.equal(recvBuf[i], testBuf[i]);
      };
      server.close();
      recv.end();
      test.done();
    });
  });

  server.listen(0, '127.0.0.1', function() {
    var port = server.address().port;

    var send = new Session({
      callTo: callee,
      callFrom: caller,
      address: '127.0.0.1',
      port: port
    }, function() {
      send.write(testBuf, null, function() {
        send.end();
      });
    });
  });
};

function _testRead(readable, len, callback) {
  var testBuf = readable.read(len);
  if (!testBuf) {
    readable.once('readable', _testRead.bind(null, readable, len, callback));
    return;
  }
  callback(testBuf);
}
