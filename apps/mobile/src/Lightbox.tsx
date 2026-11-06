// Images full screen, as the desktop's Lightbox shows them: swipe between them, pinch or double-tap
// to zoom (a native zoomable scroll view, so it's iOS's own feel), and share or save one. Any
// screen opens it with `openLightbox`; `LightboxHost` at the app's root shows it.
import { Share as ShareIcon, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** An image to show: its URI (https or a data: URL) and, if it has one, its name. */
interface Shot {
  uri: string;
  name?: string;
}

type Open = { shots: Shot[]; index: number };
let show: ((open: Open | undefined) => void) | undefined;

/** Opens `shots` full screen at `index`. */
export const openLightbox = (shots: Shot[], index = 0) => show?.({ shots, index });

function Zoomable({ shot, width, height }: { shot: Shot; width: number; height: number }) {
  const view = useRef<ScrollView>(null);
  const zoomed = useRef(false);
  const lastTap = useRef(0);
  return (
    <ScrollView
      ref={view}
      style={{ width, height }}
      contentContainerStyle={{ width, height }}
      maximumZoomScale={5}
      minimumZoomScale={1}
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      onScroll={(e) => (zoomed.current = e.nativeEvent.zoomScale > 1.01)}
      scrollEventThrottle={64}
    >
      <Pressable
        onPress={() => {
          // A double tap zooms in to 2.5x, or back out.
          const now = Date.now();
          if (now - lastTap.current < 280) {
            view.current?.scrollResponderZoomTo(
              zoomed.current
                ? { x: 0, y: 0, width, height, animated: true }
                : { x: width * 0.3, y: height * 0.3, width: width * 0.4, height: height * 0.4, animated: true },
            );
          }
          lastTap.current = now;
        }}
      >
        <Image
          source={{ uri: shot.uri }}
          style={{ width, height }}
          resizeMode="contain"
          accessibilityLabel={shot.name ?? "Image"}
        />
      </Pressable>
    </ScrollView>
  );
}

export function LightboxHost() {
  const [open, setOpen] = useState<Open>();
  const [index, setIndex] = useState(0);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    show = (next) => {
      setOpen(next);
      setIndex(next?.index ?? 0);
    };
    return () => (show = undefined);
  }, []);
  const shot = open?.shots[index];
  return (
    <Modal visible={!!open} transparent animationType="fade" onRequestClose={() => setOpen(undefined)}>
      <StatusBar barStyle="light-content" />
      <View style={styles.backdrop}>
        {open && (
          <FlatList
            data={open.shots}
            horizontal
            pagingEnabled
            initialScrollIndex={open.index}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
            keyExtractor={(s, i) => `${i}${s.uri.slice(0, 64)}`}
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) =>
              setIndex(Math.round(e.nativeEvent.contentOffset.x / width))
            }
            renderItem={({ item }) => <Zoomable shot={item} width={width} height={height} />}
          />
        )}
        <View style={[styles.bar, { top: insets.top + 6 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
            onPress={() => setOpen(undefined)}
            style={styles.button}
          >
            <X size={20} color="#ffffff" />
          </Pressable>
          <Text numberOfLines={1} style={styles.title}>
            {shot?.name ?? ""}
            {open && open.shots.length > 1 ? `  ${index + 1} of ${open.shots.length}` : ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Share"
            hitSlop={12}
            onPress={() => shot && void Share.share({ url: shot.uri })}
            style={styles.button}
          >
            <ShareIcon size={19} color="#ffffff" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.96)" },
  bar: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  button: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.14)",
  },
  title: { flex: 1, color: "#ffffff", fontSize: 14, textAlign: "center" },
});
