package com.ashdelivery.driver;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * The shell's only activity — and the one line that makes the tracker reachable at all.
 *
 * Capacitor discovers plugins that ship as their own npm packages. A plugin class living inside the
 * app, as ours does, is NOT discovered: it has to be registered here. Without this call the bridge
 * simply has no `AshTracker`, so `Capacitor.Plugins.AshTracker` is undefined,
 * `nativeTrackerAvailable()` answers false, the web beacon quietly keeps the old foreground-only
 * behaviour, and the whole Android app does nothing at all — while compiling perfectly and showing
 * the driver a normal-looking screen.
 *
 * The generated `MainActivity` is an empty class body. This file replaces it, so the registration
 * is something a reviewer reads rather than something a code generator was trusted to do.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before `super`, which is where the bridge and its plugin registry are built.
        registerPlugin(AshTrackerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
