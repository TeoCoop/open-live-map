import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';

import { useGeoData, type GeoPoint } from '@/context/geo-data-context';

// ─── Constants ────────────────────────────────────────────────────────────────
const FOV_H = 60;   // horizontal field of view (degrees)
const FOV_V = 80;   // vertical field of view (degrees, portrait mode)
const EARTH_RADIUS = 6_371_000; // metres
const SMOOTH = 0.2; // EMA factor: 0 = frozen, 1 = no smoothing

// ─── Geo math ─────────────────────────────────────────────────────────────────
const r = (d: number) => (d * Math.PI) / 180;

function calcBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = r(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(r(lat2));
  const x = Math.cos(r(lat1)) * Math.sin(r(lat2)) - Math.sin(r(lat1)) * Math.cos(r(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) / r(1)) + 360) % 360;
}

function calcDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = r(lat2 - lat1);
  const dLon = r(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Smooth an angle in degrees handling the 0/360 wraparound
function smoothAngle(current: number, target: number, alpha: number): number {
  let diff = target - current;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return current + alpha * diff;
}

function formatDist(m: number) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

// ─── Projection ───────────────────────────────────────────────────────────────
type Projected = GeoPoint & { sx: number; sy: number; dist: number };

function computeProjected(
  points: GeoPoint[],
  userLat: number,
  userLng: number,
  heading: number, // degrees, 0 = north
  pitch: number,   // degrees, positive = looking up, negative = looking down
  W: number,
  H: number,
): Projected[] {
  const halfH = FOV_H / 2;
  const halfV = FOV_V / 2;
  const result: Projected[] = [];

  for (const p of points) {
    const bearing = calcBearing(userLat, userLng, p.lat, p.lng);
    const dist = calcDistance(userLat, userLng, p.lat, p.lng);

    // ── Horizontal ──────────────────────────────────────────────────────────
    let relH = bearing - heading;
    if (relH > 180) relH -= 360;
    if (relH < -180) relH += 360;
    if (Math.abs(relH) > halfH) continue;

    // ── Vertical ────────────────────────────────────────────────────────────
    // Points are at ground level (elevation 0 = horizon).
    // relV is the angle of the point relative to camera center:
    //   positive = point is above camera center in image space.
    // When camera pitches up (pitch > 0), horizon drops below center → relV = -pitch.
    const relV = -pitch;
    if (Math.abs(relV) > halfV) continue;

    const sx = W / 2 + (relH / halfH) * (W / 2);
    // Y=0 is top of screen; positive relV (point above center) → smaller Y
    const sy = H / 2 - (relV / halfV) * (H / 2);

    result.push({ ...p, sx, sy, dist });
  }
  return result;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function ArScreen() {
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [locationGranted, setLocationGranted] = useState<boolean | null>(null);
  const [locationReady, setLocationReady] = useState(false);
  const [projected, setProjected] = useState<Projected[]>([]);

  // Sensor values in refs → no re-renders on every sensor tick
  const headingRaw = useRef(0);
  const pitchRaw = useRef(0);
  const headingSmooth = useRef<number | null>(null); // null until first reading
  const pitchSmooth = useRef<number | null>(null);
  const userLocRef = useRef<{ lat: number; lng: number } | null>(null);
  const allPointsRef = useRef<GeoPoint[]>([]);

  const { visiblePoints: allPoints } = useGeoData();
  const { width, height } = useWindowDimensions();

  useEffect(() => { allPointsRef.current = allPoints; }, [allPoints]);

  // ── Location permission ────────────────────────────────────────────────────
  useEffect(() => {
    Location.requestForegroundPermissionsAsync().then(({ status }) => {
      setLocationGranted(status === 'granted');
    });
  }, []);

  // ── GPS + compass ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!locationGranted) return;

    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).then((loc) => {
      userLocRef.current = { lat: loc.coords.latitude, lng: loc.coords.longitude };
      setLocationReady(true);
    });

    let headingSub: Location.LocationSubscription | null = null;
    Location.watchHeadingAsync((h) => {
      const deg = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
      headingRaw.current = deg;
      // Seed smooth on first reading to avoid initial sweep
      if (headingSmooth.current === null) headingSmooth.current = deg;
    }).then((sub) => { headingSub = sub; });

    return () => { headingSub?.remove(); };
  }, [locationGranted]);

  // ── DeviceMotion for pitch ─────────────────────────────────────────────────
  useEffect(() => {
    DeviceMotion.setUpdateInterval(50);
    const sub = DeviceMotion.addListener((data) => {
      if (!data.rotation) return;
      // beta (radians): 0 = flat, π/2 = upright portrait (camera horizontal)
      // pitch (degrees): 0 = horizontal, + = looking up, − = looking down
      const betaDeg = (data.rotation.beta * 180) / Math.PI;
      const pitch = 90 - betaDeg;
      pitchRaw.current = pitch;
      if (pitchSmooth.current === null) pitchSmooth.current = pitch;
    });
    return () => sub.remove();
  }, []);

  // ── 30 fps projection loop ─────────────────────────────────────────────────
  useEffect(() => {
    const loop = setInterval(() => {
      if (headingSmooth.current === null || pitchSmooth.current === null) return;

      headingSmooth.current = smoothAngle(headingSmooth.current, headingRaw.current, SMOOTH);
      pitchSmooth.current += SMOOTH * (pitchRaw.current - pitchSmooth.current);

      const loc = userLocRef.current;
      if (!loc || allPointsRef.current.length === 0) { setProjected([]); return; }

      setProjected(
        computeProjected(
          allPointsRef.current,
          loc.lat,
          loc.lng,
          headingSmooth.current,
          pitchSmooth.current,
          width,
          height,
        ),
      );
    }, 33);

    return () => clearInterval(loop);
  }, [width, height]);

  // ─── Render guards ────────────────────────────────────────────────────────
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
        <Pressable
          style={styles.permButton}
          onPress={() => Location.requestForegroundPermissionsAsync()}
        >
          <Text style={styles.permButtonText}>Permitir ubicación</Text>
        </Pressable>
      </View>
    );
  }

  // ─── AR view ──────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <CameraView style={StyleSheet.absoluteFill} facing="back" />

      {projected.map((p) => (
        <View
          key={p.id}
          pointerEvents="none"
          style={[styles.marker, { left: p.sx - MARKER_W / 2, top: p.sy - MARKER_H }]}
        >
          {p.name != null && <Text style={styles.markerName}>{p.name}</Text>}
          <Text style={styles.markerDist}>{formatDist(p.dist)}</Text>
          <View style={[styles.markerDot, { backgroundColor: p.color }]} />
          <View style={styles.markerStem} />
        </View>
      ))}

      {!locationReady && locationGranted && (
        <View style={styles.statusWrap}>
          <Text style={styles.statusText}>Obteniendo ubicación…</Text>
        </View>
      )}

      <Pressable style={styles.closeBtn} onPress={() => router.back()}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const MARKER_W = 80;
const MARKER_H = 60; // total height above the anchor dot

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    backgroundColor: '#f5f5f5',
    padding: 32,
  },
  permText: { fontSize: 17, color: '#333', textAlign: 'center', lineHeight: 24 },
  permButton: { backgroundColor: '#007AFF', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  permButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  marker: {
    position: 'absolute',
    width: MARKER_W,
    alignItems: 'center',
  },
  markerName: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    textAlign: 'center',
    marginBottom: 2,
    maxWidth: MARKER_W,
  },
  markerDist: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '500',
    backgroundColor: 'rgba(0, 122, 255, 0.85)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    textAlign: 'center',
    marginBottom: 6,
  },
  markerDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#FF3B30',
    borderWidth: 2,
    borderColor: '#fff',
  },
  markerStem: {
    width: 2,
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },

  statusWrap: { position: 'absolute', bottom: 100, alignSelf: 'center' },
  statusText: {
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    fontSize: 14,
  },

  closeBtn: {
    position: 'absolute',
    top: 60,
    right: 24,
    backgroundColor: 'rgba(0,0,0,0.5)',
    width: 42,
    height: 42,
    borderRadius: 21,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeText: { color: '#fff', fontSize: 18, fontWeight: '500' },
});
