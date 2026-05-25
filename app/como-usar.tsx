import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

const UMAP_URL = 'https://umap.openstreetmap.fr/';

const STEPS = [
  {
    n: 1,
    title: 'Creá tu mapa en uMap',
    body: 'Abrí umap.openstreetmap.fr en tu navegador. No necesitás cuenta — podés crear un mapa temporal de forma instantánea.',
    action: { label: 'Abrir uMap ↗', url: UMAP_URL },
  },
  {
    n: 2,
    title: 'Marcá los puntos de interés',
    body: 'Usá la herramienta de punto para agregar cada lugar que querés ver en AR. Dale un nombre descriptivo y elegí un color para identificarlo fácilmente.',
  },
  {
    n: 3,
    title: 'Descargá el archivo GeoJSON',
    body: 'En el menú del mapa andá a Acciones avanzadas → Descargar datos. Elegí el formato GeoJSON y guardá el archivo en tu dispositivo.',
  },
  {
    n: 4,
    title: 'Cargá el archivo en la app',
    body: 'Volvé a la pantalla Mapa interactivo y tocá "+ Cargar mapa". Podés cargar varios archivos GeoJSON a la vez.',
  },
  {
    n: 5,
    title: 'Seleccioná y explorá en AR',
    body: 'Desplegá cada archivo para ver sus puntos. Tildá los que querés ver, tocá "Ver en AR" y apuntá la cámara hacia esos lugares para verlos en realidad aumentada.',
  },
] as const;

const STEP_COLORS = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF3B30'];

export default function ComoUsarScreen() {
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.subtitle}>
        Seguí estos pasos para ver tus puntos de interés en realidad aumentada.
      </Text>

      {STEPS.map((step, i) => (
        <View key={step.n} style={styles.card}>
          <View style={[styles.stepBadge, { backgroundColor: STEP_COLORS[i] }]}>
            <Text style={styles.stepNumber}>{step.n}</Text>
          </View>
          <View style={styles.cardBody}>
            <Text style={styles.stepTitle}>{step.title}</Text>
            <Text style={styles.stepBody}>{step.body}</Text>
            {'action' in step && step.action && (
              <Pressable
                style={styles.linkBtn}
                onPress={() => Linking.openURL(step.action!.url)}
              >
                <Text style={styles.linkBtnText}>{step.action.label}</Text>
              </Pressable>
            )}
          </View>
        </View>
      ))}

      <View style={styles.tip}>
        <Text style={styles.tipTitle}>💡  Consejo</Text>
        <Text style={styles.tipBody}>
          Cuanto más cerca estés de los puntos que marcaste, mejor funciona la precisión del GPS.
          Funciona mejor en espacios abiertos con buena señal.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0a0a0f' },
  content: { padding: 20, paddingTop: 16, paddingBottom: 48, gap: 12 },

  subtitle: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.45)',
    lineHeight: 22,
    marginBottom: 4,
  },

  card: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 16,
    borderCurve: 'continuous',
    padding: 16,
    flexDirection: 'row',
    gap: 14,
    alignItems: 'flex-start',
  },
  stepBadge: {
    width: 34, height: 34, borderRadius: 17,
    justifyContent: 'center', alignItems: 'center',
    flexShrink: 0, marginTop: 1,
  },
  stepNumber: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cardBody: { flex: 1, gap: 6 },
  stepTitle: { fontSize: 16, fontWeight: '600', color: '#ffffff' },
  stepBody: { fontSize: 14, color: 'rgba(255,255,255,0.52)', lineHeight: 20 },

  linkBtn: {
    alignSelf: 'flex-start',
    marginTop: 6,
    backgroundColor: '#007AFF',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderCurve: 'continuous',
  },
  linkBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  tip: {
    backgroundColor: 'rgba(255,149,0,0.12)',
    borderRadius: 16,
    borderCurve: 'continuous',
    padding: 16,
    borderLeftWidth: 3,
    borderLeftColor: '#FF9500',
    gap: 6,
    marginTop: 4,
  },
  tipTitle: { fontSize: 14, fontWeight: '700', color: '#FF9500' },
  tipBody: { fontSize: 14, color: 'rgba(255,200,120,0.75)', lineHeight: 20 },
});
