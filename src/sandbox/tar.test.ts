import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { extract, type Header, pack } from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxPathError } from './errors.js';
import {
  packRepo,
  packSingleFile,
  parseGitLsFiles,
  readGitExecutableBits,
  readSingleFileFromArchive,
  writeCopiedOutFile,
} from './tar.js';

const owner = { uid: 1000, gid: 1000 };

interface TarEntry {
  name: string;
  type: Header['type'];
  mode: number;
  uid: number;
  gid: number;
  content: string;
}

/** Reads a whole tar stream into plain objects, so tests can assert on the entries. */
async function readEntries(archive: NodeJS.ReadableStream): Promise<TarEntry[]> {
  const extractor = extract();
  archive.pipe(extractor as unknown as NodeJS.WritableStream);

  const entries: TarEntry[] = [];
  for await (const entry of extractor) {
    const chunks: Buffer[] = [];
    for await (const chunk of entry as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const { name, type, mode, uid, gid } = entry.header;
    entries.push({ name, type, mode, uid, gid, content: Buffer.concat(chunks).toString('utf8') });
  }
  return entries;
}

type ArchiveEntries = Array<{ header: Partial<Header> & { name: string }; body?: string }>;

/** Builds a tar in memory, the way a hostile container might hand one back. */
async function archiveBytes(entries: ArchiveEntries): Promise<Buffer> {
  const archive = pack();
  for (const { header, body } of entries) {
    archive.entry(header, body ?? '');
  }
  archive.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of archive as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The same tar, as the stream Docker would hand over. */
async function buildArchive(entries: ArchiveEntries): Promise<Readable> {
  return Readable.from([await archiveBytes(entries)]);
}

describe('packRepo', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'upgrade-agent-tar-'));
    mkdirSync(join(repoDir, 'src'));
    mkdirSync(join(repoDir, 'scripts'));
    mkdirSync(join(repoDir, '.git'));
    mkdirSync(join(repoDir, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), '{"name":"demo"}');
    writeFileSync(join(repoDir, 'src', 'index.js'), 'export const a = 1;\n');
    writeFileSync(join(repoDir, 'scripts', 'test.sh'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(repoDir, '.git', 'config'), '[core]\n');
    writeFileSync(join(repoDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('packs the repo files and skips .git and node_modules', async () => {
    const entries = await readEntries(packRepo(repoDir, { owner }));
    const names = entries.map((entry) => entry.name);

    expect(names).toContain('package.json');
    expect(names).toContain('src/index.js');
    expect(names).toContain('scripts/test.sh');
    expect(names.some((name) => name.startsWith('.git'))).toBe(false);
    expect(names.some((name) => name.startsWith('node_modules'))).toBe(false);
  });

  it('gives every entry to the container user', async () => {
    const entries = await readEntries(packRepo(repoDir, { owner: { uid: 1234, gid: 5678 } }));

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.uid, entry.name).toBe(1234);
      expect(entry.gid, entry.name).toBe(5678);
    }
  });

  it('forces fixed file modes and restores the executable bit', async () => {
    const entries = await readEntries(
      packRepo(repoDir, { owner, executables: new Set(['scripts/test.sh']) }),
    );
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    expect(byName.get('scripts/test.sh')?.mode).toBe(0o755);
    expect(byName.get('package.json')?.mode).toBe(0o644);
    expect(byName.get('src')?.mode).toBe(0o755);
  });

  it('keeps file contents byte for byte', async () => {
    const entries = await readEntries(packRepo(repoDir, { owner }));
    const packageJson = entries.find((entry) => entry.name === 'package.json');

    expect(packageJson?.content).toBe('{"name":"demo"}');
  });
});

describe('packSingleFile', () => {
  it('round-trips through readSingleFileFromArchive', async () => {
    const content = 'const quote = "it\'s `fine`";\n';
    const chunks: Buffer[] = [];
    for await (const chunk of packSingleFile('src/a.js', content, owner) as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const archive = Readable.from([Buffer.concat(chunks)]);

    const read = await readSingleFileFromArchive(archive, 'src/a.js');
    expect(read.toString('utf8')).toBe(content);
  });
});

describe('readSingleFileFromArchive', () => {
  it('returns the contents of the requested file', async () => {
    const archive = await buildArchive([
      { header: { name: 'package.json', type: 'file' }, body: '{"name":"demo"}' },
    ]);

    const contents = await readSingleFileFromArchive(archive, 'package.json');
    expect(contents.toString('utf8')).toBe('{"name":"demo"}');
  });

  it('refuses a symlink, however tempting its target', async () => {
    const archive = await buildArchive([
      { header: { name: 'package.json', type: 'symlink', linkname: '/etc/passwd' } },
    ]);

    await expect(readSingleFileFromArchive(archive, 'package.json')).rejects.toThrow(
      /it is a symlink, not a file/,
    );
  });

  it('refuses a directory', async () => {
    const archive = await buildArchive([{ header: { name: 'src', type: 'directory' } }]);

    await expect(readSingleFileFromArchive(archive, 'src')).rejects.toThrow(SandboxPathError);
  });

  it('refuses an entry under a different name than the one requested', async () => {
    const archive = await buildArchive([
      { header: { name: '../../.git/hooks/pre-commit', type: 'file' }, body: 'rm -rf /' },
    ]);

    await expect(readSingleFileFromArchive(archive, 'package.json')).rejects.toThrow(
      /expected exactly "package.json"/,
    );
  });

  it('refuses an archive holding more than the one file', async () => {
    const archive = await buildArchive([
      { header: { name: 'package.json', type: 'file' }, body: '{}' },
      { header: { name: 'package.json', type: 'file' }, body: 'second' },
    ]);

    await expect(readSingleFileFromArchive(archive, 'package.json')).rejects.toThrow(
      /more than one entry/,
    );
  });

  it('refuses a file over the size cap', async () => {
    const archive = await buildArchive([
      { header: { name: 'big.json', type: 'file' }, body: 'x'.repeat(1000) },
    ]);

    await expect(readSingleFileFromArchive(archive, 'big.json', 100)).rejects.toThrow(
      /over the 100 byte limit/,
    );
  });

  it('fails, rather than hanging, when the connection drops halfway', async () => {
    const bytes = await archiveBytes([
      { header: { name: 'package.json', type: 'file' }, body: 'x'.repeat(2000) },
    ]);
    // The header and part of the body arrive, then the socket dies.
    const archive = new Readable({ read() {} });
    archive.push(bytes.subarray(0, 1000));
    setImmediate(() => archive.destroy(new Error('socket hang up')));

    await expect(readSingleFileFromArchive(archive, 'package.json')).rejects.toThrow(
      /could not read "package\.json" from the sandbox: socket hang up/,
    );
  });
});

describe('writeCopiedOutFile', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'upgrade-agent-dest-'));
    outside = mkdtempSync(join(tmpdir(), 'upgrade-agent-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('writes the file, creating the folders on the way', async () => {
    const written = await writeCopiedOutFile(root, 'src/lib/index.js', Buffer.from('ok'));

    expect(written).toBe(join(root, 'src', 'lib', 'index.js'));
    expect(readFileSync(written, 'utf8')).toBe('ok');
  });

  it('refuses to follow a symlinked folder out of the destination', async () => {
    // What a cloned repo can contain: `lib` pointing somewhere else entirely.
    // A junction is Windows' folder link and needs no admin rights; on other
    // systems the type is ignored and this is an ordinary symlink.
    symlinkSync(outside, join(root, 'lib'), 'junction');

    await expect(writeCopiedOutFile(root, 'lib/evil.js', Buffer.from('x'))).rejects.toThrow(
      /"lib" is a symlink/,
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses to write onto a symlink at the destination itself', async () => {
    symlinkSync(outside, join(root, 'package.json'), 'junction');

    await expect(writeCopiedOutFile(root, 'package.json', Buffer.from('x'))).rejects.toThrow(
      SandboxPathError,
    );
  });

  it('applies the path rules before touching the disk', async () => {
    await expect(writeCopiedOutFile(root, '../escape.js', Buffer.from('x'))).rejects.toThrow(
      SandboxPathError,
    );
    await expect(writeCopiedOutFile(root, '.', Buffer.from('x'))).rejects.toThrow(SandboxPathError);
  });
});

describe('parseGitLsFiles', () => {
  it('finds the paths git marks executable', () => {
    const stdout = [
      '100644 1111111111111111111111111111111111111111 0\tpackage.json',
      '100755 2222222222222222222222222222222222222222 0\tscripts/test.sh',
      '100755 3333333333333333333333333333333333333333 0\tbin/my tool.sh',
      '120000 4444444444444444444444444444444444444444 0\tlink.js',
    ].join('\0');

    const executables = parseGitLsFiles(stdout);

    expect([...executables].sort()).toEqual(['bin/my tool.sh', 'scripts/test.sh']);
  });

  it('ignores trailing separators and junk lines', () => {
    expect(parseGitLsFiles('').size).toBe(0);
    expect(parseGitLsFiles('\0\0').size).toBe(0);
    expect(parseGitLsFiles('not a real line\0').size).toBe(0);
  });
});

describe('readGitExecutableBits', () => {
  it('returns nothing for a folder that is not a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'upgrade-agent-nogit-'));
    try {
      expect((await readGitExecutableBits(dir)).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
