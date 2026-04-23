# How to Build the Real WhatsApp Interceptor APK

To make this app work with real WhatsApp messages on your phone, you must follow these steps:

## 1. Prerequisites
- Install **EAS CLI**: `npm install -g eas-cli`
- Create an Expo account and run `eas login`

## 2. Configuration for Native Logic
Since Expo Go doesn't support system-wide notification listening, you must add the native service.

### Add this to your `app.json`:
```json
{
  "expo": {
    "android": {
      "package": "com.yourname.whatsappinterceptor",
      "permissions": ["BIND_NOTIFICATION_LISTENER_SERVICE"]
    }
  }
}
```

### Native Code (NotificationService.java)
You need to put this in your Android project folder (after running `npx expo prebuild`):
`android/app/src/main/java/com/yourname/whatsappinterceptor/NotificationService.java`

```java
package com.yourname.whatsappinterceptor;

import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.os.Bundle;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

public class NotificationService extends NotificationListenerService {
    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn.getPackageName().equals("com.whatsapp")) {
            Bundle extras = sbn.getNotification().extras;
            String sender = extras.getString("android.title");
            CharSequence body = extras.getCharSequence("android.text");

            if (sender != null && body != null) {
                WritableMap params = Arguments.createMap();
                params.putString("sender", sender);
                params.putString("message", body.toString());
                
                // Emit event to React Native
                getReactApplicationContext()
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit("onNotification", params);
            }
        }
    }
}
```

## 3. Build the APK
Run this command in the project folder:
```bash
eas build -p android --profile development
```
Once the build is finished, you will get a link to download the **.apk**. Install it on your phone.

## 4. Final Setup
1.  Open the installed app.
2.  Click **"Open Settings"** and enable **"Notification Access"** for your app.
3.  Start the Remote Console on your computer (`node server.js`).
4.  Open WhatsApp and start messaging! The messages will appear on your computer screen.
