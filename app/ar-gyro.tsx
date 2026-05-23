import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';
import { Component, memo, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { router } from 'expo-router';

import { useGeoData, type GeoPoint } from '@/context/geo-data-context';

// ── Error boundary (catches JS errors so they surface instead of silently crashing) ──
class ArErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error: error?.message || String(error) };
  }
  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <Text style={{ color: '#FF3B30', fontSize: 18, fontWeight: '700', marginBottom: 12, textAlign: 'center' }}>
            Error en AR
          </Text>
          <Text style={{ color: '#fff', fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
            {this.state.error}
          </Text>
          <Pressable
            style={{ marginTop: 24, backgroundColor: '#333', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10 }}
            onPress={() => router.back()}
          >
            <Text style={{ color: '#fff', fontSize: 15 }}>Volver</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

// ── Config ─────────────────────────────────────────────────────────────────────
const FOV_H = 60;
const FOV_V = 80;
const EARTH_RADIUS = 6_371_000;
const EMA = 0.05;
const EMA_SCREEN = 0.12;
const H_BUF = 20;
const P_BUF = 8;

const CARD_W = 148;
const DOT_R = 10;
const STEM_H = 16;
const ABOVE_DOT = 85;

const EDGE_R = 26;         // edge indicator circle radius
const EDGE_MARGIN = 60;    // distance from screen edge for indicator centre

const DEG = Math.PI / 180;
const ANIM = { duration: 120, easing: Easing.out(Easing.quad) } as const;

// ── Geo math ───────────────────────────────────────────────────────────────────
function calcBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = (lon2 - lon1) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

function calcDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function circularMean(angles: number[]): number {
  const s = angles.reduce((a, v) => a + Math.sin(v * DEG), 0) / angles.length;
  const c = angles.reduce((a, v) => a + Math.cos(v * DEG), 0) / angles.length;
  return ((Math.atan2(s, c) / DEG) + 360) % 360;
}

function windowMean(vals: number[]): number {
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function smoothAngle(cur: number, tgt: number, a: number): number {
  let d = tgt - cur;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return cur + a * d;
}

function formatDist(m: number) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function toCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

// ── AR projection ──────────────────────────────────────────────────────────────
type Projected = GeoPoint & { sx: number; sy: number; dist: number };

function computeProjected(
  points: GeoPoint[],
  userLat: number, userLng: number,
  heading: number, pitch: number,
  W: number, H: number,
): Projected[] {
  const hH = FOV_H / 2;
  const hV = FOV_V / 2;
  const result: Projected[] = [];
  for (const p of points) {
    const bearing = calcBearing(userLat, userLng, p.lat, p.lng);
    const dist = calcDistance(userLat, userLng, p.lat, p.lng);
    let relH = bearing - heading;
    if (relH > 180) relH -= 360;
    if (relH < -180) relH += 360;
    if (Math.abs(relH) > hH) continue;
    const relV = -pitch;
    if (Math.abs(relV) > hV) continue;
    const sx = W / 2 + (relH / hH) * (W / 2);
    const sy = H / 2 - (relV / hV) * (H / 2);
    result.push({ ...p, sx, sy, dist });
  }
  return result;
}

// Navigation indicator data (edge arrow when target is off-screen)
type NavData = {
  isOnScreen: boolean;
  dist: number;
  edgeX: number;
  edgeY: number;
  arrowAngle: number; // screen-space degrees: 0=right, 90=down, -90=up, 180=left
};

function computeNavData(
  point: GeoPoint,
  userLat: number, userLng: number,
  heading: number, pitch: number,
  W: number, H: number,
): NavData {
  const bearing = calcBearing(userLat, userLng, point.lat, point.lng);
  const dist = calcDistance(userLat, userLng, point.lat, point.lng);

  let relH = bearing - heading;
  if (relH > 180) relH -= 360;
  if (relH < -180) relH += 360;
  const relV = -pitch;

  const isOnScreen = Math.abs(relH) <= FOV_H / 2 && Math.abs(relV) <= FOV_V / 2;

  // Project to full (unclamped) screen coords to get direction vector
  const rawSx = W / 2 + (relH / (FOV_H / 2)) * (W / 2);
  const rawSy = H / 2 - (relV / (FOV_V / 2)) * (H / 2);

  const dx = rawSx - W / 2;
  const dy = rawSy - H / 2;

  // Angle in screen space (0=right, 90=down, 180=left, -90=up)
  const arrowAngle = Math.atan2(dy, dx) / DEG;

  // Clamp to screen edge
  const halfW = W / 2 - EDGE_MARGIN;
  const halfH = H / 2 - EDGE_MARGIN;
  let edgeX: number, edgeY: number;

  if (isOnScreen || (dx === 0 && dy === 0)) {
    edgeX = rawSx;
    edgeY = rawSy;
  } else if (Math.abs(dx) * halfH >= Math.abs(dy) * halfW) {
    const sign = dx > 0 ? 1 : -1;
    edgeX = W / 2 + sign * halfW;
    edgeY = H / 2 + dy * (halfW / Math.abs(dx));
  } else {
    const sign = dy > 0 ? 1 : -1;
    edgeY = H / 2 + sign * halfH;
    edgeX = W / 2 + dx * (halfH / Math.abs(dy));
  }

  return { isOnScreen, dist, edgeX, edgeY, arrowAngle };
}

// ── ArMarker ───────────────────────────────────────────────────────────────────
type ArMarkerProps = Projected & { isNav: boolean };

const ArMarker = memo(function ArMarker({ sx, sy, color, name, dist, isNav }: ArMarkerProps) {
  const left = useSharedValue(sx - CARD_W / 2);
  const top = useSharedValue(sy - ABOVE_DOT);
  const pulseScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(0);

  // Cancel all in-flight animations on unmount — prevents Reanimated crash
  // when a marker leaves the FOV while an animation is running
  useEffect(() => {
    return () => {
      cancelAnimation(left);
      cancelAnimation(top);
      cancelAnimation(pulseScale);
      cancelAnimation(pulseOpacity);
    };
  }, []);

  useEffect(() => {
    left.value = withTiming(sx - CARD_W / 2, ANIM);
    top.value = withTiming(sy - ABOVE_DOT, ANIM);
  }, [sx, sy]);

  useEffect(() => {
    if (isNav) {
      pulseScale.value = 1;
      pulseOpacity.value = 0.7;
      pulseScale.value = withRepeat(
        withTiming(2.6, { duration: 1400, easing: Easing.out(Easing.exp) }),
        -1,
        false,
      );
      pulseOpacity.value = withRepeat(
        withTiming(0, { duration: 1400, easing: Easing.out(Easing.exp) }),
        -1,
        false,
      );
    } else {
      cancelAnimation(pulseScale);
      cancelAnimation(pulseOpacity);
      pulseScale.value = withTiming(1, { duration: 200 });
      pulseOpacity.value = withTiming(0, { duration: 200 });
    }
  }, [isNav]);

  const markerStyle = useAnimatedStyle(() => ({ left: left.value, top: top.value }));
  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: pulseOpacity.value,
  }));

  return (
    <Animated.View pointerEvents="none" style={[styles.markerRoot, markerStyle]}>
      <View style={styles.card}>
        <View style={[styles.cardAccent, { backgroundColor: color }]} />
        <View style={styles.cardText}>
          {name != null && (
            <Text style={styles.cardName} numberOfLines={1}>{name}</Text>
          )}
          <Text style={[styles.cardDist, name == null && styles.cardDistOnly]}>
            {formatDist(dist)}
          </Text>
        </View>
      </View>
      <View style={[styles.stem, { backgroundColor: color }]} />
      <View style={styles.dotWrap}>
        {/* Pulsing ring for nav target */}
        <Animated.View
          style={[styles.pulseRing, { borderColor: color }, pulseStyle]}
        />
        <View style={[styles.dotGlow, { backgroundColor: color }]} />
        <View style={[styles.dot, { backgroundColor: color, shadowColor: color }]} />
      </View>
    </Animated.View>
  );
});

// ── Edge indicator (target off-screen) ────────────────────────────────────────
const EdgeIndicator = memo(function EdgeIndicator({
  edgeX, edgeY, arrowAngle, color, dist,
}: NavData & { color: string }) {
  const ex = useSharedValue(edgeX);
  const ey = useSharedValue(edgeY);

  useEffect(() => {
    ex.value = withTiming(edgeX, ANIM);
    ey.value = withTiming(edgeY, ANIM);
  }, [edgeX, edgeY]);

  const containerStyle = useAnimatedStyle(() => ({
    left: ex.value - EDGE_R,
    top: ey.value - EDGE_R,
  }));

  // ↑ points up (screen -90°). rotate by (arrowAngle + 90)° to aim at target.
  const arrowRotation = `${arrowAngle + 90}deg`;

  return (
    <Animated.View pointerEvents="none" style={[styles.edgeContainer, containerStyle]}>
      <View style={[styles.edgeCircle, { backgroundColor: color, shadowColor: color }]}>
        <Text style={[styles.edgeArrow, { transform: [{ rotate: arrowRotation }] }]}>
          ↑
        </Text>
      </View>
      <View style={[styles.edgeDistPill, { backgroundColor: color + 'CC' }]}>
        <Text style={styles.edgeDistText}>{formatDist(dist)}</Text>
      </View>
    </Animated.View>
  );
});

// ── Compass HUD ────────────────────────────────────────────────────────────────
function CompassHud({ heading }: { heading: number }) {
  const cardinal = toCardinal(heading);
  return (
    <View style={styles.compassPill} pointerEvents="none">
      <View style={styles.compassRose}>
        <Text style={styles.compassCardinal}>{cardinal}</Text>
      </View>
      <Text style={styles.compassDeg}>{heading}°</Text>
    </View>
  );
}

// ── GPS HUD ────────────────────────────────────────────────────────────────────
function GpsHud({ coords, accuracy }: { coords: { lat: number; lng: number }; accuracy: number | null }) {
  const accColor = accuracy == null ? 'rgba(255,255,255,0.4)'
    : accuracy <= 10 ? '#30D158'
    : accuracy <= 30 ? '#FFD60A'
    : '#FF453A';
  return (
    <View style={styles.gpsPill} pointerEvents="none">
      <Text style={styles.gpsCoords}>
        {coords.lat.toFixed(5)}{'  '}{coords.lng.toFixed(5)}
      </Text>
      <View style={styles.gpsAccRow}>
        <View style={[styles.gpsAccDot, { backgroundColor: accColor }]} />
        <Text style={[styles.gpsAccText, { color: accColor }]}>
          {accuracy != null ? `±${Math.round(accuracy)} m` : 'Sin precisión'}
        </Text>
      </View>
    </View>
  );
}

// ── Guide button ───────────────────────────────────────────────────────────────
function GuideButton({ onPress, active, color }: { onPress: () => void; active: boolean; color: string | null }) {
  return (
    <Pressable style={styles.guideBtn} onPress={onPress}>
      {active && color ? (
        <View style={[styles.guideBtnActiveRing, { borderColor: color }]}>
          <View style={[styles.guideBtnActiveDot, { backgroundColor: color }]} />
        </View>
      ) : (
        // Crosshair icon drawn with Views
        <View style={styles.guideBtnIcon}>
          <View style={styles.crossH} />
          <View style={styles.crossV} />
          <View style={styles.crossCircle} />
        </View>
      )}
    </Pressable>
  );
}

// ── Guide list panel ───────────────────────────────────────────────────────────
type PointWithDist = GeoPoint & { dist: number };

function GuideList({
  points,
  selectedId,
  onSelect,
  onClose,
}: {
  points: PointWithDist[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <View style={styles.listPanel}>
      <View style={styles.listHandle} />
      <View style={styles.listHeader}>
        <Text style={styles.listTitle}>Guía AR</Text>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={styles.listClose}>✕</Text>
        </Pressable>
      </View>
      <Text style={styles.listSubtitle}>Seleccioná un punto para activar la guía</Text>
      <ScrollView style={styles.listScroll} showsVerticalScrollIndicator={false}>
        {points.map((p) => {
          const selected = p.id === selectedId;
          return (
            <Pressable
              key={p.id}
              style={[styles.listRow, selected && styles.listRowSelected]}
              onPress={() => onSelect(p.id)}
            >
              <View style={[styles.listDot, { backgroundColor: p.color }]} />
              <View style={styles.listInfo}>
                <Text style={styles.listName} numberOfLines={1}>
                  {p.name ?? p.id}
                </Text>
                <Text style={styles.listDist}>{formatDist(p.dist)}</Text>
              </View>
              <View style={[styles.radio, selected && { borderColor: p.color }]}>
                {selected && <View style={[styles.radioFill, { backgroundColor: p.color }]} />}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
      {selectedId && (
        <Pressable style={styles.cancelNavBtn} onPress={() => onSelect('')}>
          <Text style={styles.cancelNavText}>Cancelar guía</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── NavBar (bottom strip when nav is active) ───────────────────────────────────
function NavBar({
  point,
  dist,
  isOnScreen,
  onCancel,
}: {
  point: GeoPoint;
  dist: number;
  isOnScreen: boolean;
  onCancel: () => void;
}) {
  return (
    <View style={styles.navBar}>
      <View style={[styles.navDot, { backgroundColor: point.color }]} />
      <View style={styles.navInfo}>
        <Text style={styles.navName} numberOfLines={1}>{point.name ?? point.id}</Text>
        <Text style={styles.navDist}>
          {isOnScreen ? '● En vista  ·  ' : '● Fuera de vista  ·  '}
          {formatDist(dist)}
        </Text>
      </View>
      <Pressable onPress={onCancel} hitSlop={12} style={styles.navCancel}>
        <Text style={styles.navCancelText}>✕</Text>
      </Pressable>
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────
export default function ArScreenWithBoundary() {
  return (
    <ArErrorBoundary>
      <ArScreen />
    </ArErrorBoundary>
  );
}

function ArScreen() {
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [locationGranted, setLocationGranted] = useState<boolean | null>(null);
  const [locationReady, setLocationReady] = useState(false);
  const [projected, setProjected] = useState<Projected[]>([]);
  const [sensorStatus, setSensorStatus] = useState('Iniciando…');
  const [showGuideList, setShowGuideList] = useState(false);
  const [navPointId, setNavPointId] = useState<string | null>(null);
  const [navData, setNavData] = useState<NavData | null>(null);
  const [listPoints, setListPoints] = useState<PointWithDist[]>([]);
  const [compassHeading, setCompassHeading] = useState(0);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);

  const headingBuf = useRef<number[]>([]);
  const pitchBuf = useRef<number[]>([]);
  // Start at 0 so the loop runs immediately — sensors refine the value as they fire
  const headingSmooth = useRef(0);
  const pitchSmooth = useRef(0);
  const smoothPosRef = useRef<Map<string, { sx: number; sy: number }>>(new Map());
  const gyroRateRef = useRef(0); // deg/s from DeviceMotion rotationRate.alpha
  const userLocRef = useRef<{ lat: number; lng: number } | null>(null);
  const pointsRef = useRef<GeoPoint[]>([]);
  const navPointRef = useRef<GeoPoint | null>(null);
  // Tracks best GPS accuracy seen this session — used to filter regressions
  const bestAccuracyRef = useRef<number>(Infinity);

  const { visiblePoints } = useGeoData();
  const { width, height } = useWindowDimensions();

  useEffect(() => { pointsRef.current = visiblePoints; }, [visiblePoints]);

  // Keep navPoint ref in sync
  const navPoint = visiblePoints.find((p) => p.id === navPointId) ?? null;
  useEffect(() => { navPointRef.current = navPoint; }, [navPoint]);

  // Compute list when panel opens
  useEffect(() => {
    if (!showGuideList) return;
    const loc = userLocRef.current;
    const pts = visiblePoints.map((p) => ({
      ...p,
      dist: loc ? calcDistance(loc.lat, loc.lng, p.lat, p.lng) : 0,
    })).sort((a, b) => a.dist - b.dist);
    setListPoints(pts);
  }, [showGuideList, visiblePoints]);

  // Location permission
  useEffect(() => {
    Location.requestForegroundPermissionsAsync()
      .then(({ status }) => setLocationGranted(status === 'granted'))
      .catch(() => setLocationGranted(false));
  }, []);

  // GPS + compass
  useEffect(() => {
    if (!locationGranted) return;

    // Helper: apply position only if it doesn't regress accuracy by more than 50%
    function applyPosition(lat: number, lng: number, accuracy: number | null | undefined) {
      const acc = accuracy ?? Infinity;
      const best = bestAccuracyRef.current;
      // Block readings that are dramatically worse (likely a bad cell-tower fallback)
      if (acc > best * 1.5) return;
      if (acc < best) bestAccuracyRef.current = acc;
      userLocRef.current = { lat, lng };
      setUserCoords({ lat, lng });
      setGpsAccuracy(acc === Infinity ? null : acc);
      const label = acc <= 15 ? 'GPS preciso' : acc <= 40 ? 'GPS listo' : `Adquiriendo satélites…`;
      setSensorStatus(label);
    }

    // Fast initial fix with Balanced so AR starts quickly (High/BestForNavigation can
    // take 30+ seconds to resolve on cold start). The continuous watch refines it.
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
      .then((loc) => {
        applyPosition(loc.coords.latitude, loc.coords.longitude, loc.coords.accuracy);
        setLocationReady(true);
      })
      .catch(() => {
        // Fallback to last known position so AR isn't stuck on loading
        Location.getLastKnownPositionAsync()
          .then((loc) => {
            if (loc) {
              applyPosition(loc.coords.latitude, loc.coords.longitude, loc.coords.accuracy);
              setLocationReady(true);
              setSensorStatus('GPS (caché) — mejorando…');
            } else {
              setSensorStatus('Sin GPS — verificá que el GPS esté activado');
            }
          })
          .catch(() => { setSensorStatus('Error de GPS'); });
      });

    let headingSub: Location.LocationSubscription | null = null;
    let posSub: Location.LocationSubscription | null = null;

    Location.watchHeadingAsync((h) => {
      try {
        const deg = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
        if (!isFinite(deg) || deg < 0) return;
        headingBuf.current.push(deg);
        if (headingBuf.current.length > H_BUF) headingBuf.current.shift();
      } catch { /* ignore bad sensor reading */ }
    }).then((s) => { headingSub = s; }).catch(() => {});

    // High-accuracy continuous watch — refines position as satellite lock improves
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 2, timeInterval: 1500 },
      (loc) => { applyPosition(loc.coords.latitude, loc.coords.longitude, loc.coords.accuracy); },
    ).then((s) => { posSub = s; }).catch(() => {});

    return () => { headingSub?.remove(); posSub?.remove(); };
  }, [locationGranted]);

  // DeviceMotion at 5 Hz (pitch only; Android 12+ enforces 200ms min)
  useEffect(() => {
    let sub: ReturnType<typeof DeviceMotion.addListener> | null = null;
    DeviceMotion.isAvailableAsync()
      .then((available) => {
        if (!available) return;
        try {
          DeviceMotion.setUpdateInterval(200);
          sub = DeviceMotion.addListener((data) => {
            try {
              if (!data?.rotation) return;
              const pitch = 90 - (data.rotation.beta * 180) / Math.PI;
              if (!isFinite(pitch)) return;
              const clamped = Math.max(-89, Math.min(89, pitch));
              pitchBuf.current.push(clamped);
              if (pitchBuf.current.length > P_BUF) pitchBuf.current.shift();
              // Gyroscope rate for complementary filter (deg/s, clamped to avoid glitches)
              // W3C convention: alpha increases CCW → negate so CW = positive heading change
              const rate = data.rotationRate?.alpha ?? 0;
              if (isFinite(rate) && rate !== 0) {
                gyroRateRef.current = Math.max(-500, Math.min(500, -rate));
              }
            } catch { /* ignore bad reading */ }
          });
        } catch { /* DeviceMotion setup failed — pitch stays 0 */ }
      })
      .catch(() => { /* isAvailableAsync failed — no pitch */ });
    return () => { sub?.remove(); };
  }, []);

  // 30 fps loop: projection + nav data
  useEffect(() => {
    const loop = setInterval(() => {
      try {
        if (headingBuf.current.length > 0) {
          // Complementary filter: gyroscope handles frame-to-frame smoothness,
          // magnetometer corrects long-term drift (3% per frame ≈ full correction in ~1 s)
          const gyroDelta = gyroRateRef.current * 0.033; // deg/s × 33 ms loop step
          const gyroPredict = headingSmooth.current + gyroDelta;
          headingSmooth.current = smoothAngle(gyroPredict, circularMean(headingBuf.current), 0.03);
        }
        if (pitchBuf.current.length > 1)
          pitchSmooth.current += EMA * (windowMean(pitchBuf.current) - pitchSmooth.current);

        const loc = userLocRef.current;
        if (!loc) return;

        const h = headingSmooth.current;
        const p = pitchSmooth.current;

        const raw = pointsRef.current.length > 0
          ? computeProjected(pointsRef.current, loc.lat, loc.lng, h, p, width, height)
          : [];

        // Screen-space EMA: smooth (sx, sy) per point to eliminate residual pixel jitter
        const smoothed = raw.map((pt) => {
          const prev = smoothPosRef.current.get(pt.id);
          if (!prev) {
            smoothPosRef.current.set(pt.id, { sx: pt.sx, sy: pt.sy });
            return pt;
          }
          const sx = prev.sx + EMA_SCREEN * (pt.sx - prev.sx);
          const sy = prev.sy + EMA_SCREEN * (pt.sy - prev.sy);
          smoothPosRef.current.set(pt.id, { sx, sy });
          return { ...pt, sx, sy };
        });
        // Remove entries for points that left the FOV
        const visibleIds = new Set(raw.map((pt) => pt.id));
        for (const id of smoothPosRef.current.keys()) {
          if (!visibleIds.has(id)) smoothPosRef.current.delete(id);
        }

        setProjected(smoothed);

        const np = navPointRef.current;
        setNavData(np ? computeNavData(np, loc.lat, loc.lng, h, p, width, height) : null);
        setCompassHeading(Math.round(headingSmooth.current));
      } catch { /* never let a frame error crash the loop */ }
    }, 33);
    return () => clearInterval(loop);
  }, [width, height]);

  function handleNavSelect(id: string) {
    setNavPointId(id || null);
    setShowGuideList(false);
  }

  // ── Guards ────────────────────────────────────────────────────────────────
  if (!cameraPermission) return <View style={styles.container} />;

  if (!cameraPermission.granted) {
    return (
      <View style={styles.centered}>
        <Text style={styles.permText}>Se necesita acceso a la cámara</Text>
        <Pressable style={styles.permButton} onPress={requestCameraPermission}>
          <Text style={styles.permButtonText}>Permitir cámara</Text>
        </Pressable>
      </View>
    );
  }

  if (locationGranted === false) {
    return (
      <View style={styles.centered}>
        <Text style={styles.permText}>
          Se necesita acceso a la ubicación para posicionar los puntos en AR
        </Text>
        <Pressable style={styles.permButton} onPress={() => Location.requestForegroundPermissionsAsync()}>
          <Text style={styles.permButtonText}>Permitir ubicación</Text>
        </Pressable>
      </View>
    );
  }

  if (cameraError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.permText}>Error de cámara: {cameraError}</Text>
        <Pressable style={styles.permButton} onPress={() => router.back()}>
          <Text style={styles.permButtonText}>Volver</Text>
        </Pressable>
      </View>
    );
  }

  // ── AR view ───────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        onMountError={(e) => setCameraError(e?.message ?? 'No se pudo iniciar la cámara')}
      />

      {/* AR markers */}
      {projected.map((p) => (
        <ArMarker key={p.id} {...p} isNav={p.id === navPointId} />
      ))}

      {/* Edge indicator when nav target is off-screen */}
      {navData && !navData.isOnScreen && navPoint && (
        <EdgeIndicator {...navData} color={navPoint.color} />
      )}

      {(!locationReady || sensorStatus.startsWith('Error') || sensorStatus.startsWith('Sin')) && (
        <View style={styles.statusWrap}>
          <Text style={styles.statusText}>
            {locationReady ? sensorStatus : `📍 ${sensorStatus}`}
          </Text>
        </View>
      )}

      {/* Compass + GPS HUD (top-left) */}
      <CompassHud heading={compassHeading} />
      {userCoords && <GpsHud coords={userCoords} accuracy={gpsAccuracy} />}

      {/* Top controls */}
      <Pressable style={styles.closeBtn} onPress={() => router.back()}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>

      <GuideButton
        onPress={() => setShowGuideList(true)}
        active={navPointId !== null}
        color={navPoint?.color ?? null}
      />

      {/* Nav bar at the bottom */}
      {navPoint && navData && (
        <NavBar
          point={navPoint}
          dist={navData.dist}
          isOnScreen={navData.isOnScreen}
          onCancel={() => setNavPointId(null)}
        />
      )}

      {/* Guide list panel */}
      {showGuideList && (
        <>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setShowGuideList(false)}
          />
          <GuideList
            points={listPoints}
            selectedId={navPointId}
            onSelect={handleNavSelect}
            onClose={() => setShowGuideList(false)}
          />
        </>
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centered: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    gap: 16, backgroundColor: '#f5f5f5', padding: 32,
  },
  permText: { fontSize: 17, color: '#333', textAlign: 'center', lineHeight: 24 },
  permButton: { backgroundColor: '#007AFF', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  permButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  // ── Marker ─────────────────────────────────────────────────────────────────
  markerRoot: { position: 'absolute', width: CARD_W, alignItems: 'center' },
  card: {
    width: CARD_W,
    flexDirection: 'row',
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: 'rgba(12,12,12,0.86)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  cardAccent: { width: 5, alignSelf: 'stretch' },
  cardText: { flex: 1, paddingHorizontal: 11, paddingVertical: 10, gap: 3 },
  cardName: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 0.1 },
  cardDist: { color: 'rgba(255,255,255,0.65)', fontSize: 13 },
  cardDistOnly: { color: '#fff', fontWeight: '600', fontSize: 15 },
  stem: { width: 2.5, height: STEM_H, opacity: 0.75 },
  dotWrap: {
    width: DOT_R * 2 + 14, height: DOT_R * 2 + 14,
    justifyContent: 'center', alignItems: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: DOT_R * 2,
    height: DOT_R * 2,
    borderRadius: DOT_R,
    borderWidth: 2,
  },
  dotGlow: {
    position: 'absolute',
    width: DOT_R * 2 + 14, height: DOT_R * 2 + 14,
    borderRadius: DOT_R + 7, opacity: 0.28,
  },
  dot: {
    width: DOT_R * 2, height: DOT_R * 2, borderRadius: DOT_R,
    borderWidth: 2.5, borderColor: 'rgba(255,255,255,0.92)',
    shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 7, elevation: 6,
  },

  // ── Edge indicator ─────────────────────────────────────────────────────────
  edgeContainer: {
    position: 'absolute',
    alignItems: 'center',
    gap: 5,
  },
  edgeCircle: {
    width: EDGE_R * 2, height: EDGE_R * 2, borderRadius: EDGE_R,
    justifyContent: 'center', alignItems: 'center',
    shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 10, elevation: 6,
  },
  edgeArrow: { color: '#fff', fontSize: 20, fontWeight: '700', lineHeight: 22 },
  edgeDistPill: {
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 8,
  },
  edgeDistText: { color: '#fff', fontSize: 12, fontWeight: '600' },

  // ── Guide button ───────────────────────────────────────────────────────────
  guideBtn: {
    position: 'absolute',
    bottom: 108,
    right: 20,
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3, shadowRadius: 6, elevation: 4,
  },
  guideBtnIcon: { width: 22, height: 22, justifyContent: 'center', alignItems: 'center' },
  crossH: { position: 'absolute', width: 18, height: 2, backgroundColor: '#fff', borderRadius: 1 },
  crossV: { position: 'absolute', width: 2, height: 18, backgroundColor: '#fff', borderRadius: 1 },
  crossCircle: {
    width: 8, height: 8, borderRadius: 4,
    borderWidth: 1.5, borderColor: '#fff',
  },
  guideBtnActiveRing: {
    width: 28, height: 28, borderRadius: 14,
    borderWidth: 2.5,
    justifyContent: 'center', alignItems: 'center',
  },
  guideBtnActiveDot: { width: 10, height: 10, borderRadius: 5 },

  // ── Guide list panel ───────────────────────────────────────────────────────
  listPanel: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    maxHeight: '65%',
    backgroundColor: 'rgba(10,10,10,0.95)',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: 34,
  },
  listHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignSelf: 'center', marginTop: 10, marginBottom: 4,
  },
  listHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 12,
  },
  listTitle: { flex: 1, color: '#fff', fontSize: 18, fontWeight: '700' },
  listClose: { color: 'rgba(255,255,255,0.5)', fontSize: 18, fontWeight: '600' },
  listSubtitle: {
    color: 'rgba(255,255,255,0.45)', fontSize: 13,
    paddingHorizontal: 20, marginBottom: 8,
  },
  listScroll: { maxHeight: 280 },
  listRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.08)',
    gap: 12,
  },
  listRowSelected: { backgroundColor: 'rgba(255,255,255,0.06)' },
  listDot: { width: 12, height: 12, borderRadius: 6, flexShrink: 0 },
  listInfo: { flex: 1 },
  listName: { color: '#fff', fontSize: 15, fontWeight: '500' },
  listDist: { color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 2 },
  radio: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)',
    justifyContent: 'center', alignItems: 'center', flexShrink: 0,
  },
  radioFill: { width: 10, height: 10, borderRadius: 5 },
  cancelNavBtn: {
    marginHorizontal: 20, marginTop: 12,
    paddingVertical: 13, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(255,59,48,0.5)',
    alignItems: 'center',
  },
  cancelNavText: { color: '#FF3B30', fontSize: 15, fontWeight: '600' },

  // ── Nav bar ────────────────────────────────────────────────────────────────
  navBar: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(10,10,10,0.88)',
    paddingHorizontal: 20,
    paddingVertical: 14,
    paddingBottom: 30,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  navDot: { width: 14, height: 14, borderRadius: 7, flexShrink: 0 },
  navInfo: { flex: 1 },
  navName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  navDist: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 },
  navCancel: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center', alignItems: 'center',
  },
  navCancelText: { color: 'rgba(255,255,255,0.7)', fontSize: 14, fontWeight: '600' },

  // ── Compass HUD ────────────────────────────────────────────────────────────
  compassPill: {
    position: 'absolute',
    top: 62,
    left: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.58)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
  },
  compassRose: {
    width: 32, height: 32, borderRadius: 16,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  compassCardinal: { color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
  compassDeg: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '500' },

  // ── GPS HUD ────────────────────────────────────────────────────────────────
  gpsPill: {
    position: 'absolute',
    top: 116,
    left: 20,
    backgroundColor: 'rgba(0,0,0,0.58)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    gap: 4,
  },
  gpsCoords: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.3,
  },
  gpsAccRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  gpsAccDot: { width: 6, height: 6, borderRadius: 3 },
  gpsAccText: { fontSize: 11, fontWeight: '600' },

  // ── Misc ───────────────────────────────────────────────────────────────────
  statusWrap: { position: 'absolute', bottom: 100, alignSelf: 'center' },
  statusText: {
    color: '#fff', backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, fontSize: 14,
  },
  closeBtn: {
    position: 'absolute', top: 60, right: 24,
    backgroundColor: 'rgba(0,0,0,0.5)',
    width: 42, height: 42, borderRadius: 21,
    justifyContent: 'center', alignItems: 'center',
  },
  closeText: { color: '#fff', fontSize: 18, fontWeight: '500' },
});
