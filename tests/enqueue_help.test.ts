import { describe, it, expect } from 'vitest';
import {
  ENQUEUE_EXAMPLES,
  ENQUEUE_USAGE,
  formatEnqueueFlagLines,
  parseEnqueueArgs,
} from '../src/pipeline/enqueue_help.js';

describe('parseEnqueueArgs', () => {
  it('should read a bare issue number', () => {
    expect(parseEnqueueArgs(['47'])).toMatchObject({ issueNumber: 47, force: false, now: false });
  });

  it('should accept a leading hash on the issue number', () => {
    expect(parseEnqueueArgs(['#47']).issueNumber).toBe(47);
  });

  it('should read every flag in one command', () => {
    expect(parseEnqueueArgs(['47', '--now', '--runner', 'agy', '--force'])).toMatchObject({
      issueNumber: 47,
      now: true,
      runner: 'agy',
      force: true,
    });
  });

  it('should accept the short aliases', () => {
    expect(parseEnqueueArgs(['47', '-n', '-r', 'agy', '-f'])).toMatchObject({
      now: true,
      runner: 'agy',
      force: true,
    });
  });

  it('should accept --runner=<name>', () => {
    expect(parseEnqueueArgs(['47', '--runner=agy']).runner).toBe('agy');
  });

  it('should lowercase the runner name', () => {
    expect(parseEnqueueArgs(['47', '--runner', 'AGY']).runner).toBe('agy');
  });

  it('should not read the next flag as the runner name', () => {
    const parsed = parseEnqueueArgs(['47', '--runner', '--force']);
    expect(parsed.runner).toBeUndefined();
    expect(parsed.force).toBe(true);
    expect(parsed.unknownFlags).toEqual(['--runner (missing runner name)']);
  });

  it('should report an unknown flag rather than swallow it', () => {
    expect(parseEnqueueArgs(['47', '--soon']).unknownFlags).toEqual(['--soon']);
  });

  it('should ignore flag order', () => {
    expect(parseEnqueueArgs(['--now', '--runner', 'agy', '47'])).toMatchObject({
      issueNumber: 47,
      now: true,
      runner: 'agy',
    });
  });

  it('should leave the issue number undefined when only flags are given', () => {
    expect(parseEnqueueArgs(['--now']).issueNumber).toBeUndefined();
  });
});

describe('enqueue help text', () => {
  it('should document every flag the parser accepts', () => {
    const documented = formatEnqueueFlagLines().join(' ');
    for (const flag of ['--now', '--runner', '--force']) {
      expect(documented).toContain(flag);
      expect(ENQUEUE_USAGE).toContain(flag);
    }
  });

  it('should only give examples the parser can read', () => {
    for (const example of ENQUEUE_EXAMPLES) {
      const parsed = parseEnqueueArgs(example.split(/\s+/).slice(1));
      expect(parsed.issueNumber).toBeDefined();
      expect(parsed.unknownFlags).toEqual([]);
    }
  });
});
