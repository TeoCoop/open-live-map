import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function LandingScreen() {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 40 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={styles.header}>
        <Image
          source={require('../assets/images/icon.png')}
          style={styles.headerIcon}
          contentFit="contain"
        />
        <Text style={styles.title}>OpenLiveMap</Text>
        <Text style={styles.subtitle}>Tu mapa en realidad aumentada</Text>
      </View>

      {/* Mapa interactivo — main CTA */}
      <Pressable
        style={({ pressed }) => [styles.mainCard, pressed && styles.mainCardPressed]}
        onPress={() => router.push('/mapa')}
      >
        <View style={styles.mainCardLeft}>
          <View style={styles.mainCardText}>
            <Text style={styles.mainCardTitle}>Mapa interactivo</Text>
          </View>
        </View>
        <Text style={styles.arrow}>→</Text>
      </Pressable>

      <Pressable style={[styles.mainCard, styles.mainCardDisabled]} disabled>
        <View style={styles.mainCardLeft}>
          <View style={styles.mainCardText}>
            <Text style={[styles.mainCardTitle, styles.disabledTitle]}>Memorias territoriales</Text>
            <View style={styles.proximamenteBadge}>
              <Text style={styles.proximamenteText}>Próximamente</Text>
            </View>
          </View>
        </View>
      </Pressable>

      {/* Divider */}
      <View style={styles.divider} />

      {/* Help section */}
      <Text style={styles.helpQuestion}>¿No sabés cómo usar la app?</Text>

      <Pressable
        style={({ pressed }) => [styles.helpCard, pressed && styles.helpCardPressed]}
        onPress={() => router.push('/como-usar')}
      >
        <Text style={styles.helpCardText}>Cómo usar</Text>
        <Text style={styles.arrow}>→</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0a0a0f',
  },
  content: {
    paddingHorizontal: 24,
    gap: 16,
  },

  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
  },
  headerIcon: {
    width: 100,
    height: 100,
    borderRadius: 18
  },
  title: {
    fontSize: 34,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  subtitle: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.45)',
    fontWeight: '400',
  },

  // ── Main card ────────────────────────────────────────────────────────────────
  mainCard: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 18,
    borderCurve: 'continuous',
    paddingVertical: 22,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  mainCardPressed: {
    backgroundColor: 'rgba(255,255,255,0.11)',
  },
  mainCardLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  mainCardIcon: {
    width: 44,
    height: 44,
  },
  mainCardText: {
    flex: 1,
    gap: 4,
  },
  mainCardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.1,
  },
  mainCardSubtitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    lineHeight: 18,
  },

  // ── Disabled card ────────────────────────────────────────────────────────────
  mainCardDisabled: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderColor: 'rgba(255,255,255,0.06)',
  },
  disabledIcon: {
    opacity: 0.35,
  },
  disabledTitle: {
    color: 'rgba(255,255,255,0.3)',
  },
  proximamenteBadge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 6,
    borderCurve: 'continuous',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  proximamenteText: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.28)',
    letterSpacing: 0.4,
  },

  // ── Divider ─────────────────────────────────────────────────────────────────
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginVertical: 8,
  },

  // ── Help section ─────────────────────────────────────────────────────────────
  helpQuestion: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.38)',
    fontWeight: '500',
    textAlign: 'center',
  },
  helpCard: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  helpCardPressed: {
    backgroundColor: 'rgba(255,255,255,0.09)',
  },
  helpCardText: {
    fontSize: 16,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.7)',
  },

  // ── Shared ───────────────────────────────────────────────────────────────────
  arrow: {
    fontSize: 18,
    color: 'rgba(255,255,255,0.35)',
    fontWeight: '400',
  },
});
