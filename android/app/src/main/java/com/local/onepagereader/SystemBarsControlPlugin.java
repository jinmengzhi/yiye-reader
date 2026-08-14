package com.local.onepagereader;

import android.graphics.Color;
import android.os.Build;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SystemBarsControl")
public class SystemBarsControlPlugin extends Plugin {
    @PluginMethod
    public void setHidden(PluginCall call) {
        boolean statusHidden = call.getBoolean("statusHidden", false);
        boolean navigationHidden = call.getBoolean("navigationHidden", false);
        boolean night = call.getBoolean("night", false);
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();

            // Reapply edge-to-edge on every transition. Calling the Capacitor
            // StatusBar plugin and hiding bars through a second controller can
            // otherwise make certain Android skins restore a black top inset.
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.setStatusBarContrastEnforced(false);
                window.setNavigationBarContrastEnforced(false);
            }

            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(!night);
            controller.setAppearanceLightNavigationBars(!night);
            if (statusHidden || navigationHidden) {
                controller.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            }
            if (statusHidden) controller.hide(WindowInsetsCompat.Type.statusBars());
            else controller.show(WindowInsetsCompat.Type.statusBars());
            if (navigationHidden) controller.hide(WindowInsetsCompat.Type.navigationBars());
            else controller.show(WindowInsetsCompat.Type.navigationBars());
            call.resolve(new JSObject());
        });
    }
}
