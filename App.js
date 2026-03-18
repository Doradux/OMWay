import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import * as Notifications from "expo-notifications";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { getOmwayAuth } from "./src/firebase";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false
  })
});

export default function App() {
  const auth = useMemo(() => getOmwayAuth(), []);
  const API_BASE = String(process.env.EXPO_PUBLIC_OMWAY_API_BASE_URL || "").replace(/\/$/, "");

  const menuAnim = useRef(new Animated.Value(0)).current;
  const outgoingPrevRef = useRef({});

  const [authReady, setAuthReady] = useState(false);
  const [uid, setUid] = useState("");
  const [profile, setProfile] = useState({ username: "", email: "" });

  const [menuOpen, setMenuOpen] = useState(false);
  const [friendsModalOpen, setFriendsModalOpen] = useState(false);
  const [addFriendModalOpen, setAddFriendModalOpen] = useState(false);

  const [busy, setBusy] = useState(false);
  const [notificationsAllowed, setNotificationsAllowed] = useState(false);

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [pcs, setPcs] = useState([]);
  const [pcsLoading, setPcsLoading] = useState(false);
  const [selectedPc, setSelectedPc] = useState("");
  const [lastAction, setLastAction] = useState("");

  const [friends, setFriends] = useState([]);
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [outgoingPending, setOutgoingPending] = useState([]);
  const [friendsFilter, setFriendsFilter] = useState("");

  const [addUsername, setAddUsername] = useState("");
  const [friendBusy, setFriendBusy] = useState(false);

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

  function openMenu() {
    setMenuOpen(true);
    Animated.timing(menuAnim, {
      toValue: 1,
      duration: 170,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true
    }).start();
  }

  function closeMenu() {
    Animated.timing(menuAnim, {
      toValue: 0,
      duration: 120,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true
    }).start(({ finished }) => {
      if (finished) setMenuOpen(false);
    });
  }

  async function apiFetch(pathname, options = {}) {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      throw new Error("Session required.");
    }
    if (!API_BASE) {
      throw new Error("Missing EXPO_PUBLIC_OMWAY_API_BASE_URL in .env");
    }
    const token = await currentUser.getIdToken();
    const response = await fetch(`${API_BASE}${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error || `API ${response.status}`);
    }
    return body;
  }

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setAuthReady(true);
      setMenuOpen(false);
      if (!user) {
        setUid("");
        setProfile({ username: "", email: "" });
        setPcs([]);
        setFriends([]);
        setIncomingRequests([]);
        setOutgoingPending([]);
        setSelectedPc("");
        outgoingPrevRef.current = {};
        return;
      }

      setUid(user.uid);
      setProfile({
        username: (user.email || "user").split("@")[0],
        email: user.email || ""
      });

      await requestNotificationsPermission(false);
      await Promise.all([loadProfile(), loadFriendsData(), refreshPcStatus()]);
    });
    return () => unsubscribe();
  }, [auth]);

  useEffect(() => {
    if (friendsModalOpen && uid) {
      loadFriendsData().catch(() => {
        // ignore transient errors
      });
    }
  }, [friendsModalOpen, uid]);

  async function loadProfile() {
    try {
      const data = await apiFetch("/me", { method: "GET" });
      setProfile({
        username: data.username || (data.email || "user").split("@")[0],
        email: data.email || ""
      });
    } catch (error) {
      showPopup("Profile error", error.message);
    }
  }

  async function loadFriendsData() {
    const data = await apiFetch("/friends", { method: "GET" });
    setFriends(data.friends || []);
    setIncomingRequests(data.incoming || []);

    const outgoingAll = data.outgoing || [];
    const pending = outgoingAll.filter((item) => item.status === "pending");
    setOutgoingPending(pending);

    const prev = outgoingPrevRef.current;
    const nextMap = {};
    outgoingAll.forEach((item) => {
      nextMap[item.targetUid] = item;
      const previousStatus = prev[item.targetUid]?.status;
      if (previousStatus === "pending" && item.status === "accepted") {
        pushLocalNotification(
          "Friend connected",
          `${item.toUsername || "A user"} and you are now connected and can send invitations.`
        );
      }
    });
    outgoingPrevRef.current = nextMap;
  }

  async function refreshPcStatus() {
    if (!uid) return;
    try {
      setPcsLoading(true);
      const data = await apiFetch("/pcs/refresh", { method: "POST", body: "{}" });
      const next = data.pcs || [];
      setPcs(next);
      setSelectedPc((prev) => {
        if (prev && next.some((item) => item.pcId === prev)) return prev;
        return next[0]?.pcId || "";
      });
    } catch (error) {
      showPopup("Refresh error", error.message);
    } finally {
      setPcsLoading(false);
    }
  }

  async function pushLocalNotification(title, body) {
    try {
      await Notifications.scheduleNotificationAsync({
        content: { title, body },
        trigger: null
      });
    } catch {
      // ignore when unavailable
    }
  }

  async function requestNotificationsPermission(showSuccessPopup = true) {
    try {
      const current = await Notifications.getPermissionsAsync();
      if (current.granted) {
        setNotificationsAllowed(true);
        if (showSuccessPopup) {
          showPopup("Notifications enabled", "You will now receive Omway alerts.");
        }
        return true;
      }

      const asked = await Notifications.requestPermissionsAsync();
      setNotificationsAllowed(Boolean(asked.granted));
      if (showSuccessPopup) {
        showPopup(
          asked.granted ? "Notifications enabled" : "Notifications disabled",
          asked.granted
            ? "You will now receive Omway alerts."
            : "Enable notifications in iOS settings if you change your mind."
        );
      }
      return Boolean(asked.granted);
    } catch {
      setNotificationsAllowed(false);
      if (showSuccessPopup) {
        showPopup("Notifications unavailable", "Could not request notification permission.");
      }
      return false;
    }
  }

  async function login() {
    if (!loginEmail.trim() || !loginPassword.trim()) {
      showPopup("Missing data", "Enter email and password.");
      return;
    }

    try {
      setBusy(true);
      await signInWithEmailAndPassword(auth, loginEmail.trim(), loginPassword);
      setLoginPassword("");
      await requestNotificationsPermission(false);
    } catch (error) {
      showPopup("Login error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      setBusy(true);
      await signOut(auth);
    } catch (error) {
      showPopup("Logout error", error.message);
    } finally {
      setBusy(false);
      closeMenu();
    }
  }

  async function sendTestCommand() {
    if (!uid || !selectedPc) {
      showPopup("Unavailable", "Sign in and choose a PC first.");
      return;
    }

    try {
      setBusy(true);
      const data = await apiFetch("/commands/test", {
        method: "POST",
        body: JSON.stringify({ pcId: selectedPc })
      });
      setLastAction(`Command ${data.commandId} sent to ${selectedPc} at ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      showPopup("Command error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendFriendRequest() {
    const wantedUsername = addUsername.trim();
    if (!wantedUsername) {
      showPopup("Missing username", "Type a username to add.");
      return;
    }

    try {
      setFriendBusy(true);
      await apiFetch("/friends/request", {
        method: "POST",
        body: JSON.stringify({ username: wantedUsername })
      });
      setAddUsername("");
      await loadFriendsData();
      showPopup("Request sent", "Friend request sent successfully.");
    } catch (error) {
      showPopup("Friend request error", error.message);
    } finally {
      setFriendBusy(false);
    }
  }

  async function revokeRequest(targetUid) {
    try {
      setFriendBusy(true);
      await apiFetch("/friends/revoke", {
        method: "POST",
        body: JSON.stringify({ targetUid })
      });
      await loadFriendsData();
    } catch (error) {
      showPopup("Revoke error", error.message);
    } finally {
      setFriendBusy(false);
    }
  }

  async function acceptRequest(requestItem) {
    try {
      setFriendBusy(true);
      await apiFetch("/friends/respond", {
        method: "POST",
        body: JSON.stringify({ fromUid: requestItem.fromUid, action: "accept" })
      });
      await loadFriendsData();
      await pushLocalNotification(
        "Friend connected",
        `${requestItem.fromUsername} and you are now connected and can send invitations.`
      );
    } catch (error) {
      showPopup("Accept error", error.message);
    } finally {
      setFriendBusy(false);
    }
  }

  async function rejectRequest(requestItem) {
    try {
      setFriendBusy(true);
      await apiFetch("/friends/respond", {
        method: "POST",
        body: JSON.stringify({ fromUid: requestItem.fromUid, action: "reject" })
      });
      await loadFriendsData();
    } catch (error) {
      showPopup("Reject error", error.message);
    } finally {
      setFriendBusy(false);
    }
  }

  function renderLogin() {
    return (
      <View style={styles.authWrap}>
        <Text style={styles.brand}>OMWAY</Text>
        <Text style={styles.subtitle}>Sign in from your mobile. Account creation is desktop-only.</Text>
        <View style={styles.authCard}>
          <Text style={styles.authTitle}>Welcome back</Text>
          <Field label="Email" value={loginEmail} onChangeText={setLoginEmail} />
          <Field label="Password" value={loginPassword} onChangeText={setLoginPassword} secureTextEntry />
          <Pressable style={[styles.primaryBtn, busy && styles.disabled]} disabled={busy} onPress={login}>
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryBtnText}>Sign in</Text>}
          </Pressable>
        </View>
      </View>
    );
  }

  function renderHeader() {
    const baseName = profile.username || profile.email || "User";
    const initial = baseName.charAt(0).toUpperCase() || "U";

    return (
      <View style={styles.headerWrap}>
        <View>
          <Text style={styles.headerBrand}>OMWAY</Text>
          <Text style={styles.headerName}>{baseName}</Text>
        </View>

        <View style={styles.headerActions}>
          <Pressable onPress={() => setFriendsModalOpen(true)} style={styles.friendIconBtn}>
            <Text style={styles.friendIconText}>??</Text>
          </Pressable>
          <Pressable onPress={() => (menuOpen ? closeMenu() : openMenu())} style={styles.avatarBtn}>
            <Text style={styles.avatarText}>{initial}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  function renderPcPanel() {
    return (
      <View style={styles.card}>
        <View style={styles.titleRow}>
          <Text style={styles.cardTitle}>My PCs</Text>
          <Pressable onPress={refreshPcStatus} style={styles.refreshBtn}>
            {pcsLoading ? <ActivityIndicator size="small" color="#1E40AF" /> : <Text style={styles.refreshText}>Refresh</Text>}
          </Pressable>
        </View>

        {pcs.length === 0 ? (
          <Text style={styles.muted}>No PCs online right now.</Text>
        ) : (
          pcs.map((pc) => (
            <Pressable key={pc.pcId} onPress={() => setSelectedPc(pc.pcId)} style={[styles.pcItem, selectedPc === pc.pcId && styles.pcItemSelected]}>
              <Text style={styles.pcTitle}>{pc.deviceName}</Text>
              <Text style={styles.pcMeta}>
                {pc.pcId} - {pc.isOnline ? "online" : "offline"}
              </Text>
            </Pressable>
          ))
        )}

        <Pressable
          style={[styles.primaryBtn, (busy || !selectedPc) && styles.disabled]}
          disabled={busy || !selectedPc}
          onPress={sendTestCommand}
        >
          <Text style={styles.primaryBtnText}>{selectedPc ? `Run test on ${selectedPc}` : "Run test"}</Text>
        </Pressable>
        <Text style={styles.muted}>{lastAction || "No command sent yet."}</Text>
      </View>
    );
  }

  function filteredFriends() {
    const q = friendsFilter.trim().toLowerCase();
    if (!q) return friends;
    return friends.filter((friend) => friend.username.toLowerCase().includes(q));
  }

  function renderFriendsModal() {
    return (
      <Modal visible={friendsModalOpen} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.bigModalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Friends</Text>
              <View style={styles.row}>
                <Pressable style={styles.iconActionBtn} onPress={() => setAddFriendModalOpen(true)}>
                  <Text style={styles.iconActionText}>??+</Text>
                </Pressable>
                <Pressable style={styles.iconActionBtn} onPress={() => setFriendsModalOpen(false)}>
                  <Text style={styles.iconActionText}>?</Text>
                </Pressable>
              </View>
            </View>

            <TextInput
              value={friendsFilter}
              onChangeText={setFriendsFilter}
              autoCapitalize="none"
              placeholder="Search friends"
              placeholderTextColor="#7B8BA9"
              style={styles.input}
            />

            <Text style={styles.sectionTitle}>Incoming requests</Text>
            <ScrollView style={styles.modalList}>
              {incomingRequests.length === 0 ? (
                <Text style={styles.muted}>No pending requests.</Text>
              ) : (
                incomingRequests.map((requestItem) => (
                  <View key={requestItem.fromUid} style={styles.requestItem}>
                    <Text style={styles.requestName}>{requestItem.fromUsername}</Text>
                    <View style={styles.requestActions}>
                      <Pressable style={[styles.actionBtn, styles.acceptBtn]} onPress={() => acceptRequest(requestItem)}>
                        <Text style={styles.actionBtnText}>Accept</Text>
                      </Pressable>
                      <Pressable style={[styles.actionBtn, styles.rejectBtn]} onPress={() => rejectRequest(requestItem)}>
                        <Text style={styles.actionBtnText}>Reject</Text>
                      </Pressable>
                    </View>
                  </View>
                ))
              )}

              <Text style={styles.sectionTitle}>Friend list</Text>
              {filteredFriends().length === 0 ? (
                <Text style={styles.muted}>No friends found.</Text>
              ) : (
                filteredFriends().map((friend) => (
                  <View key={friend.uid} style={styles.friendItem}>
                    <View style={styles.friendDot} />
                    <Text style={styles.friendName}>{friend.username}</Text>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  }

  function renderAddFriendModal() {
    return (
      <Modal visible={addFriendModalOpen} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.bigModalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Add friend</Text>
              <Pressable style={styles.iconActionBtn} onPress={() => setAddFriendModalOpen(false)}>
                <Text style={styles.iconActionText}>?</Text>
              </Pressable>
            </View>

            <View style={styles.row}>
              <TextInput
                value={addUsername}
                onChangeText={setAddUsername}
                autoCapitalize="none"
                placeholder="username"
                placeholderTextColor="#7B8BA9"
                style={[styles.input, styles.rowInput]}
              />
              <Pressable style={[styles.secondaryBtn, friendBusy && styles.disabled]} onPress={sendFriendRequest} disabled={friendBusy}>
                {friendBusy ? <ActivityIndicator color="#1E40AF" /> : <Text style={styles.secondaryBtnText}>Send</Text>}
              </Pressable>
            </View>

            <Text style={styles.sectionTitle}>Outgoing pending</Text>
            <ScrollView style={styles.modalList}>
              {outgoingPending.length === 0 ? (
                <Text style={styles.muted}>No pending requests.</Text>
              ) : (
                outgoingPending.map((item) => (
                  <View key={item.targetUid} style={styles.requestItem}>
                    <Text style={styles.requestName}>{item.toUsername}</Text>
                    <Pressable style={[styles.actionBtn, styles.rejectBtn]} onPress={() => revokeRequest(item.targetUid)}>
                      <Text style={styles.actionBtnText}>Revoke</Text>
                    </Pressable>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  }

  if (!authReady) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#2563EB" />
          <Text style={styles.muted}>Loading Omway...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const menuStyle = {
    opacity: menuAnim,
    transform: [
      { translateY: menuAnim.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) },
      { scale: menuAnim.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1] }) }
    ]
  };

  return (
    <SafeAreaView style={styles.safe}>
      {menuOpen ? <Pressable style={styles.menuBackdrop} onPress={closeMenu} /> : null}

      <ScrollView contentContainerStyle={styles.container}>
        {!uid ? (
          renderLogin()
        ) : (
          <>
            {renderHeader()}
            {menuOpen ? (
              <Animated.View style={[styles.menu, menuStyle]}>
                <Pressable style={styles.menuItem} onPress={() => requestNotificationsPermission(true)}>
                  <Text style={styles.menuText}>{notificationsAllowed ? "Notifications enabled" : "Allow notifications"}</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={logout}>
                  <Text style={[styles.menuText, styles.menuDanger]}>Sign out</Text>
                </Pressable>
              </Animated.View>
            ) : null}

            {renderPcPanel()}
          </>
        )}
      </ScrollView>

      {renderFriendsModal()}
      {renderAddFriendModal()}

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
        placeholderTextColor="#7B8BA9"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#EAF1FF" },
  container: { minHeight: "100%", padding: 20, paddingTop: 26, gap: 14 },
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  authWrap: { gap: 10 },
  brand: { fontSize: 38, fontWeight: "800", color: "#102A73", letterSpacing: 1.2 },
  subtitle: { color: "#486086", lineHeight: 20, marginBottom: 6 },
  authCard: {
    borderRadius: 24,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D8E4FF",
    padding: 18,
    gap: 12,
    shadowColor: "#4D80FF",
    shadowOpacity: 0.15,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6
  },
  authTitle: { fontSize: 24, fontWeight: "700", color: "#0F1E4A" },
  headerWrap: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 2 },
  headerBrand: { color: "#3C4E7D", fontSize: 12, letterSpacing: 3, fontWeight: "700" },
  headerName: { color: "#0F1E4A", fontSize: 26, fontWeight: "800" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  friendIconBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#DBEAFE",
    borderWidth: 1,
    borderColor: "#93C5FD",
    alignItems: "center",
    justifyContent: "center"
  },
  friendIconText: { fontSize: 18 },
  avatarBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#1D4ED8",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#1D4ED8",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5
  },
  avatarText: { color: "#FFFFFF", fontWeight: "800", fontSize: 17 },
  menuBackdrop: { position: "absolute", top: 0, right: 0, left: 0, bottom: 0, zIndex: 10 },
  menu: {
    position: "absolute",
    top: 80,
    right: 20,
    zIndex: 20,
    width: 220,
    borderRadius: 14,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#D8E4FF",
    overflow: "hidden",
    shadowColor: "#1F3B8A",
    shadowOpacity: 0.2,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8
  },
  menuItem: { paddingHorizontal: 14, paddingVertical: 12 },
  menuText: { color: "#1C2E5E", fontWeight: "600" },
  menuDanger: { color: "#B91C1C" },
  card: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#D8E4FF",
    backgroundColor: "#FFFFFF",
    padding: 16,
    gap: 10,
    shadowColor: "#4D80FF",
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 5
  },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  refreshBtn: {
    minWidth: 82,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#93C5FD",
    backgroundColor: "#DBEAFE",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 12
  },
  refreshText: { color: "#1E40AF", fontWeight: "700", fontSize: 13 },
  cardTitle: { color: "#102A73", fontSize: 20, fontWeight: "800" },
  sectionTitle: { marginTop: 6, color: "#1C2E5E", fontSize: 14, fontWeight: "700" },
  fieldWrap: { gap: 6 },
  label: { color: "#3C4E7D", fontSize: 13, fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderColor: "#C6D4F7",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    backgroundColor: "#F7FAFF",
    color: "#102A73"
  },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  rowInput: { flex: 1 },
  primaryBtn: { backgroundColor: "#2563EB", borderRadius: 12, alignItems: "center", paddingVertical: 12 },
  primaryBtnText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },
  secondaryBtn: {
    backgroundColor: "#DBEAFE",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: "#93C5FD"
  },
  secondaryBtnText: { color: "#1E40AF", fontWeight: "700" },
  disabled: { opacity: 0.55 },
  pcItem: { borderWidth: 1, borderColor: "#D2DDF8", borderRadius: 12, padding: 10, backgroundColor: "#F8FBFF" },
  pcItemSelected: { borderColor: "#3B82F6", backgroundColor: "#E6F0FF" },
  pcTitle: { color: "#0F1E4A", fontSize: 15, fontWeight: "700" },
  pcMeta: { color: "#5B6E97", marginTop: 2, fontSize: 12 },
  requestItem: { borderRadius: 12, borderWidth: 1, borderColor: "#D2DDF8", backgroundColor: "#F8FBFF", padding: 10, gap: 8 },
  requestName: { color: "#102A73", fontWeight: "700" },
  requestActions: { flexDirection: "row", gap: 8 },
  actionBtn: { borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12, alignItems: "center" },
  acceptBtn: { backgroundColor: "#1D4ED8" },
  rejectBtn: { backgroundColor: "#9CA3AF" },
  actionBtnText: { color: "#FFFFFF", fontWeight: "700" },
  friendItem: {
    borderRadius: 10,
    backgroundColor: "#F8FBFF",
    borderWidth: 1,
    borderColor: "#D2DDF8",
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    gap: 10,
    alignItems: "center"
  },
  friendDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#2563EB" },
  friendName: { color: "#1C2E5E", fontWeight: "600" },
  muted: { color: "#5B6E97", fontSize: 13 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(10,28,74,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24
  },
  modalCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 18,
    gap: 10
  },
  bigModalCard: {
    width: "100%",
    maxWidth: 420,
    maxHeight: "80%",
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 18,
    gap: 10
  },
  modalHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  iconActionBtn: {
    minWidth: 42,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#D2DDF8",
    backgroundColor: "#F7FAFF",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8
  },
  iconActionText: { color: "#1C2E5E", fontWeight: "700" },
  modalList: { maxHeight: 300 },
  modalTitle: { color: "#0F1E4A", fontSize: 20, fontWeight: "700" },
  modalText: { color: "#334E80", fontSize: 14, lineHeight: 20 },
  modalBtn: {
    marginTop: 4,
    alignSelf: "flex-end",
    backgroundColor: "#2563EB",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8
  },
  modalBtnText: { color: "#FFFFFF", fontWeight: "700" }
});
