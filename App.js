import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, ScrollView, TouchableOpacity, StatusBar, Linking, TextInput, Alert, NativeModules } from 'react-native';
const { MessageStore } = NativeModules;

export default function App() {
  const [logs, setLogs] = useState([]);
  const [ready, setReady] = useState(false);
  const [activeChat, setActiveChat] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiUrl, setApiUrl] = useState('');

  useEffect(() => {
    if (MessageStore) {
      setReady(true);
      loadSettings();
    }
    const timer = setInterval(readMessages, 2000);
    return () => clearInterval(timer);
  }, []);

  const loadSettings = async () => {
    try {
      if (MessageStore.getApiUrl) {
        const url = await MessageStore.getApiUrl();
        setApiUrl(url);
      }
    } catch(e) {}
  };

  const saveSettings = async () => {
    try {
      if (MessageStore.setApiUrl) {
        await MessageStore.setApiUrl(apiUrl);
        Alert.alert("Saved", "Backend URL updated successfully.");
        setShowSettings(false);
      }
    } catch(e) {}
  };

  const readMessages = async () => {
    if (!MessageStore) return;
    try {
      const data = await MessageStore.getMessages();
      const msgs = JSON.parse(data);
      setLogs(msgs.map((m, i) => ({
        id: i + '_' + (m.time || 0),
        chat: m.chat || 'Unknown Chat',
        sender: m.sender || 'Unknown',
        message: m.message,
        time: new Date(m.time).getTime(),
        timeStr: new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      })));
    } catch (e) {}
  };

  const clear = async () => { if (MessageStore) { await MessageStore.clearMessages(); setLogs([]); setActiveChat(null); } };

  // Group logs by chat
  const chatGroups = {};
  logs.forEach(log => {
    if (!chatGroups[log.chat]) chatGroups[log.chat] = [];
    chatGroups[log.chat].push(log);
  });

  const chatList = Object.keys(chatGroups).map(chatName => {
    const messages = chatGroups[chatName];
    messages.sort((a, b) => a.time - b.time); // oldest to newest
    const lastMsg = messages[messages.length - 1];
    return {
      chatName,
      lastMsg: lastMsg.message,
      time: lastMsg.time,
      timeStr: lastMsg.timeStr,
      count: messages.length
    };
  }).sort((a, b) => b.time - a.time);

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" />
      <View style={s.header}>
        <Text style={s.title}>SRAAS <Text style={{ color: '#0f0' }}>Live</Text></Text>
        <View style={{flexDirection: 'row', gap: 10, alignItems: 'center'}}>
          <TouchableOpacity onPress={() => setShowSettings(!showSettings)} style={[s.badge, { backgroundColor: '#333' }]}>
            <Text style={[s.badgeText, { color: '#fff' }]}>⚙️ SETTINGS</Text>
          </TouchableOpacity>
          <View style={[s.badge, { backgroundColor: ready ? '#22c55e' : '#f44' }]}>
            <Text style={s.badgeText}>{ready ? 'READY' : 'NO MODULE'}</Text>
          </View>
        </View>
      </View>

      {showSettings && (
        <View style={s.settingsBox}>
          <Text style={s.settingsTitle}>Backend Integration</Text>
          <Text style={s.settingsDesc}>Enter your .NET API URL to sync messages live.</Text>
          <TextInput
            style={s.input}
            placeholder="http://192.168.1.5:5000"
            placeholderTextColor="#666"
            value={apiUrl}
            onChangeText={setApiUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={[s.btn, { backgroundColor: '#0f0', marginTop: 10 }]} onPress={saveSettings}>
            <Text style={{ color: '#000', fontWeight: 'bold' }}>SAVE URL</Text>
          </TouchableOpacity>
        </View>
      )}

      {!activeChat && !showSettings && (
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
          <TouchableOpacity style={[s.btn, { backgroundColor: '#333' }]} onPress={() => Linking.sendIntent('android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS')}>
            <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 11 }}>1. NOTIFICATIONS</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, { backgroundColor: '#333' }]} onPress={() => Linking.sendIntent('android.settings.ACCESSIBILITY_SETTINGS')}>
            <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 11 }}>2. ACCESSIBILITY</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, { backgroundColor: '#f44', flex: 0.5 }]} onPress={clear}>
            <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 11 }}>CLEAR</Text>
          </TouchableOpacity>
        </View>
      )}

      {activeChat && !showSettings ? (
        // --- CHAT DETAIL VIEW ---
        <View style={{ flex: 1 }}>
          <View style={s.chatHeader}>
            <TouchableOpacity onPress={() => setActiveChat(null)} style={{ padding: 10 }}>
              <Text style={{ color: '#0f0', fontWeight: 'bold', fontSize: 18 }}>←</Text>
            </TouchableOpacity>
            <Text style={s.chatTitle}>{activeChat}</Text>
            <View style={{ width: 40 }} />
          </View>
          <ScrollView style={s.chatBg} contentContainerStyle={{ padding: 10 }}>
            {chatGroups[activeChat]?.sort((a, b) => a.time - b.time).map(l => {
              const isMe = l.sender === 'You';
              return (
                <View key={l.id} style={[s.bubbleRow, isMe ? s.bubbleRowRight : s.bubbleRowLeft]}>
                  <View style={[s.bubble, isMe ? s.bubbleRight : s.bubbleLeft]}>
                    {!isMe && l.sender !== activeChat && <Text style={s.groupSender}>{l.sender}</Text>}
                    <Text style={s.bubbleText}>{l.message}</Text>
                    <Text style={s.bubbleTime}>{l.timeStr}</Text>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </View>
      ) : !showSettings ? (
        // --- CHAT LIST VIEW ---
        <View style={{ flex: 1 }}>
          <Text style={s.logTitle}>CHATS ({chatList.length})</Text>
          <ScrollView style={s.console}>
            {chatList.map(c => (
              <TouchableOpacity key={c.chatName} style={s.chatListItem} onPress={() => setActiveChat(c.chatName)}>
                <View style={s.avatar}><Text style={s.avatarText}>{c.chatName.charAt(0).toUpperCase()}</Text></View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={s.chatListName} numberOfLines={1}>{c.chatName}</Text>
                    <Text style={s.chatListTime}>{c.timeStr}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 }}>
                    <Text style={s.chatListMsg} numberOfLines={1}>{c.lastMsg}</Text>
                    <View style={s.unreadBadge}><Text style={s.unreadText}>{c.count}</Text></View>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
            {chatList.length === 0 && <Text style={s.empty}>No conversations captured yet.</Text>}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', padding: 16, paddingTop: 50 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { fontSize: 26, fontWeight: '900', color: '#fff' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeText: { color: '#000', fontSize: 10, fontWeight: 'bold' },
  btn: { flex: 1, padding: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  logTitle: { color: '#444', fontSize: 11, fontWeight: 'bold', letterSpacing: 1, marginBottom: 6 },
  console: { flex: 1 },
  empty: { color: '#444', textAlign: 'center', marginTop: 40, fontStyle: 'italic' },
  
  settingsBox: { backgroundColor: '#111', padding: 20, borderRadius: 10, marginBottom: 20, borderWidth: 1, borderColor: '#333' },
  settingsTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 5 },
  settingsDesc: { color: '#aaa', fontSize: 12, marginBottom: 15 },
  input: { backgroundColor: '#222', color: '#0f0', padding: 12, borderRadius: 8, fontSize: 16, borderWidth: 1, borderColor: '#444' },

  // Chat List
  chatListItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#111' },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#25d366', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  avatarText: { color: '#000', fontSize: 20, fontWeight: 'bold' },
  chatListName: { color: '#fff', fontSize: 16, fontWeight: 'bold', flex: 1 },
  chatListTime: { color: '#888', fontSize: 11 },
  chatListMsg: { color: '#aaa', fontSize: 14, flex: 1, marginRight: 10 },
  unreadBadge: { backgroundColor: '#25d366', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, justifyContent: 'center', alignItems: 'center' },
  unreadText: { color: '#000', fontSize: 10, fontWeight: 'bold' },

  // Chat Detail
  chatHeader: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#111', borderRadius: 10, marginBottom: 10 },
  chatTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', flex: 1, textAlign: 'center' },
  chatBg: { flex: 1, backgroundColor: '#050505', borderRadius: 10, borderWidth: 1, borderColor: '#222' },
  bubbleRow: { flexDirection: 'row', marginBottom: 8 },
  bubbleRowLeft: { justifyContent: 'flex-start' },
  bubbleRowRight: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 12 },
  bubbleLeft: { backgroundColor: '#222', borderTopLeftRadius: 2 },
  bubbleRight: { backgroundColor: '#005c4b', borderTopRightRadius: 2 },
  groupSender: { color: '#25d366', fontSize: 11, fontWeight: 'bold', marginBottom: 2 },
  bubbleText: { color: '#fff', fontSize: 15 },
  bubbleTime: { color: '#888', fontSize: 10, textAlign: 'right', marginTop: 4 },
});
