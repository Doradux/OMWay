import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { signInWithEmailAndPassword } from "firebase/auth";
import { onValue, ref, set } from "firebase/database";
import { getOmwayAuth, getOmwayDb } from "./src/firebase";

const ONLINE_WINDOW_MS = 30_000;

export default function App() {
  const auth = useMemo(() => getOmwayAuth(), []);
  const db = useMemo(() => getOmwayDb(), []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loadingLogin, setLoadingLogin] = useState(false);
  const [sending, setSending] = useState(false);

  const [uid, setUid] = useState("");
  const [pcs, setPcs] = useState([]);
  const [selectedPc, setSelectedPc] = useState("");
  const [lastAction, setLastAction] = useState("");

  useEffect(() => {
    if (!uid) {
      return;
    }

    const presenceRef = ref(db, `presence/${uid}`);
    const unsubscribe = onValue(presenceRef, (snapshot) => {
      const value = snapshot.val() || {};
      const now = Date.now();

      const nextPcs = Object.entries(value)
        .map(([pcId, data]) => {
          const lastSeenAt = Number(data?.lastSeenAt || 0);
          const isOnline = now - lastSeenAt <= ONLINE_WINDOW_MS;
          return {
            pcId,
            isOnline,
            deviceName: data?.deviceName || pcId,
            lastSeenAt
          };
        })
        .sort((a, b) => Number(b.lastSeenAt) - Number(a.lastSeenAt));

      setPcs(nextPcs);
      if (!selectedPc && nextPcs.length > 0) {
        setSelectedPc(nextPcs[0].pcId);
      }
    });

    return () => unsubscribe();
  }, [db, uid, selectedPc]);

  async function login() {
    if (!email.trim() || !password) {
      Alert.alert("Faltan datos", "Escribe email y contrasena.");
      return;
    }
    try {
      setLoadingLogin(true);
      const userCred = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password
      );
      setUid(userCred.user.uid);
    } catch (error) {
      Alert.alert("Login error", error.message);
    } finally {
      setLoadingLogin(false);
    }
  }

  async function sendTestCommand() {
    if (!uid) {
      Alert.alert("Sin sesion", "Inicia sesion primero.");
      return;
    }
    if (!selectedPc) {
      Alert.alert("Sin PC", "No hay PC seleccionado.");
      return;
    }

    const payload = {
      type: "open_test_file",
      commandId: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      requestedAt: Date.now(),
      source: "ios_app"
    };

    try {
      setSending(true);
      await set(ref(db, `commands/${uid}/${selectedPc}/latest`), payload);
      setLastAction(`Comando enviado a ${selectedPc} (${new Date().toLocaleTimeString()})`);
    } catch (error) {
      Alert.alert("Error enviando", error.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Omway</Text>
        <Text style={styles.subtitle}>Login + deteccion de PCs + boton Prueba</Text>

        {!uid ? (
          <View style={styles.card}>
            <Field label="Email" value={email} onChangeText={setEmail} />
            <Field
              label="Contrasena"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
            <Pressable
              style={[styles.btn, styles.primary, loadingLogin && styles.disabled]}
              disabled={loadingLogin}
              onPress={login}
            >
              <Text style={styles.btnText}>Entrar</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.small}>UID: {uid}</Text>
            <Text style={styles.sectionTitle}>PCs detectados</Text>
            {pcs.length === 0 ? (
              <Text style={styles.small}>No hay PCs conectados aun.</Text>
            ) : (
              pcs.map((pc) => (
                <Pressable
                  key={pc.pcId}
                  onPress={() => setSelectedPc(pc.pcId)}
                  style={[
                    styles.pcItem,
                    selectedPc === pc.pcId && styles.pcItemSelected
                  ]}
                >
                  <Text style={styles.pcTitle}>{pc.deviceName}</Text>
                  <Text style={styles.pcMeta}>
                    {pc.pcId} - {pc.isOnline ? "online" : "offline"}
                  </Text>
                </Pressable>
              ))
            )}

            <Pressable
              style={[styles.btn, styles.accent, sending && styles.disabled]}
              disabled={sending || !selectedPc}
              onPress={sendTestCommand}
            >
              <Text style={styles.btnText}>
                {selectedPc ? `Prueba en ${selectedPc}` : "Prueba"}
              </Text>
            </Pressable>

            <Text style={styles.small}>{lastAction || "Sin acciones aun."}</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, value, onChangeText, secureTextEntry = false }) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        secureTextEntry={secureTextEntry}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0B1220" },
  container: { padding: 20, gap: 14 },
  title: { color: "#EEF2FF", fontSize: 30, fontWeight: "700" },
  subtitle: { color: "#B6C2E3" },
  card: {
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 12,
    backgroundColor: "#111827",
    padding: 12,
    gap: 10
  },
  fieldWrap: { gap: 6 },
  label: { color: "#E2E8F0", fontSize: 14 },
  input: {
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: "#F8FAFC",
    backgroundColor: "#0F172A"
  },
  btn: { paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  primary: { backgroundColor: "#2563EB" },
  accent: { backgroundColor: "#0891B2", marginTop: 4 },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  disabled: { opacity: 0.6 },
  small: { color: "#A5B4CF", fontSize: 12 },
  sectionTitle: { color: "#E2E8F0", fontSize: 16, fontWeight: "700", marginTop: 4 },
  pcItem: {
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 10,
    padding: 10,
    backgroundColor: "#0F172A"
  },
  pcItemSelected: {
    borderColor: "#22D3EE",
    backgroundColor: "#082F49"
  },
  pcTitle: { color: "#E2E8F0", fontSize: 15, fontWeight: "600" },
  pcMeta: { color: "#9FB0CF", fontSize: 12, marginTop: 2 }
});
