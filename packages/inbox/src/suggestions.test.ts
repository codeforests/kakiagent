import { describe, expect, it } from 'vitest';
import { normalise } from './suggestions.js';

describe('normalise: what counts as an edit (FEAT-045 D8)', () => {
  it.each([
    ['Our chocolate cake is $48.', 'our chocolate cake is $48'],
    ['Our  chocolate\ncake is $48!!', 'our chocolate cake is $48'],
    ['Our chocolate cake is $48 😊', 'our chocolate cake is $48'],
    ['Our chocolate cake is $48. 👍🏽', 'our chocolate cake is $48'],
    ['  OUR CHOCOLATE CAKE IS $48  ', 'our chocolate cake is $48'],
  ])('%j is the same draft', (sent, expected) => {
    expect(normalise(sent)).toBe(expected);
    expect(normalise(sent)).toBe(normalise('Our chocolate cake is $48.'));
  });

  it.each([
    'Our chocolate cake is $52.',
    'Our vanilla cake is $48.',
    'Our chocolate cake is $48. We deliver too.',
    'Our chocolate cake was $48.',
  ])('%j is an edit', (sent) => {
    expect(normalise(sent)).not.toBe(normalise('Our chocolate cake is $48.'));
  });

  it('keeps Chinese text, dropping only the trailing full stop', () => {
    expect(normalise('巧克力蛋糕 $48。')).toBe('巧克力蛋糕 $48');
  });
});
