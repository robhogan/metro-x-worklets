import React, { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { runOnUI, runOnJS, isBundleModeEnabled } from 'react-native-worklets';

import { clamp, SPRING } from './src/mathWorklets';

const STEP = 60;
const MAX_OFFSET = 240;

function App(): React.JSX.Element {
  const offset = useSharedValue(0);
  const [lastUiValue, setLastUiValue] = useState<number | null>(null);

  const boxStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: offset.value },
      { rotate: `${(offset.value / MAX_OFFSET) * 180}deg` },
    ],
  }));

  const nudge = (direction: 1 | -1) => {
    offset.value = withSpring(
      clamp(offset.value + direction * STEP, 0, MAX_OFFSET),
      SPRING
    );
  };

  const readFromUi = () => {
    runOnUI(() => {
      'worklet';
      const rounded = Math.round(offset.value);
      runOnJS(setLastUiValue)(rounded);
    })();
  };

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>Worklets Bundle Mode × Metro</Text>
      <Text style={styles.subtitle}>
        bundle mode: {String(isBundleModeEnabled())}
      </Text>
      <Animated.View style={[styles.box, boxStyle]} />
      <View style={styles.row}>
        <Pressable style={styles.button} onPress={() => nudge(-1)}>
          <Text style={styles.buttonText}>Left</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => nudge(1)}>
          <Text style={styles.buttonText}>Right</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={readFromUi}>
          <Text style={styles.buttonText}>Read on UI</Text>
        </Pressable>
      </View>
      <Text style={styles.subtitle}>
        last UI read: {lastUiValue === null ? '-' : lastUiValue}
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 },
  title: { fontSize: 20, fontWeight: '600' },
  subtitle: { fontSize: 14, opacity: 0.7 },
  box: { width: 64, height: 64, borderRadius: 12, backgroundColor: '#5b8def' },
  row: { flexDirection: 'row', gap: 12 },
  button: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#222',
  },
  buttonText: { color: 'white', fontWeight: '600' },
});

export default App;
