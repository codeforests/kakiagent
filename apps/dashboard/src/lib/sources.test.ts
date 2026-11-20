import type { Source } from '@kaki/contracts';
import { describe, expect, it } from 'vitest';
import { updatedLabel } from './facts.ts';
import { readyOutcome, sourceTimeline } from './sources.ts';

// FEAT-076 T8: the Source page's timeline steps and ready outcome (technical-design §5.8, D11).
const created = '2026-11-17T02:02:00Z';
const finished = '2026-11-17T02:09:00Z';
const counts = {
  pagesFound: 44,
  pagesIncluded: 38,
  pagesExcluded: 5,
  pagesFailed: 0,
  pagesSkipped: 1,
  pagesExtracted: 18,
  facts: 0,
  factsNeedingReview: 0,
};
const source = (o: Partial<Source> = {}): Source => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'website',
  status: 'processing',
  stage: 'extract',
  name: 'kakibakery.sg',
  url: 'https://kakibakery.sg',
  domain: 'kakibakery.sg',
  subdomains: [],
  pageLimit: 50,
  failure: null,
  retryable: false,
  file: null,
  sheet: null,
  chat: null,
  counts,
  attestedAt: null,
  createdAt: created,
  updatedAt: created,
  finishedAt: null,
  version: 1,
  ...o,
});
const file = {
  name: 'menu.pdf',
  sizeBytes: 1000,
  type: 'pdf' as const,
  ocrPages: 0,
  scannedAt: null,
};
const view = (s: Source) =>
  sourceTimeline(s).steps.map((step) => `${step.label}:${step.state}:${step.caption}`);

describe('sourceTimeline', () => {
  it('follows each kind’s stages, between Added and Finished', () => {
    const labels = (o: Partial<Source>) =>
      sourceTimeline(source({ status: 'queued', stage: null, ...o })).steps.map((s) => s.label);
    expect(labels({})).toEqual(['Added', 'Read pages', 'Find facts', 'Save facts', 'Finished']);
    expect(labels({ kind: 'file', file })).toEqual([
      'Added',
      'Malware check',
      'Read file',
      'Find facts',
      'Save facts',
      'Finished',
    ]);
    expect(labels({ kind: 'chat', file })).toEqual([
      'Added',
      'Malware check',
      'Remove personal data',
      'Find questions',
      'Save facts',
      'Finished',
    ]);
    expect(labels({ kind: 'spreadsheet', file })).toEqual([
      'Added',
      'Malware check',
      'Read file',
      'Map columns',
      'Import rows',
      'Save facts',
      'Finished',
    ]);
  });

  it('marks the stage in progress with how far it is, and announces it', () => {
    const t = sourceTimeline(source());
    expect(view(source())).toEqual([
      `Added:done:${updatedLabel(created)}`,
      'Read pages:done:Done',
      'Find facts:current:In progress · 18 of 38',
      'Save facts:waiting:Waiting',
      'Finished:waiting:Waiting',
    ]);
    expect(t.announce).toBe('Step 3 of 5: Find facts, in progress');
  });

  it('queued before any stage: only Added is done, nothing is announced', () => {
    const s = source({ status: 'queued', stage: null });
    expect(
      view(s)
        .slice(1)
        .every((v) => v.includes(':waiting:')),
    ).toBe(true);
    expect(sourceTimeline(s).announce).toBeUndefined();
  });

  it('says what a stage waits for: a retry, or the owner’s mapping', () => {
    expect(view(source({ status: 'queued', stage: 'extract' }))[2]).toBe(
      'Find facts:current:Waiting to retry',
    );
    const sheet = source({ kind: 'spreadsheet', file, status: 'queued', stage: 'map' });
    expect(view(sheet)[3]).toBe('Map columns:current:Waiting for you');
    // A crawl that hasn't found its first page has no count yet.
    const crawl = source({
      status: 'processing',
      stage: 'crawl',
      counts: { ...counts, pagesFound: 0 },
    });
    expect(view(crawl)[1]).toBe('Read pages:current:In progress');
  });

  it('ready: every stage done and Finished with its time', () => {
    const s = source({ status: 'ready', stage: null, finishedAt: finished });
    expect(view(s).slice(1)).toEqual([
      'Read pages:done:Done',
      'Find facts:done:Done',
      'Save facts:done:Done',
      `Finished:success:${updatedLabel(finished)}`,
    ]);
    expect(sourceTimeline(s).announce).toBeUndefined();
  });

  it('failed: the failing stage stopped, later ones wait, Failed ends it', () => {
    const s = source({
      status: 'failed',
      stage: 'crawl',
      failure: 'site_unreachable',
      updatedAt: finished,
    });
    expect(view(s).slice(1)).toEqual([
      'Read pages:failed:Stopped here',
      'Find facts:waiting:Waiting',
      'Save facts:waiting:Waiting',
      `Failed:failed:${updatedLabel(finished)}`,
    ]);
  });

  it('never uses words the Source page’s E2E checks expect once', () => {
    const all = (['queued', 'processing', 'ready', 'failed'] as const).flatMap((status) =>
      (['website', 'file', 'chat', 'spreadsheet'] as const).flatMap((kind) =>
        view(source({ kind, status, file: kind === 'website' ? null : file })),
      ),
    );
    for (const v of all) expect(v).not.toMatch(/^Ready:|facts found|pages read/i);
  });
});

describe('readyOutcome', () => {
  const ready = (o: Partial<Source['counts']>, more: Partial<Source> = {}) =>
    readyOutcome(source({ status: 'ready', stage: null, counts: { ...counts, ...o }, ...more }));

  it('names what was read and how many facts wait for review', () => {
    expect(ready({ facts: 41, factsNeedingReview: 6 })).toEqual({
      lead: 'Finished reading 38 pages.',
      body: '6 of the 41 facts need your review before your assistant uses them.',
      review: true,
    });
    expect(ready({ facts: 41, factsNeedingReview: 1 })?.body).toBe(
      '1 of the 41 facts needs your review before your assistant uses it.',
    );
    expect(ready({ facts: 3, factsNeedingReview: 3 })?.body).toBe(
      'All 3 facts need your review before your assistant uses them.',
    );
  });

  it('with nothing to review, says the assistant can use them and offers no link', () => {
    expect(ready({ facts: 5, factsNeedingReview: 0 })).toEqual({
      lead: 'Finished reading 38 pages.',
      body: 'Your assistant can use all 5 facts now.',
      review: false,
    });
  });

  it('uses the file’s own unit, and none for an image', () => {
    const slides = { ...file, name: 'deck.pptx', type: 'pptx' as const };
    expect(
      ready({ facts: 2, factsNeedingReview: 2, pagesIncluded: 1 }, { kind: 'file', file: slides })
        ?.lead,
    ).toBe('Finished reading 1 slide.');
    const image = { ...file, name: 'menu.png', type: 'png' as const };
    expect(ready({ facts: 1, factsNeedingReview: 1 }, { kind: 'file', file: image })).toEqual({
      lead: 'Finished reading the image.',
      body: 'Its fact needs your review before your assistant uses it.',
      review: true,
    });
  });

  it('is null unless the source is ready with facts', () => {
    expect(ready({ facts: 0 })).toBeNull();
    expect(readyOutcome(source())).toBeNull();
  });
});
