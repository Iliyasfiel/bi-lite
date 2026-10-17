import { createInterface, emitKeypressEvents } from 'node:readline';

export type SecretInputWriter = (text: string) => void;

export async function readSecretLine(prompt: string, err: SecretInputWriter): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('当前不是交互终端；请加 --api-key-stdin 从标准输入读取 API key');
  }
  err(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onKeypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        err('\n');
        reject(new Error('已取消'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') {
        cleanup();
        err('\n');
        resolve(value.trim());
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        value = value.slice(0, -1);
        return;
      }
      if (key.ctrl && key.name === 'u') {
        value = '';
        return;
      }
      if (text && !key.ctrl && !key.meta) value += text;
    };
    process.stdin.on('keypress', onKeypress);
  });
}

export async function readSecretFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      input.close();
      resolve(value.trim());
    };
    input.once('line', finish);
    input.once('close', () => finish(''));
  });
}
