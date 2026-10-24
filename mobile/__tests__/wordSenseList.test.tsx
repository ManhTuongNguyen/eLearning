/**
 * WordSenseList renderer tests.
 *
 * The shared renderer backs Word detail, the practice back cards and the
 * enrichment review cells, so its contract is pinned here: badged sense
 * groups, definitions numbered within the group, examples as quote blocks,
 * tags and relation lines — and the masked, non-selectable recall-front
 * variant that omits anything that could leak the answer.
 */

import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { WordSenseList } from '../src/components/WordSenseList';
import type { WordSense } from '../src/db/types';
import { ThemeProvider } from '../src/theme/ThemeContext';

const SENSES: WordSense[] = [
  {
    partOfSpeech: 'noun',
    synonyms: ['copy', 'duplicate'],
    definitions: [
      {
        definition: 'An exact copy of something.',
        example: 'The painting is a replication of the original.',
        extraExamples: ['Cell replication is fast.'],
        tags: ['formal'],
        synonyms: ['reproduction'],
        antonyms: ['original'],
      },
      { definition: 'A reply by the plaintiff.' },
    ],
  },
  {
    partOfSpeech: 'verb',
    definitions: [{ definition: 'To copy something.' }],
  },
];

async function renderList(element: ReactElement) {
  // RNTL v14 render() is async — every caller awaits.
  return render(<ThemeProvider>{element}</ThemeProvider>);
}

describe('WordSenseList — full variant', () => {
  test('renders one badged group per part of speech, definitions numbered per group', async () => {
    const view = await renderList(<WordSenseList senses={SENSES} />);

    expect(view.getByText('noun')).toBeTruthy();
    expect(view.getByText('verb')).toBeTruthy();
    // The noun group numbers 1., 2.; the verb group restarts at 1.
    expect(view.getAllByText('1.')).toHaveLength(2);
    expect(view.getByText('2.')).toBeTruthy();
  });

  test('renders examples as blocks plus extras, tags and relation lines', async () => {
    const view = await renderList(<WordSenseList senses={SENSES} />);

    expect(view.getByText('The painting is a replication of the original.')).toBeTruthy();
    expect(view.getByText('Cell replication is fast.')).toBeTruthy();
    expect(view.getByText('formal')).toBeTruthy();
    expect(view.getByText('Synonyms: copy, duplicate')).toBeTruthy();
    expect(view.getByText('≈ reproduction')).toBeTruthy();
    expect(view.getByText('≠ original')).toBeTruthy();
  });

  test('every shown text is selectable', async () => {
    const view = await renderList(<WordSenseList senses={SENSES} />);

    expect(view.getByText('noun').props.selectable).toBe(true);
    expect(view.getByText('An exact copy of something.').props.selectable).toBe(true);
    expect(view.getByText('The painting is a replication of the original.').props.selectable).toBe(
      true,
    );
    expect(view.getByText('Synonyms: copy, duplicate').props.selectable).toBe(true);
  });

  test('hides the POS badge when showPosHeader is false (enrich review cells)', async () => {
    const view = await renderList(<WordSenseList senses={[SENSES[0]]} showPosHeader={false} />);

    expect(view.queryByText('noun')).toBeNull();
    expect(view.getByText('An exact copy of something.')).toBeTruthy();
  });
});

describe('WordSenseList — front variant (masked recall card)', () => {
  test('routes every string through renderText and omits relations, tags and extras', async () => {
    const view = await renderList(
      <WordSenseList senses={SENSES} variant="front" renderText={text => `[m:${text}]`} />,
    );

    // Definition and first example are masked…
    expect(view.getByText('[m:An exact copy of something.]')).toBeTruthy();
    expect(view.getByText('[m:The painting is a replication of the original.]')).toBeTruthy();
    // …while anything that could leak the answer is absent: extra examples,
    // tags and the synonym/antonym lines are not rendered on the front.
    expect(view.queryByText('[m:Cell replication is fast.]')).toBeNull();
    expect(view.queryByText('formal')).toBeNull();
    expect(view.queryByText('Synonyms: copy, duplicate')).toBeNull();
  });

  test('front text is not selectable', async () => {
    const view = await renderList(
      <WordSenseList senses={SENSES} variant="front" renderText={text => text} />,
    );

    expect(view.getByText('An exact copy of something.').props.selectable).toBe(false);
  });
});
