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

var FWD_PORT = 445;
var FWD_HOST = '127.0.0.1';

var server = net.createServer(function(socket) {
  var sessionIn = new Session({paused: true, autoAccept: true});

  sessionIn.on('connect', function() {
    var sessionOut = new Session({direct: true});

    var errorHandler = function(error) {
      console.log(error);
      sessionIn.end();
      sessionOut.end();
    };
    sessionIn.on('error', errorHandler);
    sessionOut.on('error', errorHandler);

    sessionIn.on('message', _forward.bind(null, sessionOut, sessionIn));
    sessionOut.on('message', _forward.bind(null, sessionIn, sessionOut));

    sessionOut.on('connect', sessionIn.resume.bind(sessionIn));

    sessionOut.connect(FWD_PORT, FWD_HOST);
  });

  sessionIn.attach(socket);
});

function _forward(dst, src, msg) {
  var flushed = dst.write(msg);
  if (!flushed) {
    src.pause();
    dst.once('drain', src.resume.bind(src));
  }
}

server.listen(139, function() {
  console.log('netbios-fwd started');
});
