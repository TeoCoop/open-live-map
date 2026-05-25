import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';

import { useGeoData } from '@/context/geo-data-context';
import { findMapsForLocation, isSafUri, useSavedMaps } from '@/context/saved-maps-context';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';

const PIN_COLOR = '#34C759';

type Coord = { lat: number; lng: number };

const CHUNK_SIZE = 180 * 1024;
const BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// ── Leaflet HTML ────────────────────────────────────────────────────────────────
function buildMapHtml(lat: number, lng: number): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    html,body{margin:0;padding:0;height:100%;background:#e8e0d8}
    #map{width:100%;height:100%}
    .user-dot{
      width:16px;height:16px;border-radius:50%;
      background:#007AFF;border:3px solid #fff;
      box-shadow:0 0 0 4px rgba(0,122,255,0.25),0 2px 8px rgba(0,0,0,0.3);
    }
    .pin-wrap{
      width:32px;height:40px;display:flex;flex-direction:column;align-items:center;
    }
    .pin-head{
      width:28px;height:28px;border-radius:50% 50% 50% 0;
      background:${PIN_COLOR};border:3px solid #fff;
      transform:rotate(-45deg);
      box-shadow:0 2px 8px rgba(0,0,0,0.35);
    }
    .pin-tail{
      width:3px;height:10px;background:${PIN_COLOR};opacity:0.7;
      margin-top:-2px;border-radius:0 0 3px 3px;
    }
  </style>
</head>
<body>
<div id="map"></div>
<script>
  var map = L.map('map',{zoomControl:true,attributionControl:true})
             .setView([${lat},${lng}],16);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19,
    errorTileUrl:'${BLANK_TILE}',
    attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  var userIcon = L.divIcon({className:'',html:'<div class="user-dot"></div>',iconSize:[16,16],iconAnchor:[8,8]});
  var userMarker = L.marker([${lat},${lng}],{icon:userIcon,interactive:false,zIndexOffset:1000}).addTo(map);

  var pinIcon = L.divIcon({
    className:'',
    html:'<div class="pin-wrap"><div class="pin-head"></div><div class="pin-tail"></div></div>',
    iconSize:[32,40],iconAnchor:[16,40]
  });
  var pin = null;

  function notifyPin(latlng){
    window.ReactNativeWebView.postMessage(JSON.stringify({type:'pin',lat:latlng.lat,lng:latlng.lng}));
  }

  function placePin(latlng){
    if(!pin){
      pin = L.marker(latlng,{icon:pinIcon,draggable:true}).addTo(map);
      pin.on('dragend',function(){ notifyPin(pin.getLatLng()); });
    } else {
      pin.setLatLng(latlng);
    }
    notifyPin(latlng);
  }

  map.on('click',function(e){ placePin(e.latlng); });

  function handleRNMessage(raw){
    try{
      var msg = JSON.parse(raw);
      if(msg.type==='updateLocation'){ userMarker.setLatLng([msg.lat,msg.lng]); }
      if(msg.type==='goToMyLocation'){
        var ll = userMarker.getLatLng();
        map.setView(ll,17,{animate:true});
        placePin(ll);
      }
    }catch(e){}
  }
  document.addEventListener('message',function(e){handleRNMessage(e.data);});
  window.addEventListener('message',function(e){handleRNMessage(e.data);});

  // ── Offline basemap renderer ────────────────────────────────────────────────
  var _chunks = [];
  function receiveChunk(chunk, i, total, isLast) {
    _chunks.push(chunk);
    if (isLast) {
      var raw = _chunks.join(''); _chunks = [];
      setTimeout(function(){ loadMapData(raw); }, 30);
    }
  }

  function loadMapData(raw) {
    if (raw.trimStart().charAt(0) === '{') {
      try { renderGeoJSON(JSON.parse(raw)); } catch(e){}
    } else {
      renderOSM(raw);
    }
  }

  function renderGeoJSON(geojson) {
    try {
      L.geoJSON(geojson, {
        style: function() { return { color: '#4a90d9', weight: 2, fillOpacity: 0.2 }; },
        pointToLayer: function() { return null; }
      }).addTo(map);
    } catch(e) {}
  }

  function renderOSM(xml) {
    try {
      var parser = new DOMParser();
      var doc = parser.parseFromString(xml, 'text/xml');
      if (doc.querySelector('parsererror')) return;

      var nodes = Object.create(null);
      var nodeEls = doc.querySelectorAll('node');
      for (var i = 0; i < nodeEls.length; i++) {
        var n = nodeEls[i];
        var nlat = parseFloat(n.getAttribute('lat'));
        var nlon = parseFloat(n.getAttribute('lon'));
        if (!isNaN(nlat) && !isNaN(nlon)) nodes[n.getAttribute('id')] = [nlat, nlon];
      }

      var layerGreen    = L.layerGroup();
      var layerWater    = L.layerGroup();
      var layerBuilding = L.layerGroup();
      var layerRoadMin  = L.layerGroup();
      var layerRoadMaj  = L.layerGroup();

      var wayEls = doc.querySelectorAll('way');
      for (var w = 0; w < wayEls.length; w++) {
        var way = wayEls[w];
        var latlngs = [];
        var nds = way.querySelectorAll('nd');
        for (var nd = 0; nd < nds.length; nd++) {
          var coord = nodes[nds[nd].getAttribute('ref')];
          if (coord) latlngs.push(coord);
        }
        if (latlngs.length < 2) continue;

        var tags = Object.create(null);
        var tagEls = way.querySelectorAll('tag');
        for (var t = 0; t < tagEls.length; t++)
          tags[tagEls[t].getAttribute('k')] = tagEls[t].getAttribute('v');

        var isClosed = latlngs.length > 2 &&
          latlngs[0][0] === latlngs[latlngs.length-1][0] &&
          latlngs[0][1] === latlngs[latlngs.length-1][1];

        if (tags['building']) {
          L.polygon(latlngs,{color:'#c4996b',weight:0.8,fillColor:'#d4b896',fillOpacity:0.65}).addTo(layerBuilding);
          continue;
        }
        var hw = tags['highway'];
        if (hw) {
          var isMaj = hw==='motorway'||hw==='trunk'||hw==='primary'||hw==='secondary';
          var clr = hw==='motorway'||hw==='trunk'?'#e06020':hw==='primary'?'#e0a020':hw==='secondary'?'#e0c840':hw==='cycleway'?'#4a90d9':'#cccccc';
          var wt  = hw==='motorway'||hw==='trunk'?5:hw==='primary'?4:hw==='secondary'?3:hw==='tertiary'||hw==='residential'?2:1.2;
          L.polyline(latlngs,{color:clr,weight:wt}).addTo(isMaj?layerRoadMaj:layerRoadMin);
          continue;
        }
        var ww=tags['waterway'], nat=tags['natural'], lu=tags['landuse'];
        if (ww||nat==='water'||lu==='reservoir'||lu==='basin') {
          if (isClosed) L.polygon(latlngs,{color:'#4a90d9',weight:1,fillColor:'#a8d4f5',fillOpacity:0.6}).addTo(layerWater);
          else L.polyline(latlngs,{color:'#4a90d9',weight:2}).addTo(layerWater);
          continue;
        }
        var leisure=tags['leisure'];
        if (nat==='wood'||nat==='scrub'||lu==='forest'||lu==='park'||lu==='grass'||lu==='meadow'||leisure==='park'||leisure==='garden'||leisure==='nature_reserve') {
          if (isClosed) L.polygon(latlngs,{color:'#2d9a4e',weight:0.5,fillColor:'#a8d8b0',fillOpacity:0.45}).addTo(layerGreen);
          continue;
        }
      }

      // Add layers bottom-to-top (no fitBounds — keep user's current view)
      layerGreen.addTo(map);
      layerWater.addTo(map);
      layerBuilding.addTo(map);
      layerRoadMin.addTo(map);
      layerRoadMaj.addTo(map);
    } catch(e) {}
  }
</script>
</body>
</html>`;
}

// ── Screen ──────────────────────────────────────────────────────────────────────
export default function MarkPointScreen() {
  const { addFile } = useGeoData();
  const { maps } = useSavedMaps();
  const { isConnected } = useNetworkStatus();
  const webViewRef = useRef<WebView>(null);
  const insets = useSafeAreaInsets();

  const [mapHtml, setMapHtml] = useState<string | null>(null);
  const [userCoord, setUserCoord] = useState<Coord | null>(null);
  const [pinCoord, setPinCoord] = useState<Coord | null>(null);
  const [locating, setLocating] = useState(true);
  const [webViewLoaded, setWebViewLoaded] = useState(false);
  const [offlineNoMap, setOfflineNoMap] = useState(false);
  const [offlineInjected, setOfflineInjected] = useState(false);

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      const defaultLat = -34.6037;
      const defaultLng = -58.3816;

      if (status !== 'granted') {
        setMapHtml(buildMapHtml(defaultLat, defaultLng));
        setLocating(false);
        return;
      }

      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
      const lat = loc?.coords.latitude ?? defaultLat;
      const lng = loc?.coords.longitude ?? defaultLng;
      setUserCoord({ lat, lng });
      setMapHtml(buildMapHtml(lat, lng));
      setLocating(false);

      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 5 },
        (l) => {
          const coord = { lat: l.coords.latitude, lng: l.coords.longitude };
          setUserCoord(coord);
          webViewRef.current?.injectJavaScript(
            `handleRNMessage(${JSON.stringify(JSON.stringify({ type: 'updateLocation', ...coord }))});true;`,
          );
        },
      ).catch(() => null);
    })();
    return () => { sub?.remove(); };
  }, []);

  // ── Offline basemap injection ─────────────────────────────────────────────
  useEffect(() => {
    if (!webViewLoaded || isConnected || !userCoord || offlineInjected) return;
    const matches = findMapsForLocation(maps, userCoord.lat, userCoord.lng);
    if (matches.length === 0) {
      setOfflineNoMap(true);
      return;
    }
    const target = matches[0];
    setOfflineInjected(true);
    (async () => {
      try {
        const content = isSafUri(target.filePath)
          ? await FileSystem.StorageAccessFramework.readAsStringAsync(target.filePath)
          : await FileSystem.readAsStringAsync(target.filePath);
        const total = Math.ceil(content.length / CHUNK_SIZE);
        for (let i = 0; i < total; i++) {
          const chunk = content.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          webViewRef.current?.injectJavaScript(
            `receiveChunk(${JSON.stringify(chunk)},${i},${total},${i === total - 1});true;`,
          );
          await new Promise<void>((r) => setTimeout(r, 8));
        }
      } catch { /* silencioso */ }
    })();
  }, [webViewLoaded, isConnected, userCoord, maps]);

  function handleMyLocation() {
    if (!userCoord) return;
    webViewRef.current?.injectJavaScript(
      `handleRNMessage(${JSON.stringify(JSON.stringify({ type: 'goToMyLocation' }))});true;`,
    );
  }

  function handleMessage(event: { nativeEvent: { data: string } }) {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'pin') setPinCoord({ lat: msg.lat, lng: msg.lng });
    } catch { /* ignore */ }
  }

  function handleSave() {
    if (!pinCoord) return;
    const id = `marked-${Date.now()}`;
    const now = new Date();
    const label = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    addFile({
      id,
      name: `Punto marcado ${label}`,
      points: [{ id: `${id}-0`, lat: pinCoord.lat, lng: pinCoord.lng, name: `Punto marcado ${label}`, color: PIN_COLOR }],
    });
    router.back();
  }

  return (
    <View style={styles.container}>
      {/* Map or loading */}
      {locating || !mapHtml ? (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Obteniendo ubicación…</Text>
        </View>
      ) : (
        <WebView
          ref={webViewRef}
          source={{ html: mapHtml }}
          style={styles.map}
          onMessage={handleMessage}
          onLoad={() => setWebViewLoaded(true)}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          allowUniversalAccessFromFileURLs
        />
      )}

      {/* Overlay: offline + sin mapa para la zona */}
      {offlineNoMap && !isConnected && (
        <View style={styles.offlineOverlay}>
          <Text style={styles.offlineOverlayIcon}>🗺️</Text>
          <Text style={styles.offlineOverlayTitle}>Sin conexión</Text>
          <Text style={styles.offlineOverlayMsg}>
            No hay mapas descargados para tu ubicación actual.
          </Text>
          <View style={styles.offlineOverlayBtns}>
            <Pressable
              style={styles.offlineBtn}
              onPress={() => { router.back(); router.push('/mis-mapas'); }}
            >
              <Text style={styles.offlineBtnText}>Ir a Mis mapas</Text>
            </Pressable>
            <Pressable style={styles.offlineBtnSecondary} onPress={() => router.back()}>
              <Text style={styles.offlineBtnSecondaryText}>Volver</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Floating header */}
      <View style={[styles.header, { top: insets.top + 12 }]} pointerEvents="box-none">
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>←</Text>
        </Pressable>
        <View style={styles.titlePill}>
          <Text style={styles.titleText}>Marcar punto en mapa</Text>
        </View>
        {/* Offline status pill */}
        {!isConnected && !offlineNoMap && (
          <View style={styles.offlinePill}>
            <Text style={styles.offlinePillText}>⚡ Sin conexión · Mapa offline</Text>
          </View>
        )}
      </View>

      {/* Bottom panel */}
      {!locating && (
        <View style={[styles.panel, { paddingBottom: insets.bottom + 20 }]}>
          {pinCoord ? (
            <View style={styles.coordRow}>
              <Text style={styles.coordPin}>📍</Text>
              <Text style={styles.coordText}>
                {pinCoord.lat.toFixed(5)}{'  '}{pinCoord.lng.toFixed(5)}
              </Text>
            </View>
          ) : (
            <Text style={styles.hint}>Tocá el mapa para marcar un punto</Text>
          )}
          <View style={styles.btnRow}>
            <Pressable
              style={[styles.secondaryBtn, !userCoord && styles.btnDisabled]}
              onPress={handleMyLocation}
              disabled={!userCoord}
            >
              <Text style={styles.secondaryBtnText}>Mi ubicación</Text>
            </Pressable>
            <Pressable
              style={[styles.saveBtn, !pinCoord && styles.btnDisabled]}
              onPress={handleSave}
              disabled={!pinCoord}
            >
              <Text style={styles.saveBtnText}>Guardar punto</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f' },
  map: { flex: 1 },

  // Loading
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14, backgroundColor: '#0a0a0f' },
  loadingText: { color: 'rgba(255,255,255,0.5)', fontSize: 15 },

  // Floating header
  header: {
    position: 'absolute',
    left: 16, right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  backBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(10,10,20,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center', alignItems: 'center',
  },
  backText: {position: "absolute", color: '#fff', fontSize: 20, fontWeight: '500', bottom: 10 },
  titlePill: {
    backgroundColor: 'rgba(10,10,20,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 21,
  },
  titleText: { color: '#fff', fontSize: 12, fontWeight: '600' },

  // Bottom panel
  panel: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    backgroundColor: '#0f0f18',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    gap: 14,
  },
  hint: { color: 'rgba(255,255,255,0.35)', fontSize: 14, textAlign: 'center' },
  coordRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  coordPin: { fontSize: 16 },
  coordText: {
    color: 'rgba(255,255,255,0.85)', fontSize: 13,
    fontVariant: ['tabular-nums'], letterSpacing: 0.2,
  },
  btnRow: { flexDirection: 'row', gap: 10 },
  secondaryBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
  },
  secondaryBtnText: { color: 'rgba(255,255,255,0.75)', fontSize: 15, fontWeight: '500' },
  saveBtn: {
    flex: 1.6, paddingVertical: 14, borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: PIN_COLOR,
    alignItems: 'center',
  },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  btnDisabled: { opacity: 0.3 },

  // ── Offline pill (header) ─────────────────────────────────────────────────
  offlinePill: {
    backgroundColor: 'rgba(255,165,0,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,165,0,0.35)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
  },
  offlinePillText: {
    color: '#FFB340',
    fontSize: 11,
    fontWeight: '600',
  },

  // ── No-map overlay ────────────────────────────────────────────────────────
  offlineOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10,10,15,0.93)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 32,
    zIndex: 50,
  },
  offlineOverlayIcon: { fontSize: 48, marginBottom: 4 },
  offlineOverlayTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#fff',
  },
  offlineOverlayMsg: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.55)',
    textAlign: 'center',
    lineHeight: 22,
  },
  offlineOverlayBtns: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  offlineBtn: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderRadius: 14,
    borderCurve: 'continuous',
  },
  offlineBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  offlineBtnSecondary: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderRadius: 14,
    borderCurve: 'continuous',
  },
  offlineBtnSecondaryText: { color: 'rgba(255,255,255,0.65)', fontWeight: '500', fontSize: 14 },
});
