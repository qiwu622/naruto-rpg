package asia.qiwu.narutorpg;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    static final String ACTION_RECOVERY = "asia.qiwu.narutorpg.ACTION_RECOVERY";

    private ActivityResultLauncher<Intent> emergencyExportLauncher;
    private File pendingEmergencyZip;
    private boolean recoveryDialogShowing;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NarutoFilesPlugin.class);
        registerPlugin(NarutoHttpPlugin.class);
        registerPlugin(NarutoCloudPlugin.class);
        registerPlugin(NarutoUpdaterPlugin.class);
        registerPlugin(NarutoVaultPlugin.class);

        emergencyExportLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                File zipFile = pendingEmergencyZip;
                pendingEmergencyZip = null;
                if (zipFile == null) return;
                Uri uri = result.getData() == null ? null : result.getData().getData();
                if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
                    zipFile.delete();
                    return;
                }
                Executors.newSingleThreadExecutor().execute(() -> {
                    try (FileInputStream in = new FileInputStream(zipFile);
                         OutputStream out = getContentResolver().openOutputStream(uri, "w")) {
                        if (out == null) throw new IllegalStateException("无法打开目标位置");
                        byte[] buf = new byte[32768];
                        int n;
                        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                        out.flush();
                        runOnUiThread(() -> Toast.makeText(this, "急救数据包已保存，可解压或导入恢复", Toast.LENGTH_LONG).show());
                    } catch (Exception err) {
                        runOnUiThread(() -> Toast.makeText(this, "导出失败：" + err.getMessage(), Toast.LENGTH_LONG).show());
                    } finally {
                        zipFile.delete();
                    }
                });
            }
        );

        super.onCreate(savedInstanceState);
        if (getBridge() == null) return;

        // Fit the entire shared page once; CSS must not add these native insets again.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().getDecorView().setBackgroundColor(Color.rgb(3, 4, 6));
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(false);
            controller.setAppearanceLightNavigationBars(false);
        }
        WebView webView = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets safe = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars()
                | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams layout = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
            if (layout.leftMargin != safe.left || layout.topMargin != safe.top
                || layout.rightMargin != safe.right || layout.bottomMargin != safe.bottom) {
                layout.setMargins(safe.left, safe.top, safe.right, safe.bottom);
                view.setLayoutParams(layout);
            }
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(webView);

        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                boolean didCrash = false;
                int priority = 0;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail != null) {
                    didCrash = detail.didCrash();
                    priority = detail.rendererPriorityAtExit();
                }
                BootGuard.recordRenderProcessCrash(MainActivity.this, didCrash, priority);
                runOnUiThread(() -> showNativeRescueDialog(
                    "页面因内存不足或渲染进程异常中断",
                    "您的存档仍保留在应用数据与「文档/NarutoRPG/Saves」目录中。建议立即导出急救数据包或打开存档救援页面。"
                ));
                return true;
            }
        });

        boolean isRecoveryAction = getIntent() != null && ACTION_RECOVERY.equals(getIntent().getAction());
        if (isRecoveryAction) {
            BootGuard.clearCrashFlags(this);
            navigateToRecovery(webView);
        } else if (savedInstanceState == null) {
            BootGuard.State previousBoot = BootGuard.getState(this);
            BootGuard.recordLaunchStart(this);
            if (previousBoot.shouldOfferRecovery()) {
                webView.post(() -> showNativeRescueDialog(
                    "检测到上次启动异常中断",
                    "如果大存档导致无法进入游戏，可以直接在此导出全部本机数据急救包，或进入「存档救援」压缩续玩。"
                ));
            }
        }
    }

    @Override
    public void onDestroy() {
        if (isFinishing()) {
            BootGuard.recordGracefulFinish(this);
        }
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && ACTION_RECOVERY.equals(intent.getAction()) && getBridge() != null && getBridge().getWebView() != null) {
            BootGuard.clearCrashFlags(this);
            navigateToRecovery(getBridge().getWebView());
        }
    }

    private void navigateToRecovery(WebView webView) {
        if (webView == null || getBridge() == null) return;
        webView.post(() -> webView.loadUrl(getBridge().getLocalUrl() + "/recovery.html"));
    }

    private void showNativeRescueDialog(String title, String message) {
        if (isFinishing() || recoveryDialogShowing) return;
        recoveryDialogShowing = true;
        new AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setCancelable(false)
            .setPositiveButton("进入存档救援", (dialog, which) -> {
                recoveryDialogShowing = false;
                BootGuard.clearCrashFlags(this);
                recreateInRecoveryMode();
            })
            .setNeutralButton("导出全部急救包 (.zip)", (dialog, which) -> {
                recoveryDialogShowing = false;
                startNativeEmergencyZipExport();
            })
            .setNegativeButton("重置保护并继续", (dialog, which) -> {
                recoveryDialogShowing = false;
                BootGuard.clearCrashFlags(this);
            })
            .show();
    }

    private void recreateInRecoveryMode() {
        Intent recoveryIntent = new Intent(this, MainActivity.class);
        recoveryIntent.setAction(ACTION_RECOVERY);
        recoveryIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        finish();
        startActivity(recoveryIntent);
    }

    private void startNativeEmergencyZipExport() {
        Toast.makeText(this, "正在打包全部本机存档与外部保险箱…", Toast.LENGTH_SHORT).show();
        Executors.newSingleThreadExecutor().execute(() -> {
            try {
                File dataDir = getApplicationContext().getFilesDir().getParentFile();
                File zipFile = File.createTempFile("naruto-native-rescue-", ".zip", getCacheDir());
                List<String> skipped = new ArrayList<>();
                NativeSaveVault.zipWebViewStorage(dataDir, zipFile, skipped);
                pendingEmergencyZip = zipFile;
                Intent createIntent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                createIntent.addCategory(Intent.CATEGORY_OPENABLE);
                createIntent.setType("application/zip");
                createIntent.putExtra(Intent.EXTRA_TITLE, "naruto-emergency-rescue-" + System.currentTimeMillis() + ".zip");
                runOnUiThread(() -> emergencyExportLauncher.launch(createIntent));
            } catch (Exception err) {
                runOnUiThread(() -> Toast.makeText(this, "打包急救包失败：" + err.getMessage(), Toast.LENGTH_LONG).show());
            }
        });
    }
}
