package com.local.onepagereader;

import android.graphics.Color;
import android.os.Build;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;

import java.lang.reflect.Method;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);
        splashScreen.setOnExitAnimationListener(provider -> provider.remove());
        registerPlugin(FolderPickerPlugin.class);
        registerPlugin(SystemBarsControlPlugin.class);
        super.onCreate(savedInstanceState);

        getBridge().getWebView().setVerticalScrollBarEnabled(false);
        getBridge().getWebView().setHorizontalScrollBarEnabled(false);
        try {
            Method callbackMethod = getBridge().getWebView().getClass().getMethod(
                "setCustomSelectionActionModeCallback", ActionMode.Callback.class);
            callbackMethod.invoke(getBridge().getWebView(), new ActionMode.Callback() {
                @Override public boolean onCreateActionMode(ActionMode mode, Menu menu) { return false; }
                @Override public boolean onPrepareActionMode(ActionMode mode, Menu menu) { return false; }
                @Override public boolean onActionItemClicked(ActionMode mode, MenuItem item) { return false; }
                @Override public void onDestroyActionMode(ActionMode mode) { }
            });
        } catch (Exception ignored) {
            // Some WebView implementations do not expose a custom selection callback.
        }

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }

        WindowInsetsControllerCompat insetsController =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        insetsController.setAppearanceLightStatusBars(true);
        insetsController.setAppearanceLightNavigationBars(true);
    }
}
