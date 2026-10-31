import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Platform,
  StyleSheet,
  useWindowDimensions,
} from "react-native";

/** Left-edge only: ordinary horizontal content and vertical scrolling keep ownership. */
export function EdgeBackGesture({
  children,
  enabled,
  routeKey,
  onBack,
}: {
  children: ReactNode;
  enabled: boolean;
  routeKey: string;
  onBack(): void;
}) {
  const { width } = useWindowDimensions();
  const translation = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);
  const latest = useRef({ enabled, routeKey, onBack, width, reduceMotion });
  latest.current = { enabled, routeKey, onBack, width, reduceMotion };
  const gestureRoute = useRef<string | null>(null);
  const finishing = useRef(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (live) setReduceMotion(value);
      })
      .catch(() => {});
    const listener = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      live = false;
      listener.remove();
    };
  }, []);
  useEffect(() => {
    gestureRoute.current = null;
    finishing.current = false;
    translation.stopAnimation();
    translation.setValue(0);
    return () => {
      gestureRoute.current = null;
      translation.stopAnimation();
    };
  }, [routeKey, translation]);
  const pan = useMemo(() => {
    const reset = () => {
      finishing.current = false;
      Animated.timing(translation, {
        toValue: 0,
        duration: latest.current.reduceMotion ? 0 : 180,
        useNativeDriver: true,
      }).start();
    };
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_event, g) =>
        Platform.OS === "ios" &&
        latest.current.enabled &&
        !finishing.current &&
        g.numberActiveTouches === 1 &&
        g.x0 >= 0 &&
        g.x0 <= 28 &&
        g.dx > 8 &&
        g.dx > Math.abs(g.dy) * 1.5,
      onPanResponderGrant: () => {
        translation.stopAnimation();
        gestureRoute.current = latest.current.routeKey;
      },
      onPanResponderMove: (_event, g) => {
        if (
          gestureRoute.current === latest.current.routeKey &&
          !finishing.current
        )
          translation.setValue(
            Math.max(0, Math.min(latest.current.width, g.dx)),
          );
      },
      onPanResponderRelease: (_event, g) => {
        if (
          !latest.current.enabled ||
          gestureRoute.current !== latest.current.routeKey
        ) {
          reset();
          return;
        }
        const complete =
          g.dx >= latest.current.width * 0.3 || (g.dx > 40 && g.vx > 0.5);
        if (!complete) {
          reset();
          return;
        }
        finishing.current = true;
        const captured = gestureRoute.current;
        Animated.timing(translation, {
          toValue: latest.current.width,
          duration: latest.current.reduceMotion ? 0 : 140,
          useNativeDriver: true,
        }).start(({ finished }) => {
          if (
            finished &&
            captured === latest.current.routeKey &&
            latest.current.enabled
          ) {
            gestureRoute.current = null;
            latest.current.onBack();
          }
          translation.setValue(0);
          finishing.current = false;
        });
      },
      onPanResponderTerminate: reset,
      onPanResponderTerminationRequest: () => false,
    });
  }, [translation]);
  return (
    <Animated.View
      style={[styles.screen, { transform: [{ translateX: translation }] }]}
      {...pan.panHandlers}
      onAccessibilityEscape={enabled ? onBack : undefined}
    >
      {children}
    </Animated.View>
  );
}
const styles = StyleSheet.create({ screen: { flex: 1 } });
