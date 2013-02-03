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

var NBName = require('netbios-name');
var PcapSocket = require('pcap-socket');
var path = require('path');

var FILE = path.join(__dirname, 'data', 'netbios-ssn-full-scanner-winxp.pcap');

module.exports.server = function(test) {
  test.expect(7);
  var psocket = new PcapSocket(FILE, '10.0.1.12');

  var session = new Session();

  // validate expected request
  session.attach(psocket, function(error, request) {
    test.equal(null, error);
    test.equal('VMWINXP', request.callTo.name);
    test.equal('PRINTER', request.callFrom.name);
    request.accept();
  });

  // validate that we receive all the expected bytes in the session
  var length = 0;
  session.on('message', function(msg) {
    length += msg.length;
  });

  // validate positive response
  psocket.response.on('readable', function() {
    var chunk = psocket.response.read(4);
    if (chunk) {
      test.equal(0x82, chunk.readUInt8(0));
      test.equal(0, chunk.readUInt8(1));
      test.equal(0, chunk.readUInt16BE(2));
    }
  });
  psocket.response.read(0);

  // validate session completes properly
  session.on('end', function() {
    test.equal(438, length);
    test.done();
  });
};

module.exports.client = function(test) {
  test.expect(7);
  var psocket = new PcapSocket(FILE, '10.0.1.10');

  var session = new Session();

  var callTo = new NBName({fqdn: 'VMWINXP'});
  var callFrom = new NBName({fqdn: 'PRINTER'});

  var msg = 'Hello world!';
  var gotRequest = false;

  // verify the client sends the expected request and session data
  psocket.response.on('readable', function() {
    if (!gotRequest) {
      var chunk = psocket.response.read(72);
      if (chunk) {
        test.equal(0x81, chunk.readUInt8(0));
        test.equal(0, chunk.readUInt8(1));
        test.equal(68, chunk.readUInt16BE(2));

        var from = NBName.fromBuffer(chunk, 4);
        test.equal(from.toString(), callFrom.toString());

        var to = NBName.fromBuffer(chunk, 4 + from.bytesRead);
        test.equal(to.toString(), callTo.toString());

        gotRequest = true;
      }
    } else {
      var chunk = psocket.response.read(msg.length);
      if (chunk) {
        test.equal(msg.length, chunk.length);
      }
    }
  });
  psocket.response.read(0);

  // verify we can establish a connection, this would fail if the pcap
  // file did not include a positive response
  session._connectSocket(psocket, callTo, callFrom, function(error) {
    test.equal(null, error);

    // pcap file session data is ignored in the "client" case, so send our
    // own message
    session.write(new Buffer(msg));
  });

  session.on('end', function() {
    test.done();
  });
};
