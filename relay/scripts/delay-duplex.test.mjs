import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { delayDuplex } from "./delay-duplex.mjs";

const listen = server => new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
for (const delay of [0,20,50]) for (const first of ["client", "server"]) {
  test(`${delay}ms ordered delivery and ${first} half-close preserve final bytes both ways`, {timeout:5000}, async t => {
    const sockets = [];
    let received = "";
    const ended = Promise.withResolvers();
    const target = createServer({allowHalfOpen:true}, socket => {
      sockets.push(socket);
      socket.on("data", chunk => { received += chunk; });
      socket.on("end", ended.resolve);
      if (first === "server") socket.end("final response");
      else socket.on("end", () => socket.end("final response"));
    });
    await listen(target);
    const proxy = createServer({allowHalfOpen:true}, socket => {
      const upstream = connect({host:"127.0.0.1",port:target.address().port,allowHalfOpen:true});
      sockets.push(socket,upstream);
      delayDuplex(socket,upstream,delay);
    });
    await listen(proxy);
    t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); target.close(); });
    const client = connect({host:"127.0.0.1",port:proxy.address().port,allowHalfOpen:true});
    sockets.push(client);
    let response = "";
    client.on("data", chunk => { response += chunk; });
    if (first === "client") {
      client.write("ordered "); client.write("request "); client.end("tail");
    } else client.on("end", () => { client.write("ordered "); client.write("request "); client.end("tail"); });
    await once(client,"close");
    await ended.promise;
    assert.equal(received,"ordered request tail");
    assert.equal(response,"final response");
  });
}
