package asia.qiwu.narutorpg;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativeRuntimeTest {
    @Test
    public void localProjectBootsWithNativeBridgeAndSharedSaveLibrary() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        assertEquals("asia.qiwu.narutorpg", context.getPackageName());
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        assertNotNull(intent);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(intent);
        try {
            String value = null;
            long deadline = System.currentTimeMillis() + 45000;
            while (System.currentTimeMillis() < deadline) {
                CountDownLatch evaluated = new CountDownLatch(1);
                AtomicReference<String> result = new AtomicReference<>();
                instrumentation.runOnMainSync(() -> activity.getBridge().getWebView().evaluateJavascript(
                    "JSON.stringify({platform:window.Capacitor?.getPlatform?.(),native:window.Capacitor?.isNativePlatform?.(),save:!!document.querySelector('#btn-save-library'),files:!!window.Capacitor?.Plugins?.NarutoFiles,http:!!window.Capacitor?.Plugins?.NarutoHttp,remote:!!document.querySelector('.topbar-btn--multiplayer'),sw:!!navigator.serviceWorker?.controller})",
                    text -> { result.set(text); evaluated.countDown(); }
                ));
                assertTrue("WebView did not answer", evaluated.await(5, TimeUnit.SECONDS));
                value = result.get();
                Object decoded = new JSONTokener(value).nextValue();
                if (decoded instanceof String) {
                    JSONObject runtime = new JSONObject((String) decoded);
                    if (runtime.optBoolean("save")) {
                        assertEquals("android", runtime.getString("platform"));
                        assertTrue(runtime.getBoolean("native"));
                        assertTrue("Native file bridge is missing", runtime.getBoolean("files"));
                        assertTrue("Native streaming bridge is missing", runtime.getBoolean("http"));
                        assertTrue("Shared multiplayer entry must be available in this release", runtime.getBoolean("remote"));
                        assertFalse("Web service workers must not cache old APK assets", runtime.getBoolean("sw"));
                        instrumentation.runOnMainSync(() -> {
                            View decor = activity.getWindow().getDecorView();
                            View webView = activity.getBridge().getWebView();
                            WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
                            assertNotNull("Native window insets are missing", insets);
                            Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                            int[] window = new int[2], web = new int[2];
                            decor.getLocationOnScreen(window);
                            webView.getLocationOnScreen(web);
                            assertTrue("Top controls overlap status bar or cutout", web[1] >= window[1] + safe.top);
                            assertTrue("Page overlaps left cutout", web[0] >= window[0] + safe.left);
                            assertTrue("Page overlaps right cutout", web[0] + webView.getWidth() <= window[0] + decor.getWidth() - safe.right);
                            assertTrue("Footer overlaps Android navigation bar", web[1] + webView.getHeight() <= window[1] + decor.getHeight() - safe.bottom);
                            android.util.Log.i("NarutoSafeArea", "window=" + decor.getWidth() + "x" + decor.getHeight()
                                + "; web=" + web[0] + "," + web[1] + "," + webView.getWidth() + "," + webView.getHeight()
                                + "; safe=" + safe.left + "," + safe.top + "," + safe.right + "," + safe.bottom);
                        });
                        return;
                    }
                }
                Thread.sleep(250);
            }
            fail("Shared application UI did not become ready: " + value);
        } finally { instrumentation.runOnMainSync(activity::finish); }
    }
}
