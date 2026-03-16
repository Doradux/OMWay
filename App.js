import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword
} from "firebase/auth";
import { get, onValue, ref, set } from "firebase/database";
import { getOmwayAuth, getOmwayDb } from "./src/firebase";

const ONLINE_WINDOW_MS = 30_000;

export default function App() {
  const auth = useMemo(() => getOmwayAuth(), []);
  const db = useMemo(() => getOmwayDb(), []);

  const [view, setView] = useState("login");
  const [busy, setBusy] = useState(false);
  const [uid, setUid] = useState("");
  const [pcs, setPcs] = useState([]);
  const [selectedPc, setSelectedPc] = useState("");
  const [lastAction, setLastAction] = useState("");

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regRepeatPassword, setRegRepeatPassword] = useState("");
  const [regUsername, setRegUsername] = useState("");

  const [popup, setPopup] = useState({
    visible: false,
    title: "",
    message: ""
  });

  function showPopup(title, message) {
    setPopup({ visible: true, title, message });
  }

  function closePopup() {
    setPopup({ visible: false, title: "", message: "" });
  }

  useEffect(() => {
    if (!uid) return undefined;

    const presenceRef = ref(db, `presence/${uid}`);
    const unsubscribe = onValue(presenceRef, (snapshot) => {
      const value = snapshot.val() || {};
      const now = Date.now();

      const next = Object.entries(value)
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

      setPcs(next);
      if (!selectedPc && next.length > 0) {
        setSelectedPc(next[0].pcId);
      }
    });

    return () => unsubscribe();
  }, [db, uid, selectedPc]);

  async function login() {
    if (!loginEmail.trim() || !loginPassword.trim()) {
      showPopup("Datos incompletos", "Pon email y password.");
      return;
    }

    try {
      setBusy(true);
      const userCred = await signInWithEmailAndPassword(
        auth,
        loginEmail.trim(),
        loginPassword
      );
      setUid(userCred.user.uid);
      setLoginPassword("");
    } catch (error) {
      showPopup("Login error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function register() {
    const email = regEmail.trim();
    const password = regPassword.trim();
    const repeat = regRepeatPassword.trim();
    const username = regUsername.trim();
    const usernameKey = username.toLowerCase();

    if (!email || !password || !repeat || !username) {
      showPopup("Datos incompletos", "Rellena todos los campos.");
      return;
    }
    if (password.length < 6) {
      showPopup("Password invalida", "Debe tener al menos 6 caracteres.");
      return;
    }
    if (password !== repeat) {
      showPopup("Passwords distintas", "Password y repetir password no coinciden.");
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      showPopup(
        "Username invalido",
        "Usa 3-20 caracteres: letras, numeros o underscore."
      );
      return;
    }

    try {
      setBusy(true);
      const usernameRef = ref(db, `usernames/${usernameKey}`);
      const usernameSnap = await get(usernameRef);
      if (usernameSnap.exists()) {
        showPopup("Username ocupado", "Prueba otro nombre de usuario.");
        return;
      }

      const userCred = await createUserWithEmailAndPassword(auth, email, password);
      const newUid = userCred.user.uid;

      await set(ref(db, `users/${newUid}`), {
        email,
        username,
        createdAt: Date.now()
      });
      await set(usernameRef, newUid);

      setView("login");
      setRegEmail("");
      setRegPassword("");
      setRegRepeatPassword("");
      setRegUsername("");
      showPopup("Cuenta creada", "Cuenta creada correctamente. Ya puedes iniciar sesion.");
    } catch (error) {
      showPopup("Registro error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendTestCommand() {
    if (!uid || !selectedPc) {
      showPopup("No disponible", "Inicia sesion y selecciona un PC.");
      return;
    }

    const payload = {
      type: "open_test_file",
      commandId: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      requestedAt: Date.now(),
      source: "ios_app"
    };

    try {
      setBusy(true);
      await set(ref(db, `commands/${uid}/${selectedPc}/latest`), payload);
      setLastAction(`Comando enviado a ${selectedPc} (${new Date().toLocaleTimeString()})`);
    } catch (error) {
      showPopup("Error", error.message);
    } finally {
      setBusy(false);
    }
  }

  function renderLogin() {
    return (
      <View style={styles.authCard}>
        <Text style={styles.authTitle}>Iniciar sesion</Text>
        <Field label="Email" value={loginEmail} onChangeText={setLoginEmail} />
        <Field
          label="Password"
          value={loginPassword}
          onChangeText={setLoginPassword}
          secureTextEntry
        />
        <Pressable
          style={[styles.primaryBtn, busy && styles.disabled]}
          disabled={busy}
          onPress={login}
        >
          <Text style={styles.primaryBtnText}>Iniciar sesion</Text>
        </Pressable>
        <Pressable onPress={() => setView("register")} style={styles.linkWrap}>
          <Text style={styles.linkText}>Registrarse</Text>
        </Pressable>
      </View>
    );
  }

  function renderRegister() {
    return (
      <View style={styles.authCard}>
        <Pressable onPress={() => setView("login")}>
          <Text style={styles.backText}>Volver</Text>
        </Pressable>
        <Text style={styles.authTitle}>Crear cuenta</Text>
        <Field label="Email" value={regEmail} onChangeText={setRegEmail} />
        <Field
          label="Password"
          value={regPassword}
          onChangeText={setRegPassword}
          secureTextEntry
        />
        <Field
          label="Repeat password"
          value={regRepeatPassword}
          onChangeText={setRegRepeatPassword}
          secureTextEntry
        />
        <Field
          label="Nombre de usuario (unico)"
          value={regUsername}
          onChangeText={setRegUsername}
        />
        <Pressable
          style={[styles.primaryBtn, busy && styles.disabled]}
          disabled={busy}
          onPress={register}
        >
          <Text style={styles.primaryBtnText}>Registrar</Text>
        </Pressable>
      </View>
    );
  }

  function renderDashboard() {
    return (
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Mis PCs</Text>
        {pcs.length === 0 ? (
          <Text style={styles.small}>No hay PCs online por ahora.</Text>
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
          style={[styles.primaryBtn, busy && styles.disabled]}
          disabled={busy || !selectedPc}
          onPress={sendTestCommand}
        >
          <Text style={styles.primaryBtnText}>
            {selectedPc ? `Prueba en ${selectedPc}` : "Prueba"}
          </Text>
        </Pressable>
        <Text style={styles.small}>{lastAction || "Sin acciones aun."}</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.brand}>Omway</Text>
        <Text style={styles.subtitle}>Conecta tu iPhone y tu setup</Text>
        {!uid && view === "login" && renderLogin()}
        {!uid && view === "register" && renderRegister()}
        {!!uid && renderDashboard()}
      </ScrollView>

      <Modal transparent visible={popup.visible} animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{popup.title}</Text>
            <Text style={styles.modalText}>{popup.message}</Text>
            <Pressable style={styles.modalBtn} onPress={closePopup}>
              <Text style={styles.modalBtnText}>OK</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
  safe: { flex: 1, backgroundColor: "#0F172A" },
  container: {
    padding: 22,
    gap: 14,
    minHeight: "100%",
    backgroundColor: "#0F172A"
  },
  brand: {
    fontSize: 36,
    fontWeight: "800",
    color: "#F8FAFC",
    letterSpacing: 0.4
  },
  subtitle: {
    color: "#94A3B8",
    marginBottom: 8
  },
  authCard: {
    backgroundColor: "#111827",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#1F2937",
    padding: 16,
    gap: 10
  },
  authTitle: {
    color: "#F8FAFC",
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 4
  },
  backText: {
    color: "#60A5FA",
    textDecorationLine: "underline",
    fontSize: 13
  },
  fieldWrap: { gap: 6 },
  label: { color: "#CBD5E1", fontSize: 13 },
  input: {
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: "#F8FAFC",
    backgroundColor: "#0B1220"
  },
  primaryBtn: {
    backgroundColor: "#0EA5E9",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4
  },
  primaryBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700"
  },
  linkWrap: {
    alignSelf: "center",
    paddingVertical: 2,
    marginTop: 2
  },
  linkText: {
    fontSize: 13,
    color: "#7DD3FC",
    textDecorationLine: "underline"
  },
  panel: {
    backgroundColor: "#111827",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#1F2937",
    padding: 16,
    gap: 10
  },
  panelTitle: {
    color: "#F8FAFC",
    fontSize: 20,
    fontWeight: "700"
  },
  pcItem: {
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 10,
    padding: 10,
    backgroundColor: "#0B1220"
  },
  pcItemSelected: {
    borderColor: "#22D3EE",
    backgroundColor: "#0C4A6E"
  },
  pcTitle: {
    color: "#E2E8F0",
    fontSize: 15,
    fontWeight: "600"
  },
  pcMeta: {
    color: "#94A3B8",
    fontSize: 12,
    marginTop: 2
  },
  small: {
    color: "#94A3B8",
    fontSize: 12
  },
  disabled: { opacity: 0.6 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(2,6,23,0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24
  },
  modalCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#F8FAFC",
    borderRadius: 16,
    padding: 18,
    gap: 10
  },
  modalTitle: {
    color: "#0F172A",
    fontSize: 20,
    fontWeight: "700"
  },
  modalText: {
    color: "#334155",
    fontSize: 14,
    lineHeight: 20
  },
  modalBtn: {
    marginTop: 4,
    alignSelf: "flex-end",
    backgroundColor: "#0EA5E9",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8
  },
  modalBtnText: {
    color: "#fff",
    fontWeight: "700"
  }
});
