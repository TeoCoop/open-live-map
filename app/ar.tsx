import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { DeviceMotion } from 'expo-sensors';
import { Component, memo, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import WebView from 'react-native-webview';

import { useGeoData, type GeoPoint } from '@/context/geo-data-context';
import { findMapsForLocation, isSafUri, useSavedMaps } from '@/context/saved-maps-context';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';

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

// ── Mini Map ───────────────────────────────────────────────────────────────────
const MINI_SMALL = 120;
const MINI_LARGE = 240;

function buildMiniMapHtml(lat: number, lng: number, points: GeoPoint[]): string {
  const initialPoints = JSON.stringify(
    points.map((p) => ({ lat: p.lat, lng: p.lng, color: p.color, name: p.name ?? '' })),
  );
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    html,body{margin:0;padding:0;height:100%;background:#1a1a2e;overflow:hidden}
    #map{width:100%;height:100%}
    /* User location icon wrapper */
    .user-wrap{width:60px;height:60px;position:relative}
    /* Direction cone — rotated via JS */
    #user-cone{position:absolute;top:0;left:0;transform-origin:30px 30px;transition:transform 0.15s linear}
    /* Blue dot — always centered, never rotates */
    .user-circle{
      position:absolute;top:50%;left:50%;
      transform:translate(-50%,-50%);
      width:14px;height:14px;border-radius:50%;
      background:#007AFF;border:2.5px solid #fff;
      box-shadow:0 0 0 4px rgba(0,122,255,0.3),0 1px 6px rgba(0,0,0,0.5);
    }
  </style>
</head>
<body>
<div id="map"></div>
<script>
  var map = L.map('map',{
    zoomControl:false,
    attributionControl:false,
    dragging:false,
    touchZoom:false,
    scrollWheelZoom:false,
    doubleClickZoom:false,
    keyboard:false
  }).setView([${lat},${lng}],16);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19,
    errorTileUrl:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  }).addTo(map);

  /* User location icon: SVG cone (rotatable) + blue dot (fixed) */
  /* Cone path: 60° sector pointing UP from center (30,30), radius 26 */
  var userIconHtml=[
    '<div class="user-wrap">',
      '<svg id="user-cone" width="60" height="60" viewBox="0 0 60 60">',
        '<defs>',
          '<radialGradient id="cg" cx="50%" cy="85%" r="90%" fx="50%" fy="85%">',
            '<stop offset="0%" stop-color="#007AFF" stop-opacity="0.55"/>',
            '<stop offset="100%" stop-color="#007AFF" stop-opacity="0.04"/>',
          '</radialGradient>',
        '</defs>',
        '<path d="M30,30 L17,7 A26,26 0 0,1 43,7 Z" fill="url(#cg)" stroke="#007AFF" stroke-width="0.8" stroke-opacity="0.5"/>',
      '</svg>',
      '<div class="user-circle"></div>',
    '</div>'
  ].join('');

  var userIcon=L.divIcon({className:'',html:userIconHtml,iconSize:[60,60],iconAnchor:[30,30]});
  var userMarker=L.marker([${lat},${lng}],{icon:userIcon,interactive:false,zIndexOffset:1000}).addTo(map);

  /* Rotate the cone to match device heading */
  function updateHeading(deg){
    var cone=document.getElementById('user-cone');
    if(cone) cone.style.transform='rotate('+deg+'deg)';
  }

  /* Geo reference points */
  var pointLayers=[];
  function syncPoints(pts){
    pointLayers.forEach(function(l){map.removeLayer(l);});
    pointLayers=[];
    pts.forEach(function(p){
      var m=L.circleMarker([p.lat,p.lng],{
        radius:5,
        fillColor:p.color,
        color:'#fff',
        weight:1.5,
        fillOpacity:0.9,
        interactive:false
      }).addTo(map);
      pointLayers.push(m);
    });
  }
  syncPoints(${initialPoints});

  function handleRNMessage(raw){
    try{
      var msg=JSON.parse(raw);
      if(msg.type==='updateLocation'){
        userMarker.setLatLng([msg.lat,msg.lng]);
        map.setView([msg.lat,msg.lng],16,{animate:false});
      }
      if(msg.type==='syncPoints'){
        syncPoints(msg.points);
      }
      if(msg.type==='updateHeading'){
        updateHeading(msg.heading);
      }
    }catch(e){}
  }
  document.addEventListener('message',function(e){handleRNMessage(e.data);});
  window.addEventListener('message',function(e){handleRNMessage(e.data);});

  // ── Offline basemap (simplified — roads + water only, no fitBounds) ─────────
  var _offChunks=[];
  function receiveChunk(chunk,i,total,isLast){
    _offChunks.push(chunk);
    if(isLast){
      var raw=_offChunks.join('');_offChunks=[];
      setTimeout(function(){loadOfflineData(raw);},30);
    }
  }
  function loadOfflineData(raw){
    if(raw.trimStart().charAt(0)==='{'){
      try{renderGeoJSONMini(JSON.parse(raw));}catch(e){}
    } else {
      renderOSMMini(raw);
    }
  }
  function renderGeoJSONMini(geojson){
    try{
      L.geoJSON(geojson,{
        style:function(){return{color:'#4a90d9',weight:1.5,fillOpacity:0.18,opacity:0.6};},
        pointToLayer:function(){return null;}
      }).addTo(map);
    }catch(e){}
  }
  function renderOSMMini(xml){
    try{
      var parser=new DOMParser();
      var doc=parser.parseFromString(xml,'text/xml');
      if(doc.querySelector('parsererror'))return;
      var nodes=Object.create(null);
      var nodeEls=doc.querySelectorAll('node');
      for(var i=0;i<nodeEls.length;i++){
        var n=nodeEls[i];
        var nlat=parseFloat(n.getAttribute('lat'));
        var nlon=parseFloat(n.getAttribute('lon'));
        if(!isNaN(nlat)&&!isNaN(nlon))nodes[n.getAttribute('id')]=[nlat,nlon];
      }
      var layerWater=L.layerGroup();
      var layerRoad=L.layerGroup();
      var wayEls=doc.querySelectorAll('way');
      for(var w=0;w<wayEls.length;w++){
        var way=wayEls[w];
        var latlngs=[];
        var nds=way.querySelectorAll('nd');
        for(var nd=0;nd<nds.length;nd++){
          var coord=nodes[nds[nd].getAttribute('ref')];
          if(coord)latlngs.push(coord);
        }
        if(latlngs.length<2)continue;
        var tags=Object.create(null);
        var tagEls=way.querySelectorAll('tag');
        for(var t=0;t<tagEls.length;t++)tags[tagEls[t].getAttribute('k')]=tagEls[t].getAttribute('v');
        var isClosed=latlngs.length>2&&latlngs[0][0]===latlngs[latlngs.length-1][0]&&latlngs[0][1]===latlngs[latlngs.length-1][1];
        var hw=tags['highway'];
        if(hw){
          var clr=hw==='motorway'||hw==='trunk'?'#e06020':hw==='primary'?'#e0a020':hw==='secondary'?'#e0c840':'#bbbbbb';
          var wt=hw==='motorway'||hw==='trunk'?2.5:hw==='primary'?2:hw==='secondary'?1.5:1;
          L.polyline(latlngs,{color:clr,weight:wt,opacity:0.7}).addTo(layerRoad);
          continue;
        }
        var ww=tags['waterway'],nat=tags['natural'],lu=tags['landuse'];
        if(ww||nat==='water'||lu==='reservoir'||lu==='basin'){
          if(isClosed)L.polygon(latlngs,{color:'#4a90d9',weight:0.8,fillColor:'#a8d4f5',fillOpacity:0.45,opacity:0.7}).addTo(layerWater);
          else L.polyline(latlngs,{color:'#4a90d9',weight:1.5,opacity:0.7}).addTo(layerWater);
        }
      }
      // No fitBounds — mini-mapa sigue centrado en el usuario
      layerWater.addTo(map);
      layerRoad.addTo(map);
    }catch(e){}
  }
</script>
</body>
</html>`;
}

const MINI_CHUNK_SIZE = 180 * 1024;

type MiniMapArProps = {
  lat: number;
  lng: number;
  heading: number;
  points: GeoPoint[];
  expanded: boolean;
  onToggle: () => void;
  bottomOffset: number;
  offlineContent: string | null;
};

function MiniMapAr({ lat, lng, heading, points, expanded, onToggle, bottomOffset, offlineContent }: MiniMapArProps) {
  const webViewRef = useRef<WebView>(null);
  const [mapHtml] = useState(() => buildMiniMapHtml(lat, lng, points));
  const [miniMapLoaded, setMiniMapLoaded] = useState(false);
  const sizeAnim = useSharedValue(MINI_SMALL);
  const radiusAnim = useSharedValue(14);
  // Track last sent heading to avoid spamming WebView with tiny changes
  const lastHeadingRef = useRef<number>(-999);

  // Animate size on expand/collapse
  useEffect(() => {
    sizeAnim.value = withTiming(expanded ? MINI_LARGE : MINI_SMALL, { duration: 220, easing: Easing.out(Easing.quad) });
    radiusAnim.value = withTiming(expanded ? 16 : 14, { duration: 220, easing: Easing.out(Easing.quad) });
  }, [expanded]);

  // Inject offline map data once mini-map WebView is ready
  useEffect(() => {
    if (!miniMapLoaded || !offlineContent) return;
    (async () => {
      const total = Math.ceil(offlineContent.length / MINI_CHUNK_SIZE);
      for (let i = 0; i < total; i++) {
        const chunk = offlineContent.slice(i * MINI_CHUNK_SIZE, (i + 1) * MINI_CHUNK_SIZE);
        webViewRef.current?.injectJavaScript(
          `receiveChunk(${JSON.stringify(chunk)},${i},${total},${i === total - 1});true;`,
        );
        await new Promise<void>((r) => setTimeout(r, 8));
      }
    })();
  }, [miniMapLoaded, offlineContent]);

  // Update marker position as GPS updates arrive
  useEffect(() => {
    webViewRef.current?.injectJavaScript(
      `handleRNMessage(${JSON.stringify(JSON.stringify({ type: 'updateLocation', lat, lng }))});true;`,
    );
  }, [lat, lng]);

  // Rotate direction cone — skip updates smaller than 2° to avoid WebView spam
  useEffect(() => {
    const prev = lastHeadingRef.current;
    // Correct circular difference (works even when prev starts at -999)
    const diff = ((heading - prev) % 360 + 360) % 360;   // 0–359
    const wrapped = diff > 180 ? 360 - diff : diff;        // 0–180
    if (prev !== -999 && wrapped < 2) return;
    lastHeadingRef.current = heading;
    webViewRef.current?.injectJavaScript(`updateHeading(${heading});true;`);
  }, [heading]);

  // Sync geo points when visibility changes
  useEffect(() => {
    const pts = points.map((p) => ({ lat: p.lat, lng: p.lng, color: p.color, name: p.name ?? '' }));
    webViewRef.current?.injectJavaScript(`syncPoints(${JSON.stringify(pts)});true;`);
  }, [points]);

  const containerStyle = useAnimatedStyle(() => ({
    width: sizeAnim.value,
    height: sizeAnim.value,
    borderRadius: radiusAnim.value,
  }));

  return (
    <Animated.View style={[styles.miniMapContainer, containerStyle, { bottom: bottomOffset }]} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} onPress={onToggle}>
        <WebView
          ref={webViewRef}
          source={{ html: mapHtml }}
          style={styles.miniMapWebView}
          scrollEnabled={false}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          allowUniversalAccessFromFileURLs
          pointerEvents="none"
          onLoad={() => setMiniMapLoaded(true)}
        />
      </Pressable>
      {/* Expand/collapse indicator */}
      <View style={styles.miniMapToggleIcon} pointerEvents="none">
        <Text style={styles.miniMapToggleText}>{expanded ? '⤡' : '⤢'}</Text>
      </View>
    </Animated.View>
  );
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
  const [miniMapExpanded, setMiniMapExpanded] = useState(false);
  const [showPinInput, setShowPinInput] = useState(false);
  const [pinInputLat, setPinInputLat] = useState('');
  const [pinInputLng, setPinInputLng] = useState('');
  const [pinInputName, setPinInputName] = useState('');

  const headingBuf = useRef<number[]>([]);
  const pitchBuf = useRef<number[]>([]);
  // Start at 0 so the loop runs immediately — sensors refine the value as they fire
  const headingSmooth = useRef(0);
  const pitchSmooth = useRef(0);
  const smoothPosRef = useRef<Map<string, { sx: number; sy: number }>>(new Map());
  const userLocRef = useRef<{ lat: number; lng: number } | null>(null);
  const pointsRef = useRef<GeoPoint[]>([]);
  const navPointRef = useRef<GeoPoint | null>(null);
  // Tracks best GPS accuracy seen this session — used to filter regressions
  const bestAccuracyRef = useRef<number>(Infinity);

  const { visiblePoints, addFile, setFileSelection } = useGeoData();
  const { maps } = useSavedMaps();
  const { isConnected } = useNetworkStatus();
  const [offlineMapContent, setOfflineMapContent] = useState<string | null>(null);
  const { width, height } = useWindowDimensions();

  useEffect(() => { pointsRef.current = visiblePoints; }, [visiblePoints]);

  // Load offline map content when device is offline and location is known
  useEffect(() => {
    if (isConnected || !userCoords || offlineMapContent !== null) return;
    const matches = findMapsForLocation(maps, userCoords.lat, userCoords.lng);
    if (matches.length === 0) return;
    const target = matches[0];
    (async () => {
      try {
        const content = isSafUri(target.filePath)
          ? await FileSystem.StorageAccessFramework.readAsStringAsync(target.filePath)
          : await FileSystem.readAsStringAsync(target.filePath);
        setOfflineMapContent(content);
      } catch { /* silencioso — mini-mapa sin basemap */ }
    })();
  }, [isConnected, userCoords, maps]);

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
      // Only reject clear cell-tower fallbacks (accuracy > 300 m = no real GPS lock)
      if (acc > 300) return;
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
      { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 0, timeInterval: 1000 },
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
        // Pure compass heading: smooth the magnetometer buffer with EMA
        if (headingBuf.current.length > 0)
          headingSmooth.current = smoothAngle(headingSmooth.current, circularMean(headingBuf.current), EMA);
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

  function handleAddManualPin() {
    const lat = parseFloat(pinInputLat.replace(',', '.'));
    const lng = parseFloat(pinInputLng.replace(',', '.'));
    if (isNaN(lat) || lat < -90 || lat > 90) return;
    if (isNaN(lng) || lng < -180 || lng > 180) return;
    const id = `ar-pin-${Date.now()}`;
    const name = pinInputName.trim() || `Pin ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    addFile({
      id,
      name,
      points: [{ id: `${id}-0`, lat, lng, name, color: '#FF453A' }],
    });
    setFileSelection(id, true);
    setShowPinInput(false);
    setPinInputLat('');
    setPinInputLng('');
    setPinInputName('');
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

      {/* Pin button — above guide button */}
      <Pressable style={styles.pinBtn} onPress={() => setShowPinInput(true)}>
        <Text style={styles.pinBtnIcon}>📍</Text>
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

      {/* Mini map (bottom-left) — hidden when guide list is open */}
      {userCoords && !showGuideList && (
        <MiniMapAr
          lat={userCoords.lat}
          lng={userCoords.lng}
          heading={compassHeading}
          points={visiblePoints}
          expanded={miniMapExpanded}
          onToggle={() => setMiniMapExpanded((v) => !v)}
          bottomOffset={navPoint && navData ? 96 : 20}
          offlineContent={offlineMapContent}
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

      {/* Manual pin input panel */}
      {showPinInput && (
        <KeyboardAvoidingView
          style={StyleSheet.absoluteFill}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          pointerEvents="box-none"
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setShowPinInput(false)}
          />
          <View style={styles.pinPanel}>
            <View style={styles.pinPanelHandle} />
            <View style={styles.pinPanelHeader}>
              <Text style={styles.pinPanelTitle}>Agregar punto por coordenadas</Text>
              <Pressable onPress={() => setShowPinInput(false)} hitSlop={12}>
                <Text style={styles.pinPanelClose}>✕</Text>
              </Pressable>
            </View>
            <Text style={styles.pinPanelSub}>El punto se mostrará inmediatamente en AR</Text>

            <View style={styles.pinInputRow}>
              <View style={styles.pinInputWrap}>
                <Text style={styles.pinInputLabel}>LATITUD</Text>
                <TextInput
                  style={styles.pinInput}
                  placeholder="-34.60370"
                  placeholderTextColor="rgba(255,255,255,0.2)"
                  keyboardType="numbers-and-punctuation"
                  value={pinInputLat}
                  onChangeText={setPinInputLat}
                  returnKeyType="next"
                  autoFocus
                />
              </View>
              <View style={styles.pinInputWrap}>
                <Text style={styles.pinInputLabel}>LONGITUD</Text>
                <TextInput
                  style={styles.pinInput}
                  placeholder="-58.38160"
                  placeholderTextColor="rgba(255,255,255,0.2)"
                  keyboardType="numbers-and-punctuation"
                  value={pinInputLng}
                  onChangeText={setPinInputLng}
                  returnKeyType="next"
                />
              </View>
            </View>

            <View style={styles.pinInputWrap}>
              <Text style={styles.pinInputLabel}>NOMBRE (opcional)</Text>
              <TextInput
                style={styles.pinInput}
                placeholder="Ej: Sala de reuniones"
                placeholderTextColor="rgba(255,255,255,0.2)"
                value={pinInputName}
                onChangeText={setPinInputName}
                returnKeyType="done"
                onSubmitEditing={handleAddManualPin}
              />
            </View>

            <Pressable
              style={[
                styles.pinConfirmBtn,
                (!pinInputLat || !pinInputLng) && styles.pinConfirmBtnDisabled,
              ]}
              onPress={handleAddManualPin}
              disabled={!pinInputLat || !pinInputLng}
            >
              <Text style={styles.pinConfirmBtnText}>Agregar punto en AR</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Close button — rendered last so it always sits on top of every panel/backdrop */}
      <Pressable style={styles.closeBtn} onPress={() => router.back()}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
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

  // ── Mini map ───────────────────────────────────────────────────────────────
  miniMapContainer: {
    position: 'absolute',
    left: 20,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.28)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 8,
  },
  miniMapWebView: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  miniMapToggleIcon: {
    position: 'absolute',
    top: 5,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  miniMapToggleText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },

  // ── Pin button (above guide) ────────────────────────────────────────────────
  pinBtn: {
    position: 'absolute',
    bottom: 168,   // guideBtn.bottom(108) + guideBtn.height(48) + gap(12)
    right: 20,
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3, shadowRadius: 6, elevation: 4,
  },
  pinBtnIcon: { fontSize: 22 },

  // ── Pin input panel ─────────────────────────────────────────────────────────
  pinPanel: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(10,10,10,0.97)',
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 40,
    gap: 14,
  },
  pinPanelHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignSelf: 'center', marginBottom: 4,
  },
  pinPanelHeader: {
    flexDirection: 'row', alignItems: 'center',
  },
  pinPanelTitle: {
    flex: 1, color: '#fff', fontSize: 17, fontWeight: '700',
  },
  pinPanelClose: {
    color: 'rgba(255,255,255,0.5)', fontSize: 18, fontWeight: '600',
  },
  pinPanelSub: {
    color: 'rgba(255,255,255,0.4)', fontSize: 13,
    marginTop: -6,
  },
  pinInputRow: { flexDirection: 'row', gap: 12 },
  pinInputWrap: { flex: 1, gap: 6 },
  pinInputLabel: {
    fontSize: 10, fontWeight: '700',
    color: 'rgba(255,255,255,0.38)',
    letterSpacing: 0.8,
  },
  pinInput: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 13,
    color: '#fff', fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
  pinConfirmBtn: {
    backgroundColor: '#FF453A',
    paddingVertical: 16, borderRadius: 14,
    alignItems: 'center', marginTop: 4,
  },
  pinConfirmBtnDisabled: {
    backgroundColor: 'rgba(255,69,58,0.25)',
  },
  pinConfirmBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
