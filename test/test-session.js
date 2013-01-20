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
var util = require('util');
var NBName = require('netbios-name');

module.exports.testAccept = function(test) {
  test.expect(3);

  var attachCallback = function(error, request) {
    test.equal(error, null);
    request.accept();
  };

  var srcCallback = function(error, session) {
    test.equal(error, null);
    session.end();
    test.done();
  };

  var dstCallback = function(error, session, server) {
    session.on('connect', function() {
      test.ok(true);
    });

    server.close();
  };

  _doConnection({
    srcName: 'SRC',
    dstName: 'DST',
    attachCallback: attachCallback,
    srcCallback: srcCallback,
    dstCallback: dstCallback
  });
};

module.exports.testRejectMessage = function(test) {
  test.expect(2);

  var errorString = 'Not listening on called name';

  var attachCallback = function(error, request) {
    test.equal(error, null);
    request.reject(errorString);
  };

  var srcCallback = function(error, session) {
    test.equal(error.message, 'Connection failed with response code [' + errorString + ']');
    test.done();
  };

  var dstCallback = function(error, session, server) {
    session.on('connect', function() {
      test.ok(true);
    });

    server.close();
  };

  _doConnection({
    srcName: 'SRC',
    dstName: 'DST',
    attachCallback: attachCallback,
    srcCallback: srcCallback,
    dstCallback: dstCallback
  });
};

module.exports.testRejectNoMessage = function(test) {
  test.expect(2);

  var attachCallback = function(error, request) {
    test.equal(error, null);
    request.reject();
  };

  var srcCallback = function(error, session) {
    test.equal(error.message, 'Connection failed with response code [Unspecified error]');
    test.done();
  };

  var dstCallback = function(error, session, server) {
    session.on('connect', function() {
      test.ok(true);
    });

    server.close();
  };

  _doConnection({
    srcName: 'SRC',
    dstName: 'DST',
    attachCallback: attachCallback,
    srcCallback: srcCallback,
    dstCallback: dstCallback
  });
};

module.exports.testMsg = function(test) {
  var bytes = 1024;
  test.expect((2*bytes) + 6);

  var srcName = 'SRC';
  var dstName = 'DST';

  var testBuf = new Buffer(bytes);
  for (var i = 0; i < bytes; ++i) {
    testBuf.writeUInt8((i % 256), i);
  }

  var attachCallback = function(error, request) {
    test.equal(error, null);
    if (request.callTo.name === dstName) {
      request.accept();
    } else {
      request.reject('Called name not present');
    }
  };

  var srcCallback = function(error, session) {
    test.equal(error, null);
    session.write(testBuf, function(error) {
      test.equal(error, null);
      session.write(testBuf, function(error) {
        test.equal(error, null);
        session.end();
      });
    });
  };

  var dstCallback = function(error, session, server) {
    test.equal(error, null);

    session.on('error', function(error) {
      test.equal(error, null);
      server.close();
      session.end();
      test.done();
    });

    session.on('end', function() {
      test.ok(true);
    });

    var count = 0;

    session.on('message', function(msg) {
      count += 1;

      for (var i = 0; i < bytes && i < msg.length; ++i) {
        test.equal(msg[i], testBuf[i]);
      };

      if (count == 2) {
        // End after a short delay so we can check that only the expected
        // number of messages come out.
        setTimeout(function() {
          server.close();
          session.end();
          test.done();
        }, 500);
      }
    });
  };

  _doConnection({
    srcName: srcName,
    dstName: dstName,
    attachCallback: attachCallback,
    srcCallback: srcCallback,
    dstCallback: dstCallback
  });
};

module.exports.testPause = function(test) {
  var bytes = 1024;
  test.expect(bytes + 5);

  var srcName = 'SRC';
  var dstName = 'DST';

  var testBuf = new Buffer(bytes);
  for (var i = 0; i < bytes; ++i) {
    testBuf.writeUInt8((i % 256), i);
  }

  var attachCallback = function(error, request) {
    test.equal(error, null);
    if (request.callTo.name === dstName) {
      request.accept();
    } else {
      request.reject('Called name not present');
    }
  };

  var srcCallback = function(error, session) {
    test.equal(error, null);
    session.write(testBuf, function(error) {
      test.equal(error, null);
      session.write(testBuf, function(error) {
        test.equal(error, null);
        session.end();
      });
    });
  };

  var dstCallback = function(error, session, server) {
    test.equal(error, null);

    session.on('error', function(error) {
      test.equal(error, null);
      server.close();
      session.end();
      test.done();
    });

    session.on('end', function() {
      test.ok(true);
    });

    var count = 0;

    session.on('message', function(msg) {
      count += 1;

      for (var i = 0; i < bytes && i < msg.length; ++i) {
        test.equal(msg[i], testBuf[i]);
      };

      if (count == 1) {
        session.pause();

        // End after a short delay so we can check that only the expected
        // number of messages come out.
        setTimeout(function() {
          server.close();
          session.end();
          test.done();
        }, 500);
      }
    });
  };

  _doConnection({
    srcName: srcName,
    dstName: dstName,
    attachCallback: attachCallback,
    srcCallback: srcCallback,
    dstCallback: dstCallback
  });
};

module.exports.testResume = function(test) {
  var bytes = 1024;
  test.expect((2*bytes) + 8);

  var srcName = 'SRC';
  var dstName = 'DST';

  var testBuf = new Buffer(bytes);
  for (var i = 0; i < bytes; ++i) {
    testBuf.writeUInt8((i % 256), i);
  }

  var attachCallback = function(error, request) {
    test.equal(error, null);
    if (request.callTo.name === dstName) {
      request.accept();
    } else {
      request.reject('Called name not present');
    }
  };

  var srcCallback = function(error, session) {
    test.equal(error, null);
    session.write(testBuf, function(error) {
      test.equal(error, null);
      session.write(testBuf, function(error) {
        test.equal(error, null);
        session.end();
      });
    });
  };

  var dstCallback = function(error, session, server) {
    test.equal(error, null);

    session.on('error', function(error) {
      test.equal(error, null);
      server.close();
      session.end();
      test.done();
    });

    session.on('end', function() {
      test.ok(true);
    });

    var count = 0;
    var resumed = false;

    session.on('message', function(msg) {
      count += 1;

      for (var i = 0; i < bytes && i < msg.length; ++i) {
        test.equal(msg[i], testBuf[i]);
      };

      if (count == 1) {
        session.pause();

        setTimeout(function() {
          test.ok(true);
          resumed = true;
          session.resume();
        }, 500);
      }

      if (count == 2) {
        test.ok(resumed);
        // End after a short delay so we can check that only the expected
        // number of messages come out.
        setTimeout(function() {
          server.close();
          session.end();
          test.done();
        }, 500);
      }
    });
  };

  _doConnection({
    srcName: srcName,
    dstName: dstName,
    attachCallback: attachCallback,
    srcCallback: srcCallback,
    dstCallback: dstCallback
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

function _doConnection(opts) {
  var server = net.createServer();

  var callTo = new NBName({name: opts.dstName, suffix: 0x20});
  var callFrom = new NBName({name: opts.srcName, suffix: 0x20});

  server.on('connection', function(socket) {
    var recv = new Session();
    recv.attach(socket, opts.attachCallback);

    if (typeof opts.dstCallback === 'function') {
      opts.dstCallback(null, recv, server);
    }
  });

  server.listen(0, '127.0.0.1', function() {
    var port = server.address().port;

    var send = new Session();
    send.connect(port, '127.0.0.1', callFrom, callTo, function(error) {
      if (typeof opts.srcCallback === 'function') {
        opts.srcCallback(error, send);
      }
    });
  });
}
