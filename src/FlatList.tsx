import React, { useState } from 'react'
import { FlatList as RNFlatList, FlatListProps } from 'react-native'
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
} from 'react-native-reanimated'

import { AnimatedFlatList, IS_IOS } from './helpers'
import {
  useAfterMountEffect,
  useChainCallback,
  useCollapsibleStyle,
  useScrollHandlerY,
  useSharedAnimatedRef,
  useTabNameContext,
  useTabsContext,
  useUpdateScrollViewContentSize,
} from './hooks'

/**
 * Used as a memo to prevent rerendering too often when the context changes.
 * See: https://github.com/facebook/react/issues/15156#issuecomment-474590693
 */
const FlatListMemo = React.memo(
  React.forwardRef<RNFlatList, React.PropsWithChildren<FlatListProps<unknown>>>(
    (props, passRef) => {
      return (
        <AnimatedFlatList
          // @ts-expect-error reanimated types are broken on ref
          ref={passRef}
          {...props}
        />
      )
    }
  )
)

interface FlatListCustomProps<R> extends FlatListProps<R> {
  externalScrollY?: Animated.SharedValue<number>
}

function FlatListImpl<R>(
  {
    contentContainerStyle,
    style,
    onContentSizeChange,
    externalScrollY,
    refreshControl,
    onEndReachedThreshold,
    onEndReached,
    ...rest
  }: Omit<FlatListCustomProps<R>, 'onScroll'>,
  passRef: React.Ref<RNFlatList>
): React.ReactElement {
  const name = useTabNameContext()
  const {
    containerHeight,
    contentHeights,
    contentInset,
    headerTranslateY,
    index,
    setRef,
    scrollYCurrent,
    tabBarHeight,
  } = useTabsContext()
  const ref = useSharedAnimatedRef<RNFlatList<unknown>>(passRef)
  const [canScroll, setCanScroll] = useState<boolean>(false)

  const { scrollHandler, enable } = useScrollHandlerY(
    name,
    externalScrollY,
    onEndReached,
    onEndReachedThreshold
  )
  useAfterMountEffect(() => {
    // we enable the scroll event after mounting
    // otherwise we get an `onScroll` call with the initial scroll position which can break things
    // enable(true)
  })

  const {
    style: _style,
    contentContainerStyle: _contentContainerStyle,
    progressViewOffset,
  } = useCollapsibleStyle()

  React.useEffect(() => {
    setRef(name, ref)
  }, [name, ref, setRef])

  const scrollContentSizeChange = useUpdateScrollViewContentSize({
    name,
  })

  const scrollContentSizeChangeHandlers = useChainCallback(
    React.useMemo(() => [scrollContentSizeChange, onContentSizeChange], [
      onContentSizeChange,
      scrollContentSizeChange,
    ])
  )

  const memoRefreshControl = React.useMemo(
    () =>
      refreshControl &&
      React.cloneElement(refreshControl, {
        progressViewOffset,
        ...refreshControl.props,
      }),
    [progressViewOffset, refreshControl]
  )
  const memoContentOffset = React.useMemo(
    () => ({
      y: IS_IOS ? -contentInset.value : 0,
      x: 0,
    }),
    [contentInset.value, scrollYCurrent.value]
  )
  const memoContentInset = React.useMemo(() => ({ top: contentInset.value }), [
    contentInset.value,
  ])
  const memoContentContainerStyle = React.useMemo(
    () => [
      _contentContainerStyle,
      // TODO: investigate types
      contentContainerStyle as any,
    ],
    [_contentContainerStyle, contentContainerStyle]
  )
  const memoStyle = React.useMemo(() => [_style, style], [_style, style])

  useAnimatedReaction(
    () => {
      return { y: scrollYCurrent.value, externalY: externalScrollY?.value }
    },
    ({ y, externalY }) => {
      const isContentScrollable =
        contentHeights.value[index.value] + (tabBarHeight.value || 0) >
        (containerHeight.value || 0)
      const newCanScroll =
        (y > 0 || (externalY !== undefined && externalY > 0)) &&
        isContentScrollable
      if (canScroll !== newCanScroll) {
        runOnJS(setCanScroll)(newCanScroll)
        runOnJS(enable)(newCanScroll)
      }
    },
    [canScroll]
  )

  const offsetStyle = useAnimatedStyle(() => {
    return {
      paddingTop: headerTranslateY.value,
    }
  }, [headerTranslateY])

  return (
    // @ts-expect-error typescript complains about `unknown` in the memo, it should be T
    <FlatListMemo
      {...rest}
      ref={ref}
      bouncesZoom={false}
      bounces={false}
      style={[memoStyle, offsetStyle]}
      contentContainerStyle={memoContentContainerStyle}
      progressViewOffset={progressViewOffset}
      onScroll={scrollHandler}
      onContentSizeChange={scrollContentSizeChangeHandlers}
      scrollEventThrottle={16}
      contentInset={memoContentInset}
      contentOffset={memoContentOffset}
      automaticallyAdjustContentInsets={false}
      refreshControl={memoRefreshControl}
      scrollEnabled={rest.scrollEnabled !== false && canScroll}
    />
  )
}

/**
 * Use like a regular FlatList.
 */
export const FlatList = React.forwardRef(FlatListImpl) as <T>(
  p: FlatListCustomProps<T> & {
    ref?: React.Ref<RNFlatList<T>>
  }
) => React.ReactElement
