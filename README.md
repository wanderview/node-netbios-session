# netbios-session

A 100% javascript implemention of the NetBIOS session protocol defined in
[RFC1001][] and [RFC1002][].

This is a very rough work-in-progress at the moment.

Currently the Session class is a wrapper around a TCP socket implementing both
the Readable and Writable interfaces.  Reading receives bytes from the remote
host and writing sends bytes to the remote host.

Currently the code only accepts incoming NetBIOS sessions and cannot make
calls out.  This is on the TODO list.

## Example

    var Session = requiest('netbios-session');
    var net = require('net');

    var server = net.createServer(function(conn) {
      var session = new Session(conn, null, function(calledName, callingName) {
        // Only approve connections to the 'FOOBAR' service
        return (calledName === 'FOOBAR');
      });

      // Do one any of the following:
      //  session.read();
      //  session.on('readable', func);
      //  session.pipe(writableStream);
    });

[RFC1001]: http://tools.ietf.org/rfc/rfc1001.txt
[RFC1002]: http://tools.ietf.org/rfc/rfc1002.txt
