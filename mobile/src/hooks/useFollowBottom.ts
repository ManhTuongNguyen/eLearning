/**
 * Follow-the-bottom behavior for growing chat lists (TASK-050;
 * TASK-AUDIT-014 decomposition of the chat screen).
 *
 * Content growth (streamed deltas, optimistic rows) keeps the viewport
 * pinned to the newest message — but only while the user is still reading
 * there. An intentional scroll up detaches the follow behavior and a pill
 * offers the way back down. The near-bottom flag lives in a ref so scroll
 * callbacks never re-render; only the threshold boundary flips the pill.
 */
import {useCallback, useRef, useState} from 'react';
import type {FlatList, NativeScrollEvent, NativeSyntheticEvent} from 'react-native';

import {isNearBottom, STICK_TO_BOTTOM_THRESHOLD_PX} from '../screens/streamingUx';

export function useFollowBottom<ItemT>() {
  const listRef = useRef<FlatList<ItemT> | null>(null);
  const nearBottomRef = useRef(true);
  const [detachedFromBottom, setDetachedFromBottom] = useState(false);

  /** Follow the conversation tail; no-op when the list is not mounted. */
  const stickToBottom = useCallback((animated: boolean) => {
    listRef.current?.scrollToEnd({animated});
  }, []);

  /**
   * Growth keeps the viewport pinned while the user rests near the bottom;
   * an intentional scroll up has already cleared the sticky flag, so growth
   * never yanks the view.
   */
  const handleContentSizeChange = useCallback(() => {
    if (nearBottomRef.current) {
      stickToBottom(false);
    }
  }, [stickToBottom]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
      const near = isNearBottom(
        {
          offsetY: contentOffset.y,
          contentHeight: contentSize.height,
          viewportHeight: layoutMeasurement.height,
        },
        STICK_TO_BOTTOM_THRESHOLD_PX,
      );
      nearBottomRef.current = near;
      setDetachedFromBottom(!near);
    },
    [],
  );

  const jumpToLatest = useCallback(() => {
    nearBottomRef.current = true;
    setDetachedFromBottom(false);
    stickToBottom(true);
  }, [stickToBottom]);

  /** Session switch: re-attach the follow behavior for the fresh list. */
  const resetFollow = useCallback(() => {
    nearBottomRef.current = true;
    setDetachedFromBottom(false);
  }, []);

  return {
    listRef,
    detachedFromBottom,
    stickToBottom,
    handleContentSizeChange,
    handleScroll,
    jumpToLatest,
    resetFollow,
  };
}
