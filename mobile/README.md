# FixMi Mobile (Capacitor)

A thin native shell around the real FixMi web app. Rather than bundling a
separate copy of the frontend, this points the app's WebView straight at
your deployed backend's `/app` — the same page the browser version serves,
so there is exactly one frontend to maintain.

## Setup

1. Deploy `fixmi-backend` somewhere reachable over HTTPS (Render, Railway,
   etc. — see the root README).
2. Edit `capacitor.config.json` and replace
   `https://fixmi-backend-production.up.railway.app/app` with your real URL.
3. Install dependencies:
   ```bash
   cd mobile
   npm install
   ```
4. Add the native platform(s) you need — these generate real Android
   Studio / Xcode projects and require their SDKs installed locally
   (not available in this sandbox, so run these on your own machine):
   ```bash
   npm run add:android   # requires Android Studio
   npm run add:ios       # requires Xcode (macOS only)
   ```
5. Open and run/build from the IDE:
   ```bash
   npm run open:android
   npm run open:ios
   ```

Whenever `capacitor.config.json` changes, re-run `npm run sync` before
opening the IDE again.

### Microphone for in-app calls

In-app calls need microphone access. After `add:android`, add these to
`android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

After `add:ios`, add `NSMicrophoneUsageDescription` ("FixMi uses the
microphone for in-app calls with your artisan or customer.") to
`ios/App/App/Info.plist`.

## Why point at a remote URL instead of bundling the frontend?

FixMi's frontend isn't a static/offline-first app — it needs live API
calls, Socket.IO for real-time booking/chat updates, and Paystack's
checkout — all of which assume it's running on the same origin as the
backend. Loading the real deployed page directly means the mobile app is
never out of sync with the web app, and there's no separate build step
that could drift from what `public/app` actually serves.

## App icon / splash screen

Not set up yet — Capacitor's defaults will show until you run
`@capacitor/assets` (or drop icons in `android/app/src/main/res` /
`ios/App/App/Assets.xcassets` directly) with FixMi's branding.

## Push notifications

Not wired up. The backend already pushes real-time events over
Socket.IO while the app is open; a real push channel (e.g.
`@capacitor/push-notifications` + Firebase Cloud Messaging) would be
needed for notifications while the app is closed — out of scope for
this first pass.
