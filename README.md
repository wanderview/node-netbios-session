# netbios-session

A 100% javascript implemention of the NetBIOS session protocol defined in
[RFC1001][] and [RFC1002][].

[![Build Status](https://travis-ci.org/wanderview/node-netbios-session.png)](https://travis-ci.org/wanderview/node-netbios-session)

## Example

``` javascript
var Session = require('netbios-session')
var net = require('net');

var NAME = null;

var server = net.createServer(function(socket) {
  console.log('---> new connection from [' + socket.remoteAddress + ']');
  var session = new Session();
  session.attach(socket, function(error, request) {
    if (error) {
      console.log('---> attach error [' + error + ']');
      return;
    }

    console.log('---> new call to [' + request.callTo + '] from [' +
                request.callFrom + ']');

    if (NAME && request.callTo.name !== NAME) {
      console.log('---> rejecting');
      request.reject('Not listening on called name');
      return;
    }

    session.on('message', function(msg) {
      console.log('---> received a message with [' + msg.length + '] bytes');
    });

    console.log('---> accepting');
    request.accept();
  });
});

server.listen(139, function() {
  console.log('server started');
});
```

## Limitations

This module provides a useful set of functionality from the RFCs, but it is
still a work in progress.

Please be aware of the following limitations:

* Currently the code does not support session retargeting.  This can be used
  to instruct a client to close its current connection and try again at a
  different address.  Currently redirection responses are ignored.
* The API should be considered unstable as it may change in future versions.

Feedback, testing help, and pull requests welcome.

## Class: NetbiosSession

The NetbiosSession class represents a message based session with a remote
host.  There is an initial session negotiation process that requires the
caller to request a new session for a particular name.  The other peer
can then accept or reject the request.  Once a request has been accepted the
session is considered to be connected.  At this point messages can be sent
and received.

NetbiosSession inherits from [EventEmitter][] class.

### new NetbiosSession(options)

Create a new NetbiosSession instance with the given `options`.

* `options` {Object | null} Optional configuration options for the session.
  Possible values are:
  * `autoAccept` {Boolean} If set to `true`, then the session will default
    to accepting all requests if an `attach()` `callback` is not provided.
    Default value is `false`
  * `direct` {Boolean} Use direct connection mode if this option is set.
    This means that the session establishment handshake should not be
    performed.  Instead, consider the session connected as soon as we have
    a valid TCP socket.  This is useful for protocols like SMB that still
    want a NetBIOS message header, but do not use the request/response
    commands.
  * `paused` {Boolean} If set the session will start in the paused condition.
    This means that the session can connect or attach as needed, but no
    `'message'` events will occur until `resume()` is called.

### session.attach(socket, callback)

Attach the session to a `net.Socket` instance and wait to receive an incoming
NetBIOS session request.  This is typically used to handle in the `net.Server`
`'connection'` event.

If provided, the `callback` will be called when the request is initiated.  It
is also important for the `callback` implementation to either accept or reject
the request.  This is done by calling `request.accept()` or `request.reject()`.
If neither of these methods is called, then the session request negotiation
process will stall.  If a `callback` is not provided, then the default
policy will be used to either reject or accept.

* `socket` {Socket Object} The socket to attach to.  This socket should
  already be bound and connected.
* `callback` {Function | null} An optional callback that is used to signal
  that a request has occured and to approve or deny the request.  NOTE: If the
  `direct` option was set in the session constructor, then this callback will
  not be called.
  * `error` {Error Object} Provided if an error occurs during the attachment.
  * `request` {Object} An object describing the session request and providing
    method to allow the `callback` to `accept()` or `reject()` the request.
    NOTE:  One of these methods must be called.
    * `callTo` {NetbiosName} The [NetbiosName][] object representing the
      service the session is trying to connect to.
    * `callFrom` {NetbiosName} The [NetbiosName][] object representing the
      service that is initiating the session.
    * `accept` {Function} Call this method to accept the request and allow
      the session to proceed.  Can be called asynchronously
    * `reject` {Function} Call this method to reject the request and to
      close the underlying socket.  A `reason` string can optionally be
      provided.  The `reject()` method can be called asynchronously.
      * `reason` {String | null} A string from an enumerated list of values
        that can optionally be provided.  If not specified then `Unspecified
        error` is used.  See below for other valid reasons.

Valid reason strings are:

* `'Not listening on called name'`
* `'Not listening for calling name'`
* `'Called name not present'`
* `'Called name present, but insufficient resources'`
* `'Unspecified error'`

### session.connect(port, host, callTo, callFrom, callback)

Initiate a new NetBIOS session with a remote host.  This method will open a
new socket and connect to the given `host` and `port`.  A session will then
be requested for the given `callTo` name coming from the given `callFrom`
name.  These must be [NetbiosName][] object instances.  The remote host
can then accept or reject the session based on the names provided.  The
`callback` will be called once the connection successfully completes or
has been rejected.

* `port` {Number} The remote port number to connect to.  Normally this should
  be port 139 for most NetBIOS session servers.
* `host` {String} The remote host name to connect to.
* `callTo` {NetbiosName Object} The [NetbiosName][] representing the service
  you are trying to connect to.
* `callFrom` {NetbiosName Object} The [NetbiosName][] representing the local
  service initiating the session.
* `callback` {Function | null}  The function that will be called once both
  the underlying socket and the session have fully connected.
  * `error` {Error Object | null} If an error occurred it will be passed.  If
    the connection was rejected, then `error` will be set with the result code
    provided by the remote host.

### session.write(msg, callback)

Write the given `msg` out to the remote session peer.  If the message can
be fully flushed to the kernel, then `write()` will return `true`.  If `false`
is returned, you should wait until the next `'drain'` event before writing
more data to the session.

* `msg` {Buffer Object} The message `Buffer` to send to the remote session
  peer.  Note, the message can be at most `NetbiosSession.MAX_MESSAGE_LENGTH`
  bytes long.
* `callback` {Function | null}  Optional function that will be called once
  the `msg` object has been written out or when an error occurs.
  * `error` {Error Object | null} The error that occurred, if any.

### session.pause()

Stop accepting messages from the remote session peer.  This can be used
to implement back pressure if the messages are coming too fast.  Note,
the session can still negotiate the connection even if paused, so there
may still be network traffic if the session is not yet connected.

### session.resume()

Resume accepting message from the remote session peer.

### Constant: `session.MAX_MESSAGE_LENGTH`

Maximum number of bytes that can be passed to a single `write()` method
call to be sent as a message.  Also, messages received will not exceed
this limit as well.

### Event: 'connect'

When the NetbiosSession has negotiated and established a new session, the
`'connect'` event will be emitted.

### Event: 'message'

Whenever a message is received from the remote session peer, a `'message'`
event will be emitted.

* `msg` {Buffer Object}  A `Buffer` containing the message received.

### Event: 'end'

The `'end'` event is emitted when the session can no longer send or receive
messages.

### Event: 'error'

The `'error'` event is emitted when an error is encountered.

* `error` {Error Object} The error that occured.

[RFC1001]: http://tools.ietf.org/rfc/rfc1001.txt
[RFC1002]: http://tools.ietf.org/rfc/rfc1002.txt
[NetbiosName]: http://www.github.com/wanderview/node-netbios-name
