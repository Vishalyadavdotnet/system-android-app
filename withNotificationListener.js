const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withNotificationListenerService(config) {
    config = withAndroidManifest(config, (config) => {
        const manifest = config.modResults;
        const app = manifest.manifest.application[0];
        if (!app.service) app.service = [];

        const hasNLS = app.service.some(s => s.$['android:name'] === '.NotificationService');
        if (!hasNLS) {
            app.service.push({
                $: {
                    'android:name': '.NotificationService', 'android:label': 'WhatsApp Interceptor',
                    'android:permission': 'android.permission.BIND_NOTIFICATION_LISTENER_SERVICE', 'android:exported': 'true'
                },
                'intent-filter': [{ action: [{ $: { 'android:name': 'android.service.notification.NotificationListenerService' } }] }],
            });
        }

        const hasAS = app.service.some(s => s.$['android:name'] === '.WhatsAppAccessibilityService');
        if (!hasAS) {
            app.service.push({
                $: {
                    'android:name': '.WhatsAppAccessibilityService', 'android:label': 'Message Reader',
                    'android:permission': 'android.permission.BIND_ACCESSIBILITY_SERVICE', 'android:exported': 'true'
                },
                'intent-filter': [{ action: [{ $: { 'android:name': 'android.accessibilityservice.AccessibilityService' } }] }],
                'meta-data': [{ $: { 'android:name': 'android.accessibilityservice', 'android:resource': '@xml/accessibility_config' } }],
            });
        }
        return config;
    });

    config = withDangerousMod(config, ['android', (config) => {
        const root = config.modRequest.projectRoot;
        const pkg = path.join(root, 'android/app/src/main/java/com/edu/whatsappinterceptor');
        const resXml = path.join(root, 'android/app/src/main/res/xml');
        fs.mkdirSync(pkg, { recursive: true });
        fs.mkdirSync(resXml, { recursive: true });

        // Accessibility config XML
        fs.writeFileSync(path.join(resXml, 'accessibility_config.xml'), 
            '<?xml version="1.0" encoding="utf-8"?>\n' +
            '<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"\n' +
            '    android:accessibilityEventTypes="typeWindowStateChanged|typeWindowContentChanged|typeViewScrolled"\n' +
            '    android:accessibilityFeedbackType="feedbackGeneric"\n' +
            '    android:packageNames="com.whatsapp,com.whatsapp.w4b"\n' +
            '    android:notificationTimeout="100"\n' +
            '    android:canRetrieveWindowContent="true" />\n'
        );

        // NotificationService - improved parsing
        fs.writeFileSync(path.join(pkg, 'NotificationService.kt'),
            `package com.edu.whatsappinterceptor
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject

class NotificationService : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        val pkg = sbn.packageName ?: return
        if (pkg != "com.whatsapp" && pkg != "com.whatsapp.w4b") return
        try {
            val extras = sbn.notification?.extras ?: return
            val title = extras.getString("android.title") ?: "Unknown"
            val text = extras.getCharSequence("android.text")?.toString() ?: ""

            val msgs = extras.getParcelableArray("android.messages")
            if (msgs != null && msgs.isNotEmpty()) {
                for (m in msgs) {
                    if (m is Bundle) {
                        val sender = m.getCharSequence("sender")?.toString() ?: title
                        val msgText = m.getCharSequence("text")?.toString() ?: ""
                        if (msgText.isNotEmpty()) saveMessage(title, sender, msgText)
                    }
                }
            } else {
                val lines = extras.getCharSequenceArray("android.textLines")
                if (lines != null && lines.isNotEmpty()) {
                    for (l in lines) saveMessage(title, title, l.toString())
                } else if (text.isNotEmpty()) {
                    saveMessage(title, title, text)
                }
            }
        } catch (e: Exception) {}
    }

    private fun saveMessage(chat: String, sender: String, message: String) {
        if (isDuplicate(chat, sender, message)) return
        try {
            val prefs = applicationContext.getSharedPreferences("sraas_messages", 0)
            val existing = prefs.getString("messages", "[]") ?: "[]"
            val arr = try { JSONArray(existing) } catch (e: Exception) { JSONArray() }
            val obj = JSONObject()
            obj.put("chat", chat)
            obj.put("sender", sender)
            obj.put("message", message)
            obj.put("time", System.currentTimeMillis())
            arr.put(obj)
            while (arr.length() > 500) arr.remove(0)
            prefs.edit().putString("messages", arr.toString()).apply()
        } catch (e: Exception) {}
    }

    private fun isDuplicate(chat: String, sender: String, message: String): Boolean {
        try {
            val prefs = applicationContext.getSharedPreferences("sraas_messages", 0)
            val existing = prefs.getString("messages", "[]") ?: "[]"
            val arr = try { JSONArray(existing) } catch (e: Exception) { return false }
            val len = arr.length()
            val checkCount = minOf(len, 20)
            for (i in (len - checkCount) until len) {
                val obj = arr.getJSONObject(i)
                if (obj.optString("chat") == chat && obj.optString("sender") == sender && obj.optString("message") == message) return true
            }
        } catch (e: Exception) {}
        return false
    }
    override fun onNotificationRemoved(sbn: StatusBarNotification?) {}
}
`);

        // Accessibility Service - highly resilient heuristic parser
        fs.writeFileSync(path.join(pkg, 'WhatsAppAccessibilityService.kt'),
            `package com.edu.whatsappinterceptor
import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

class WhatsAppAccessibilityService : AccessibilityService() {
    private val junkPatterns = listOf("Photo,", "Video,", "Audio,", "GIF,", "Sticker,", "Document,", "Contact card", "Location", "date ")
    private val uiStrings = setOf("Type a message", "Message", "Voice message", "Search", "Online", "typing...", "Calls", "Chats", "Updates", "Communities", "Navigate up", "Attach", "Camera", "Payment")

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val pkg = event.packageName?.toString() ?: return
        if (pkg != "com.whatsapp" && pkg != "com.whatsapp.w4b") return
        try {
            val root = rootInActiveWindow ?: return
            
            // 1. Verify we are inside a chat by finding a non-search EditText
            if (!isChatInput(root)) {
                root.recycle()
                return
            }

            // 2. Get chat name (try ID first, then fallback)
            var chatName = "Unknown"
            val contactNode = findNodeById(root, "com.whatsapp:id/conversation_contact_name")
            if (contactNode != null && !contactNode.text.isNullOrEmpty()) {
                chatName = contactNode.text.toString()
            } else {
                val texts = mutableListOf<String>()
                extractAllTexts(root, texts)
                for (t in texts) {
                    val trimmed = t.trim()
                    if (trimmed.isNotEmpty() && isValidMessage(trimmed)) {
                        chatName = trimmed
                        break
                    }
                }
            }

            // Get screen width for outgoing heuristic
            val rootRect = android.graphics.Rect()
            root.getBoundsInScreen(rootRect)
            val screenWidth = rootRect.width()

            // 3. Extract messages
            extractMessages(root, chatName, screenWidth)

            root.recycle()
        } catch (e: Exception) {}
    }

    private fun extractAllTexts(node: AccessibilityNodeInfo, list: MutableList<String>) {
        if (node.className?.toString() == "android.widget.TextView") {
            val text = node.text?.toString() ?: ""
            if (text.isNotEmpty()) list.add(text)
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            extractAllTexts(child, list)
            child.recycle()
        }
    }

    private fun isChatInput(node: AccessibilityNodeInfo): Boolean {
        if (node.className?.toString() == "android.widget.EditText") {
            val text = node.text?.toString()?.lowercase() ?: ""
            val desc = node.contentDescription?.toString()?.lowercase() ?: ""
            if (!text.contains("search") && !desc.contains("search") && !text.contains("ask meta") && !desc.contains("ask meta")) {
                return true
            }
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            if (isChatInput(child)) {
                child.recycle()
                return true
            }
            child.recycle()
        }
        return false
    }

    private fun findNodeById(node: AccessibilityNodeInfo, id: String): AccessibilityNodeInfo? {
        if (node.viewIdResourceName == id) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val res = findNodeById(child, id)
            if (res != null) {
                child.recycle()
                return res
            }
            child.recycle()
        }
        return null
    }

    private fun extractMessages(node: AccessibilityNodeInfo, chatName: String, screenWidth: Int) {
        val className = node.className?.toString()
        
        if (className == "android.widget.TextView") {
            val text = node.text?.toString()?.trim() ?: ""
            if (text.isNotEmpty() && text != chatName && isValidMessage(text)) {
                val isOutgoing = isOutgoingMessage(node, screenWidth)
                val sender = if (isOutgoing) "You" else chatName
                if (!isDuplicate(chatName, sender, text)) {
                    saveMsg(chatName, sender, text)
                }
            }
        } else if (className == "android.view.ViewGroup" || className == "android.widget.LinearLayout" || className == "android.widget.FrameLayout") {
            val desc = node.contentDescription?.toString()?.trim() ?: ""
            if (desc.isNotEmpty() && desc.contains(Regex("\\\\d{1,2}:\\\\d{2}"))) {
                if (desc.startsWith("You:")) {
                    val msg = desc.substring(4).substringBeforeLast(",").trim()
                    if (msg.isNotEmpty() && msg != chatName && isValidMessage(msg) && !isDuplicate(chatName, "You", msg)) {
                        saveMsg(chatName, "You", msg)
                    }
                } else if (!desc.contains("unread")) {
                    val msg = desc.substringBeforeLast(",").trim()
                    if (msg.isNotEmpty() && msg != chatName && isValidMessage(msg) && !isDuplicate(chatName, chatName, msg)) {
                        saveMsg(chatName, chatName, msg)
                    }
                }
            }
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            extractMessages(child, chatName, screenWidth)
            child.recycle()
        }
    }

    private fun isValidMessage(text: String): Boolean {
        if (uiStrings.contains(text)) return false
        if (isFullTimestamp(text)) return false
        if (isDate(text)) return false
        for (p in junkPatterns) {
            if (text.contains(p, ignoreCase = true)) return false
        }
        return true
    }

    private fun isOutgoingMessage(node: AccessibilityNodeInfo?, screenWidth: Int): Boolean {
        var current = node
        var steps = 0
        while (current != null && steps < 10) {
            val desc = current.contentDescription?.toString() ?: ""
            if (desc.startsWith("You:") || desc.contains("Read") || desc.contains("Delivered") || desc.contains("Sent") || desc.contains("Pending")) {
                return true
            }
            
            val rect = android.graphics.Rect()
            current.getBoundsInScreen(rect)
            val leftDist = rect.left
            val rightDist = screenWidth - rect.right
            
            if (rightDist < leftDist - 50 && rect.width() > 0) {
                return true
            }
            
            current = current.parent
            steps++
        }
        return false
    }

    private fun isFullTimestamp(text: String): Boolean {
        val trimmed = text.trim()
        if (trimmed.matches(Regex("^\\\\d{1,2}:\\\\d{2}\\\\s*(am|pm|AM|PM)$"))) return true
        if (trimmed.matches(Regex("^\\\\d{1,2}:\\\\d{2}$"))) return true 
        return false
    }

    private fun isDate(text: String): Boolean {
        val trimmed = text.trim().lowercase()
        if (trimmed == "today" || trimmed == "yesterday") return true
        if (trimmed.matches(Regex(".*\\\\d{1,2}\\\\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec).*"))) return true
        return false
    }

    private fun isDuplicate(chat: String, sender: String, message: String): Boolean {
        try {
            val prefs = applicationContext.getSharedPreferences("sraas_messages", 0)
            val existing = prefs.getString("messages", "[]") ?: "[]"
            val arr = try { JSONArray(existing) } catch (e: Exception) { return false }
            val len = arr.length()
            val checkCount = minOf(len, 30)
            for (i in (len - checkCount) until len) {
                val obj = arr.getJSONObject(i)
                if (obj.optString("chat") == chat && obj.optString("sender") == sender && obj.optString("message") == message) {
                    return true
                }
            }
        } catch (e: Exception) {}
        return false
    }

    private fun saveMsg(chat: String, sender: String, message: String) {
        try {
            val prefs = applicationContext.getSharedPreferences("sraas_messages", 0)
            val existing = prefs.getString("messages", "[]") ?: "[]"
            val arr = try { JSONArray(existing) } catch (e: Exception) { JSONArray() }
            val obj = JSONObject()
            obj.put("chat", chat)
            obj.put("sender", sender)
            obj.put("message", message)
            obj.put("time", System.currentTimeMillis())
            arr.put(obj)
            while (arr.length() > 500) arr.remove(0)
            prefs.edit().putString("messages", arr.toString()).apply()
        } catch (e: Exception) {}
    }

    override fun onInterrupt() {}
}
`);

        // MessageStoreModule
        fs.writeFileSync(path.join(pkg, 'MessageStoreModule.kt'),
            `package com.edu.whatsappinterceptor
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

class MessageStoreModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
    override fun getName(): String = "MessageStore"
    @ReactMethod fun getMessages(p: Promise) {
        try { val d = reactApplicationContext.getSharedPreferences("sraas_messages",0).getString("messages","[]") ?: "[]"; p.resolve(d) } catch(e:Exception) { p.resolve("[]") }
    }
    @ReactMethod fun clearMessages(p: Promise) {
        try { reactApplicationContext.getSharedPreferences("sraas_messages",0).edit().putString("messages","[]").apply(); p.resolve(true) } catch(e:Exception) { p.resolve(false) }
    }
    @ReactMethod fun addTestMessage(p: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences("sraas_messages",0)
            val arr = try { org.json.JSONArray(prefs.getString("messages","[]")) } catch(e:Exception) { org.json.JSONArray() }
            val obj = org.json.JSONObject(); obj.put("sender","TEST"); obj.put("message","System working!"); obj.put("time",System.currentTimeMillis())
            arr.put(obj); prefs.edit().putString("messages",arr.toString()).apply(); p.resolve(true)
        } catch(e:Exception) { p.resolve(false) }
    }
}
`);

        // MessageStorePackage
        fs.writeFileSync(path.join(pkg, 'MessageStorePackage.kt'),
            `package com.edu.whatsappinterceptor
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
class MessageStorePackage : ReactPackage {
    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(MessageStoreModule(ctx))
    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*,*>> = emptyList()
}
`);

        // Modify MainApplication
        const mainApp = path.join(pkg, 'MainApplication.kt');
        if (fs.existsSync(mainApp)) {
            let c = fs.readFileSync(mainApp, 'utf8');
            if (!c.includes('MessageStorePackage')) {
                c = c.replace('PackageList(this).packages.apply {', 'PackageList(this).packages.apply {\n              add(MessageStorePackage())');
                fs.writeFileSync(mainApp, c);
            }
        }
        return config;
    }]);
    return config;
}
module.exports = withNotificationListenerService;
