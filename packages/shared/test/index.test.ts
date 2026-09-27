import { describe, expect, it } from 'vitest';
import { APP_ID, APP_NAME } from '../src/index';

describe('shared', () => {
  it('exposes app identity', () => {
    expect(APP_NAME).toBe('Céntrate');
    expect(APP_ID).toBe('io.github.imdlodoem23.centrate');
  });
});
