/**
 * Sentence review modal tests (TASK-SENT-010).
 *
 * The modal is the last gate before generated sentences reach the database.
 * These tests pin its contract: every candidate starts kept, every row shows
 * the sentence, meaning and situation, Keep all persists the whole batch,
 * Keep selected persists exactly the toggled rows, the action is unavailable
 * when nothing is selected, and Discard all closes without writing.
 */
import React from 'react';
import {fireEvent, render, waitFor} from '@testing-library/react-native';

import {SentenceReviewModal} from '../src/screens/SentenceReviewModal';
import type {SentenceCandidate} from '../src/serverless/sentenceGeneration';
import {ThemeProvider} from '../src/theme/ThemeContext';

const CANDIDATES: SentenceCandidate[] = [
  {
    sentence: 'Could I get a flat white, please?',
    meaning: 'Order coffee politely.',
    situation: 'At a café in the morning.',
  },
  {
    sentence: 'I will have the same, thanks.',
    meaning: 'Order what they ordered.',
    situation: 'At a restaurant with a friend.',
  },
];

interface RenderOptions {
  candidates?: SentenceCandidate[];
  visible?: boolean;
}

async function renderModal({
  candidates = CANDIDATES,
  visible = true,
}: RenderOptions = {}) {
  const onKeep = jest.fn(async () => {});
  const onClose = jest.fn();
  const view = await render(
    <ThemeProvider>
      <SentenceReviewModal
        visible={visible}
        candidates={candidates}
        onClose={onClose}
        onKeep={onKeep}
      />
    </ThemeProvider>,
  );
  return {view, onKeep, onClose};
}

describe('SentenceReviewModal', () => {
  test('shows every candidate field and keeps everything by default', async () => {
    const {view} = await renderModal();

    expect(view.getByTestId('sentence-review-title')).toHaveTextContent(
      'Review sentences',
    );
    expect(view.getByTestId('sentence-review-count')).toHaveTextContent(
      '2 of 2 kept',
    );
    CANDIDATES.forEach((candidate, index) => {
      expect(view.getByTestId(`sentence-candidate-${index}`)).toBeTruthy();
      expect(view.getByText(candidate.sentence)).toBeTruthy();
      expect(view.getByText(candidate.meaning)).toBeTruthy();
      expect(view.getByText(candidate.situation)).toBeTruthy();
      expect(
        view.getByTestId(`sentence-toggle-${index}`).props.accessibilityState,
      ).toEqual({checked: true});
    });
  });

  test('Keep all passes every candidate and closes', async () => {
    const {view, onKeep, onClose} = await renderModal();

    await fireEvent.press(view.getByTestId('sentence-keep-all'));

    await waitFor(() => {
      expect(onKeep).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(onKeep).toHaveBeenCalledWith(CANDIDATES);
  });

  test('Keep selected passes exactly the toggled rows and closes', async () => {
    const {view, onKeep, onClose} = await renderModal();

    await fireEvent.press(view.getByTestId('sentence-toggle-0'));
    expect(view.getByTestId('sentence-review-count')).toHaveTextContent(
      '1 of 2 kept',
    );

    await fireEvent.press(view.getByTestId('sentence-keep-selected'));

    await waitFor(() => {
      expect(onKeep).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(onKeep).toHaveBeenCalledWith([CANDIDATES[1]]);
  });

  test('Keep selected is disabled when nothing is selected', async () => {
    const {view, onKeep, onClose} = await renderModal();

    await fireEvent.press(view.getByTestId('sentence-toggle-0'));
    await fireEvent.press(view.getByTestId('sentence-toggle-1'));
    expect(view.getByTestId('sentence-review-count')).toHaveTextContent(
      '0 of 2 kept',
    );

    const keepSelected = view.getByTestId('sentence-keep-selected');
    expect(keepSelected.props.accessibilityState?.disabled).toBe(true);

    await fireEvent.press(keepSelected);
    expect(onKeep).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('Discard all closes without persisting anything', async () => {
    const {view, onKeep, onClose} = await renderModal();

    await fireEvent.press(view.getByTestId('sentence-discard-all'));

    expect(onKeep).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('resets every toggle to kept when reopened for a new batch', async () => {
    const {view} = await renderModal();

    await fireEvent.press(view.getByTestId('sentence-toggle-0'));
    expect(view.getByTestId('sentence-review-count')).toHaveTextContent(
      '1 of 2 kept',
    );

    // Closing unmounts the modal contents (visible=false renders null).
    await view.rerender(
      <ThemeProvider>
        <SentenceReviewModal
          visible={false}
          candidates={CANDIDATES}
          onClose={jest.fn()}
          onKeep={jest.fn(async () => {})}
        />
      </ThemeProvider>,
    );
    expect(view.queryByTestId('sentence-review-modal')).toBeFalsy();

    await view.rerender(
      <ThemeProvider>
        <SentenceReviewModal
          visible
          candidates={CANDIDATES}
          onClose={jest.fn()}
          onKeep={jest.fn(async () => {})}
        />
      </ThemeProvider>,
    );
    expect(view.getByTestId('sentence-review-count')).toHaveTextContent(
      '2 of 2 kept',
    );
  });
});
