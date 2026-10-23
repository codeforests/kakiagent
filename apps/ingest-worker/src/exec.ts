import { spawn } from 'node:child_process';

export class ExecError extends Error {}

/**
 * Runs a binary with bytes on stdin and returns its stdout. A missing binary, a non-zero
 * exit or the timeout throw `ExecError` (stderr is kept out of the message: it can echo
 * file text, NFR-11).
 */
export function run(
  cmd: string,
  args: string[],
  opts: { input?: Uint8Array; timeoutMs: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ExecError(`${cmd} timed out`));
    }, opts.timeoutMs);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ExecError(`${cmd} failed to start`, { cause: err }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new ExecError(`${cmd} exited with ${code}`));
    });
    // A child that exits before reading all of stdin closes the pipe; that's its answer.
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? undefined);
  });
}
