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
    body: 'Volvé a la pantalla Mapa y tocá "+ Cargar mapa". Podés cargar varios archivos GeoJSON a la vez.',
  },
  {
    n: 5,
    title: 'Seleccioná y explorá en AR',
    body: 'Desplegá cada archivo para ver sus puntos. Tildá los que querés ver, tocá "Ver (N)" y apuntá la cámara hacia esos lugares para verlos en realidad aumentada.',
  },
] as const;

const STEP_COLORS = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF3B30'];

export default function HowToScreen() {
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <Text style={styles.title}>Cómo usar la app</Text>
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
                style={styles.linkButton}
                onPress={() => Linking.openURL(step.action!.url)}
              >
                <Text style={styles.linkButtonText}>{step.action.label}</Text>
              </Pressable>
            )}
          </View>
        </View>
      ))}

      <View style={styles.tip}>
        <Text style={styles.tipTitle}>Consejo</Text>
        <Text style={styles.tipBody}>
          Cuanto más cerca estés de los puntos que marcaste, mejor funciona la precisión del GPS.
          Funciona mejor en espacios abiertos con buena señal.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f0f0f5',
  },
  content: {
    padding: 20,
    paddingTop: 72,
    paddingBottom: 48,
    gap: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 15,
    color: '#666',
    lineHeight: 22,
    marginBottom: 8,
  },

  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    gap: 14,
    alignItems: 'flex-start',
  },
  stepBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
    marginTop: 1,
  },
  stepNumber: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  cardBody: {
    flex: 1,
    gap: 6,
  },
  stepTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  stepBody: {
    fontSize: 14,
    color: '#555',
    lineHeight: 20,
  },
  linkButton: {
    alignSelf: 'flex-start',
    marginTop: 4,
    backgroundColor: '#007AFF',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  linkButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },

  tip: {
    backgroundColor: '#FFF8E7',
    borderRadius: 14,
    padding: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#FF9500',
    gap: 4,
    marginTop: 4,
  },
  tipTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#996000',
  },
  tipBody: {
    fontSize: 14,
    color: '#664400',
    lineHeight: 20,
  },
});
