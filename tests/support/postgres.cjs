const assert = require("node:assert/strict");
const net = require("node:net");
const tls = require("node:tls");
const { spawn } = require("node:child_process");
function int16(n) {
  const value = Buffer.alloc(2);
  value.writeInt16BE(n);
  return value;
}
function int32(n) {
  const value = Buffer.alloc(4);
  value.writeInt32BE(n);
  return value;
}
function frame(type, data) {
  return Buffer.concat([Buffer.from(type), int32(data.length + 4), data]);
}
const ready = () => frame("Z", Buffer.from("I"));

// Сервер воспроизводит PostgreSQL wire protocol, а не заменяет pg.Client заглушкой.
async function fixture(
  t,
  {
    stall = false,
    secureContext,
    reject = false,
    errorMessage = "password authentication failed",
  } = {},
) {
  const sockets = new Set();
  const state = {
    connections: 0,
    queries: [],
    startup: [],
    passwords: [],
    args: [],
    children: [],
    reject,
    errorMessage,
  };
  function attach(socket) {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (stall) return;
    let pending = Buffer.alloc(0),
      startup = true;
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      // Каждый проход извлекает одно сообщение; неполный фрагмент остаётся до следующего data.
      while (pending.length >= (startup ? 4 : 5)) {
        const length = pending.readInt32BE(startup ? 0 : 1),
          total = length + (startup ? 0 : 1);
        if (pending.length < total) return;
        const packet = pending.subarray(0, total);
        pending = pending.subarray(total);
        if (startup) {
          if (length === 8 && packet.readInt32BE(4) === 80877103) {
            if (secureContext) {
              socket.removeAllListeners("data");
              socket.write("S");
              attach(
                new tls.TLSSocket(socket, { isServer: true, secureContext }),
              );
              return;
            }
            socket.write("N");
            continue;
          }
          state.startup.push(packet.subarray(8).toString("utf8"));
          startup = false;
          socket.write(frame("R", int32(3)));
        } else if (packet[0] === 112) {
          state.passwords.push(packet.subarray(5, -1).toString("utf8"));
          if (state.reject) {
            socket.end(
              frame(
                "E",
                Buffer.from(`SFATAL\0C28P01\0M${state.errorMessage}\0\0`),
              ),
            );
            return;
          }
          socket.write(Buffer.concat([frame("R", int32(0)), ready()]));
        } else if (packet[0] === 81) {
          state.queries.push(packet.subarray(5, -1).toString("utf8"));
          const fields = [
            ["database", 25],
            ["username", 25],
            ["version", 25],
            ["address", 25],
            ["port", 23],
            ["ssl", 16],
          ];
          const descriptions = fields.map(([name, oid]) =>
            Buffer.concat([
              Buffer.from(name + "\0"),
              int32(0),
              int16(0),
              int32(oid),
              int16(-1),
              int32(-1),
              int16(0),
            ]),
          );
          const values = [
            "abis",
            "migration",
            "16.4",
            "10.0.0.5",
            "5432",
            socket.encrypted ? "t" : "f",
          ].map((value) =>
            Buffer.concat([
              int32(Buffer.byteLength(value)),
              Buffer.from(value),
            ]),
          );
          socket.write(
            Buffer.concat([
              frame("T", Buffer.concat([int16(6), ...descriptions])),
              frame("D", Buffer.concat([int16(6), ...values])),
              frame("C", Buffer.from("SELECT 1\0")),
              ready(),
            ]),
          );
        } else if (packet[0] === 88) socket.end();
      }
    });
  }
  const server = net.createServer((socket) => {
    state.connections++;
    attach(socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const child of state.children) child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  state.port = server.address().port;
  state.spawnProcess = (file, args, options) => {
    assert.equal(file, "/usr/bin/ssh");
    assert.equal(options.shell, false);
    state.args.push(args);
    // В тесте OpenSSH заменён только TCP-мостом: настоящие pg и Duplex проходят весь протокол.
    const script = `const s=require('net').connect(${server.address().port},'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',e=>{process.stderr.write(e.message);process.exit(1)});s.on('close',()=>process.exit(0));`;
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    state.children.push(child);
    return child;
  };
  return state;
}

module.exports = { fixture };
