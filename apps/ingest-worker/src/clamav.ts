import { ScannerUnavailableError, type MalwareScanner } from '@kaki/kb';
import { connect } from 'node:net';

const CHUNK = 64 * 1024;

/** One clamd command over TCP; resolves with the reply up to its NUL (z-commands). */
function clamd(
  cfg: { host: string; port: number; timeoutMs: number },
  command: string,
  body?: Uint8Array,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: cfg.host, port: cfg.port });
    const reply: Buffer[] = [];
    let settled = false;
    const done = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(new ScannerUnavailableError(err.message, { cause: err }));
      else resolve(value!);
    };
    socket.setTimeout(cfg.timeoutMs, () => done(new Error('clamd timed out')));
    socket.on('error', (err) => done(err));
    socket.on('data', (b: Buffer) => {
      reply.push(b);
      const text = Buffer.concat(reply).toString('utf8');
      const end = text.indexOf('\0');
      if (end >= 0) done(null, text.slice(0, end));
    });
    socket.on('end', () => done(null, Buffer.concat(reply).toString('utf8').replace(/\0$/, '')));
    socket.on('connect', () => {
      socket.write(`z${command}\0`);
      if (!body) return;
      // INSTREAM: 4-byte big-endian lengths, then a zero-length chunk (clamd(8)).
      for (let i = 0; i < body.length; i += CHUNK) {
        const chunk = body.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        socket.write(len);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

/**
 * ClamAV's clamd over INSTREAM (FEAT-015 §5.3; local, and ADR-019's fallback). `OK` is
 * clean, `<name> FOUND` infected; any other reply, a timeout or no connection means the
 * scanner can't answer, never clean.
 */
export function clamavScanner(cfg: {
  host: string;
  port: number;
  timeoutMs?: number;
}): MalwareScanner & { healthy(): Promise<boolean> } {
  const conn = { host: cfg.host, port: cfg.port, timeoutMs: cfg.timeoutMs ?? 60_000 };
  return {
    async scan({ bytes }) {
      const reply = (await clamd(conn, 'INSTREAM', bytes)).trim();
      if (reply === 'stream: OK') return { infected: false };
      const found = /^stream: (.+) FOUND$/.exec(reply);
      if (found) return { infected: true, signature: found[1]! };
      throw new ScannerUnavailableError(`clamd answered ${reply.slice(0, 120)}`);
    },
    async healthy() {
      try {
        return (await clamd({ ...conn, timeoutMs: 5_000 }, 'PING')).trim() === 'PONG';
      } catch {
        return false;
      }
    },
  };
}
