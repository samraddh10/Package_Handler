import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

/**
 * Bounded capture of a command's output.
 *
 * `npm ci` on a big repo, or a test suite that loops, can print megabytes. We
 * never need all of it: the start says what the command began doing and the end
 * holds the error. So we keep the first 20k characters and the last 40k and
 * count what we dropped in between. The cap is what keeps a runaway command
 * from filling memory, and later keeps a huge failure out of an LLM prompt.
 */
export const DEFAULT_HEAD_CHARS = 20_000;
export const DEFAULT_TAIL_CHARS = 40_000;

export interface CappedOutputOptions {
  headChars?: number;
  tailChars?: number;
}

export class CappedOutput {
  private readonly headChars: number;
  private readonly tailChars: number;
  /** Chunks kept from the beginning, until headChars is full. */
  private readonly head: string[] = [];
  private headLength = 0;
  /** Chunks kept from the end; the oldest are dropped as new output arrives. */
  private readonly tail: string[] = [];
  private tailLength = 0;
  private droppedChars = 0;
  /** Turns bytes into text; it holds back an incomplete UTF-8 character at a chunk boundary. */
  private readonly decoder = new StringDecoder('utf8');
  private flushed = false;

  constructor(options: CappedOutputOptions = {}) {
    this.headChars = options.headChars ?? DEFAULT_HEAD_CHARS;
    this.tailChars = options.tailChars ?? DEFAULT_TAIL_CHARS;
  }

  /** True when output was dropped from the middle. */
  get truncated(): boolean {
    return this.droppedChars > 0;
  }

  write(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.append(text);
  }

  /**
   * The captured text, with terminal escape codes removed. When output was
   * dropped, a marker line says how much. Safe to call more than once.
   */
  text(): string {
    if (!this.flushed) {
      // Release a partial multi-byte character left over from the last chunk.
      this.append(this.decoder.end());
      this.flushed = true;
    }
    const head = this.head.join('');
    const tail = this.tail.join('');
    const body =
      this.droppedChars === 0
        ? head + tail
        : `${head}\n... ${this.droppedChars} characters of output removed ...\n${tail}`;
    return stripVTControlCharacters(body);
  }

  /**
   * A stream that feeds this buffer. Docker gives us the command's output as a
   * stream, and dockerode's demuxStream() wants somewhere to pipe it.
   */
  sink(): Writable {
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.write(chunk);
        callback();
      },
    });
  }

  private append(text: string): void {
    if (text === '') {
      return;
    }
    // Fill the head first; only once it is full does anything land in the tail.
    const headRoom = this.headChars - this.headLength;
    if (headRoom > 0) {
      const forHead = text.slice(0, headRoom);
      this.head.push(forHead);
      this.headLength += forHead.length;
      const rest = text.slice(forHead.length);
      if (rest === '') {
        return;
      }
      text = rest;
    }

    this.tail.push(text);
    this.tailLength += text.length;
    // Drop the oldest tail text, so the tail always holds the most recent output.
    while (this.tailLength > this.tailChars) {
      const excess = this.tailLength - this.tailChars;
      const oldest = this.tail[0] ?? '';
      if (oldest.length <= excess) {
        this.tail.shift();
        this.tailLength -= oldest.length;
        this.droppedChars += oldest.length;
      } else {
        this.tail[0] = oldest.slice(excess);
        this.tailLength -= excess;
        this.droppedChars += excess;
      }
    }
  }
}
