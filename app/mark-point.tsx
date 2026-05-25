import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';

import { useGeoData } from '@/context/geo-data-context';

const PIN_COLOR = '#34C759';

type Coord = { lat: number; lng: number };

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
</script>
</body>
</html>`;
}

// ── Screen ──────────────────────────────────────────────────────────────────────
export default function MarkPointScreen() {
  const { addFile } = useGeoData();
  const webViewRef = useRef<WebView>(null);
  const insets = useSafeAreaInsets();

  const [mapHtml, setMapHtml] = useState<string | null>(null);
  const [userCoord, setUserCoord] = useState<Coord | null>(null);
  const [pinCoord, setPinCoord] = useState<Coord | null>(null);
  const [locating, setLocating] = useState(true);

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
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          allowUniversalAccessFromFileURLs
        />
      )}

      {/* Floating header */}
      <View style={[styles.header, { top: insets.top + 12 }]} pointerEvents="box-none">
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>←</Text>
        </Pressable>
        <View style={styles.titlePill}>
          <Text style={styles.titleText}>Marcar punto en mapa</Text>
        </View>
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
  backText: { color: '#fff', fontSize: 20, fontWeight: '500', lineHeight: 22 },
  titlePill: {
    backgroundColor: 'rgba(10,10,20,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 21,
  },
  titleText: { color: '#fff', fontSize: 15, fontWeight: '600' },

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
});
