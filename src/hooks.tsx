import {
  useMemo,
  Children,
  useState,
  useCallback,
  useContext,
  MutableRefObject,
  useEffect, useRef,
} from 'react'
import { useWindowDimensions } from 'react-native'
import { ContainerRef, RefComponent } from 'react-native-collapsible-tab-view'
import Animated, {
  cancelAnimation,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue,
  withDelay,
  withTiming,
  interpolate,
  Extrapolate,
  runOnJS,
  runOnUI,
  useDerivedValue,
} from 'react-native-reanimated'
import { useDeepCompareMemo } from 'use-deep-compare'

import { Context, TabNameContext } from './Context'
import { IS_IOS, ONE_FRAME_MS, scrollToImpl } from './helpers'
import {
  CollapsibleStyle,
  ContextType,
  TabName,
  TabReactElement,
  TabsWithProps,
  Ref,
} from './types'

export function useContainerRef() {
  return useAnimatedRef<ContainerRef>()
}

export function useAnimatedDynamicRefs(): [
  ContextType['refMap'],
  ContextType['setRef']
] {
  const [map, setMap] = useState<ContextType['refMap']>({})
  const setRef = useCallback(function <T extends RefComponent>(
    key: TabName,
    ref: React.RefObject<T>
  ) {
    setMap((map) => ({ ...map, [key]: ref }))
    return ref
  },
  [])

  return [map, setRef]
}

export function useTabProps<T extends TabName>(
  children: TabReactElement<T>[] | TabReactElement<T>,
  tabType: Function
): [TabsWithProps<T>, T[]] {
  const options = useMemo(() => {
    const tabOptions: TabsWithProps<T> = new Map()
    if (children) {
      Children.forEach(children, (element, index) => {
        if (!element) return

        if (element.type !== tabType)
          throw new Error(
            'Container children must be wrapped in a <Tabs.Tab ... /> component'
          )

        // make sure children is excluded otherwise our props will mutate too much
        const { name, children, ...options } = element.props
        if (tabOptions.has(name))
          throw new Error(`Tab names must be unique, ${name} already exists`)

        tabOptions.set(name, {
          index,
          name,
          ...options,
        })
      })
    }
    return tabOptions
  }, [children, tabType])
  const optionEntries = Array.from(options.entries())
  const optionKeys = Array.from(options.keys())
  const memoizedOptions = useDeepCompareMemo(() => options, [optionEntries])
  const memoizedTabNames = useDeepCompareMemo(() => optionKeys, [optionKeys])
  return [memoizedOptions, memoizedTabNames]
}

/**
 * Hook exposing some useful variables.
 *
 * ```tsx
 * const { focusedTab, ...rest } = useTabsContext()
 * ```
 */
export function useTabsContext(): ContextType<TabName> {
  const c = useContext(Context)
  if (!c) throw new Error('useTabsContext must be inside a Tabs.Container')
  return c
}

/**
 * Access the parent tab screen from any deep component.
 *
 * ```tsx
 * const tabName = useTabNameContext()
 * ```
 */
export function useTabNameContext(): TabName {
  const c = useContext(TabNameContext)
  if (!c) throw new Error('useTabNameContext must be inside a TabNameContext')
  return c
}

/**
 * Hook to access some key styles that make the whole thing work.
 *
 * You can use this to get the progessViewOffset and pass to the refresh control of scroll view.
 */
export function useCollapsibleStyle(): CollapsibleStyle {
  const { headerHeight, tabBarHeight, containerHeight } = useTabsContext()
  const windowWidth = useWindowDimensions().width
  const [containerHeightVal, tabBarHeightVal, headerHeightVal] = [
    useConvertAnimatedToValue(containerHeight),
    useConvertAnimatedToValue(tabBarHeight),
    useConvertAnimatedToValue(headerHeight),
  ]
  return useMemo(
    () => ({
      style: { width: windowWidth },
      contentContainerStyle: {
        minHeight: IS_IOS
          ? (containerHeightVal || 0) - (tabBarHeightVal || 0)
          : (containerHeightVal || 0) + (headerHeightVal || 0),
        paddingTop: IS_IOS
          ? 0
          : (headerHeightVal || 0) + (tabBarHeightVal || 0),
      },
      progressViewOffset: (headerHeightVal || 0) + (tabBarHeightVal || 0),
    }),
    [containerHeightVal, headerHeightVal, tabBarHeightVal, windowWidth]
  )
}

export function useUpdateScrollViewContentSize({ name }: { name: TabName }) {
  const { tabNames, contentHeights } = useTabsContext()
  const setContentHeights = useCallback(
    (name: TabName, height: number) => {
      const tabIndex = tabNames.value.indexOf(name)
      contentHeights.value[tabIndex] = height
      contentHeights.value = [...contentHeights.value]
    },
    [contentHeights, tabNames]
  )

  const scrollContentSizeChange = useCallback(
    (_: number, h: number) => {
      runOnUI(setContentHeights)(name, h)
    },
    [setContentHeights, name]
  )

  return scrollContentSizeChange
}

/**
 * Allows specifying multiple functions to be called in a sequence with the same parameters
 * Useful because we handle some events and need to pass them forward so that the caller can handle them as well
 * @param fns array of functions to call
 * @returns a function that once called will call all passed functions
 */
export function useChainCallback(fns: (Function | undefined)[]) {
  const callAll = useCallback(
    (...args: unknown[]) => {
      fns.forEach((fn) => {
        if (typeof fn === 'function') {
          fn(...args)
        }
      })
    },
    [fns]
  )
  return callAll
}

export function useScroller<T extends RefComponent>() {
  const { contentInset } = useTabsContext()

  const scroller = useCallback(
    (
      ref: Ref<T> | undefined,
      x: number,
      y: number,
      animated: boolean,
      _debugKey: string
    ) => {
      'worklet'
      if (!ref) return
      // console.log(`${_debugKey}, y: ${y}, y adjusted: ${y - contentInset}`)
      scrollToImpl(ref, x, y - contentInset.value, animated)
    },
    [contentInset]
  )

  return scroller
}

export const useScrollHandlerY = (name: TabName, externalScrollY?: Animated.SharedValue<number>) => {
  const {
    accDiffClamp,
    focusedTab,
    snapThreshold,
    revealHeaderOnScroll,
    refMap,
    tabNames,
    index,
    headerHeight,
    contentInset,
    containerHeight,
    scrollYCurrent,
    scrollY,
    isScrolling,
    isGliding,
    oldAccScrollY,
    accScrollY,
    offset,
    headerScrollDistance,
    isSnapping,
    snappingTo,
    contentHeights,
  } = useTabsContext()

  const enabled = useSharedValue(false)

  const enable = useCallback(
    (toggle: boolean) => {
      enabled.value = toggle
    },
    [enabled]
  )

  /**
   * Helper value to track if user is dragging on iOS, because iOS calls
   * onMomentumEnd only after a vigorous swipe. If the user has finished the
   * drag, but the onMomentumEnd has never triggered, we need to manually
   * call it to sync the scenes.
   */
  const afterDrag = useSharedValue(0)

  const tabIndex = useMemo(() => tabNames.value.findIndex((n) => n === name), [
    tabNames,
    name,
  ])

  const scrollTo = useScroller()

  const onMomentumEnd = () => {
    'worklet'
    if (!enabled.value) return

    if (typeof snapThreshold === 'number') {
      if (revealHeaderOnScroll) {
        if (accDiffClamp.value > 0) {
          if (
            scrollYCurrent.value >
            headerScrollDistance.value * snapThreshold
          ) {
            if (
              accDiffClamp.value <=
              headerScrollDistance.value * snapThreshold
            ) {
              // snap down
              isSnapping.value = true
              accDiffClamp.value = withTiming(0, undefined, () => {
                isSnapping.value = false
              })
            } else if (accDiffClamp.value < headerScrollDistance.value) {
              // snap up
              isSnapping.value = true
              accDiffClamp.value = withTiming(
                headerScrollDistance.value,
                undefined,
                () => {
                  isSnapping.value = false
                }
              )

              if (scrollYCurrent.value < headerScrollDistance.value) {
                scrollTo(
                  refMap[name],
                  0,
                  headerScrollDistance.value,
                  true,
                  `[${name}] sticky snap up`
                )
              }
            }
          } else {
            isSnapping.value = true
            accDiffClamp.value = withTiming(0, undefined, () => {
              isSnapping.value = false
            })
          }
        }
      } else {
        if (
          scrollYCurrent.value <=
          headerScrollDistance.value * snapThreshold
        ) {
          // snap down
          snappingTo.value = 0
          scrollTo(refMap[name], 0, 0, true, `[${name}] snap down`)
        } else if (scrollYCurrent.value <= headerScrollDistance.value) {
          // snap up
          snappingTo.value = headerScrollDistance.value
          scrollTo(
            refMap[name],
            0,
            headerScrollDistance.value,
            true,
            `[${name}] snap up`
          )
        }
        isSnapping.value = false
      }
    }
    isGliding.value = false
  }

  const contentHeight = useDerivedValue(() => {
    const tabIndex = tabNames.value.indexOf(name)
    return contentHeights.value[tabIndex] || Number.MAX_VALUE
  }, [])

  const scrollHandler = useAnimatedScrollHandler(
    {
      onScroll: (event) => {
        if (!enabled.value) return

        if (focusedTab.value === name) {
          if (IS_IOS) {
            let { y } = event.contentOffset
            // normalize the value so it starts at 0
            y = y + contentInset.value
            const clampMax =
              contentHeight.value -
              (containerHeight.value || 0) +
              contentInset.value
            // make sure the y value is clamped to the scrollable size (clamps overscrolling)
            scrollYCurrent.value = interpolate(
              y,
              [0, clampMax],
              [0, clampMax],
              Extrapolate.CLAMP
            )
            if (externalScrollY !== undefined) {
              externalScrollY.value = y
            }
          } else {
            const { y } = event.contentOffset
            scrollYCurrent.value = y
            if (externalScrollY !== undefined) {
              externalScrollY.value = y
            }
          }

          scrollY.value[index.value] = scrollYCurrent.value
          oldAccScrollY.value = accScrollY.value
          accScrollY.value = scrollY.value[index.value] + offset.value

          if (!isSnapping.value && revealHeaderOnScroll) {
            const delta = accScrollY.value - oldAccScrollY.value
            const nextValue = accDiffClamp.value + delta
            if (delta > 0) {
              // scrolling down
              accDiffClamp.value = Math.min(
                headerScrollDistance.value,
                nextValue
              )
            } else if (delta < 0) {
              // scrolling up
              accDiffClamp.value = Math.max(0, nextValue)
            }
          }

          isScrolling.value = 1

          // cancel the animation that is setting this back to 0 if we're still scrolling
          cancelAnimation(isScrolling)

          // set it back to 0 after a few frames without active scrolling
          isScrolling.value = withDelay(
            ONE_FRAME_MS * 3,
            withTiming(0, { duration: 0 })
          )
        }
      },
      onBeginDrag: () => {
        if (!enabled.value) return

        // ensure the header stops snapping
        cancelAnimation(accDiffClamp)

        isSnapping.value = false
        isScrolling.value = 0
        isGliding.value = false

        if (IS_IOS) cancelAnimation(afterDrag)
      },
      onEndDrag: () => {
        if (!enabled.value) return

        isGliding.value = true

        if (IS_IOS) {
          // we delay this by one frame so that onMomentumBegin may fire on iOS
          afterDrag.value = withDelay(
            ONE_FRAME_MS,
            withTiming(0, { duration: 0 }, (isFinished) => {
              // if the animation is finished, the onMomentumBegin has
              // never started, so we need to manually trigger the onMomentumEnd
              // to make sure we snap
              if (isFinished) {
                isGliding.value = false
                onMomentumEnd()
              }
            })
          )
        }
      },
      onMomentumBegin: () => {
        if (!enabled.value) return

        if (IS_IOS) {
          cancelAnimation(afterDrag)
        }
      },
      onMomentumEnd,
    },
    [
      refMap,
      name,
      revealHeaderOnScroll,
      containerHeight,
      contentInset,
      snapThreshold,
      enabled,
      scrollTo,
      externalScrollY,
    ]
  )

  // sync unfocused scenes
  useAnimatedReaction(
    () => {
      return (
        !isSnapping.value &&
        !isScrolling.value &&
        !isGliding.value &&
        enabled.value
      )
    },
    (sync) => {
      if (sync && focusedTab.value !== name) {
        let nextPosition = null
        const focusedScrollY = scrollY.value[index.value]
        const tabScrollY = scrollY.value[tabIndex]
        const areEqual = focusedScrollY === tabScrollY

        if (!areEqual) {
          const currIsOnTop = tabScrollY <= headerScrollDistance.value + 1
          const focusedIsOnTop =
            focusedScrollY <= headerScrollDistance.value + 1

          if (revealHeaderOnScroll) {
            const hasGap = accDiffClamp.value > tabScrollY
            if (hasGap || currIsOnTop) {
              nextPosition = accDiffClamp.value
            }
          } else if (typeof snapThreshold === 'number') {
            if (focusedIsOnTop) {
              nextPosition = snappingTo.value
            } else if (currIsOnTop) {
              nextPosition = headerHeight.value || 0
            }
          } else if (currIsOnTop || focusedIsOnTop) {
            nextPosition = Math.min(focusedScrollY, headerScrollDistance.value)
          }
        }

        if (nextPosition !== null) {
          scrollY.value[tabIndex] = nextPosition
          scrollTo(refMap[name], 0, nextPosition, false, `[${name}] sync pane`)
        }
      }
    },
    [revealHeaderOnScroll, refMap, snapThreshold, tabIndex, enabled, scrollTo]
  )

  return { scrollHandler, enable }
}

type ForwardRefType<T> =
  | ((instance: T | null) => void)
  | MutableRefObject<T | null>
  | null

/**
 * Magic hook that creates a multicast ref. Useful so that we can both capture the ref, and forward it to callers.
 * Accepts a parameter for an outer ref that will also be updated to the same ref
 * @param outerRef the outer ref that needs to be updated
 * @returns an animated ref
 */
export function useSharedAnimatedRef<T extends RefComponent>(
  outerRef: ForwardRefType<T>
) {
  const ref = useAnimatedRef<T>()

  // this executes on every render
  useEffect(() => {
    if (!outerRef) {
      return
    }
    if (typeof outerRef === 'function') {
      outerRef(ref.current)
    } else {
      outerRef.current = ref.current
    }
  })

  return ref
}

export function useAfterMountEffect(effect: React.EffectCallback) {
  const [didExecute, setDidExecute] = useState(false)
  useEffect(() => {
    if (didExecute) return

    const timeout = setTimeout(() => {
      effect()
      setDidExecute(true)
    }, 0)
    return () => {
      clearTimeout(timeout)
    }
  }, [didExecute, effect])
}

export function useDebounce(value: any, delay: number) {
  // State and setters for debounced value
  const [debouncedValue, setDebouncedValue] = useState(value)
  useEffect(
    () => {
      // Update debounced value after delay
      const handler = setTimeout(() => {
        setDebouncedValue(value)
      }, delay)
      // Cancel the timeout if value changes (also on delay change or unmount)
      // This is how we prevent debounced value from updating if value is changed ...
      // .. within the delay period. Timeout gets cleared and restarted.
      return () => {
        clearTimeout(handler)
      }
    },
    [value, delay] // Only re-call effect if value or delay changes
  )
  return debouncedValue
}

export function useConvertAnimatedToValue<T>(
  animatedValue: Animated.SharedValue<T>,
  debounceTime: number = 0
) {
  const [value, setValue] = useState(animatedValue.value)
  const debounced = useDebounce(value, debounceTime)

  useAnimatedReaction(
    () => {
      return animatedValue.value
    },
    (animValue) => {
      if (animValue !== value) {
        runOnJS(setValue)(animValue)
      }
    },
    [value]
  )

  return debounceTime === 0 ? value : debounced
}

interface HeaderMeasurements {
  /**
   * Animated value that represents the current Y translation of the header
   */
  top: Animated.SharedValue<number>
  /**
   * The height of the header
   */
  height: number
}

export function useHeaderMeasurements(): HeaderMeasurements {
  const { headerTranslateY, headerHeight } = useTabsContext()
  return {
    top: headerTranslateY,
    height: headerHeight.value || 0,
  }
}

/**
 * Returns the currently focused tab name
 */
export function useFocusedTab() {
  const { focusedTab } = useTabsContext()
  return useConvertAnimatedToValue(focusedTab, 50)
}

/**
 * Returns an animated value representing the current tab index, as a floating point number
 */
export function useAnimatedTabIndex() {
  const { indexDecimal } = useTabsContext()
  return indexDecimal
}
