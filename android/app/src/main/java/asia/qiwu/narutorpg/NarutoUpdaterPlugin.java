package asia.qiwu.narutorpg;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

@CapacitorPlugin(name = "NarutoUpdater")
public class NarutoUpdaterPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private AppUpdateSession session;
    @Override public void load() { session = new AppUpdateSession(getContext()); }
    interface Operation { JSONObject run() throws Exception; }
    private void execute(PluginCall call, Operation operation) {
        worker.execute(() -> {
            try { call.resolve(new JSObject(operation.run().toString())); }
            catch (Exception error) { call.reject(error.getMessage() == null ? "更新操作失败，请重试" : error.getMessage()); }
        });
    }
    @PluginMethod public void download(PluginCall call) {
        execute(call, () -> session.start(call.getData().optLong("versionCode", -1), call.getString("sha256"),
            call.getData().optLong("sizeBytes", -1), Uri.parse(AppUpdateSession.APK_URL)));
    }
    @PluginMethod public void getStatus(PluginCall call) { execute(call, () -> session.status()); }
    @PluginMethod public void cancel(PluginCall call) {
        execute(call, () -> { session.cancel(); return new JSONObject().put("status", "idle"); });
    }
    @PluginMethod public void install(PluginCall call) {
        worker.execute(() -> {
            try {
                File file = session.verify(true);
                getActivity().runOnUiThread(() -> {
                    try {
                        boolean permission = Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls();
                        Intent intent;
                        if (permission) intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                        else {
                            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
                            intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        }
                        getActivity().startActivity(intent);
                        JSObject result = new JSObject(); result.put("requiresPermission", permission); call.resolve(result);
                    } catch (Exception error) { call.reject("无法打开系统安装界面：" + error.getMessage()); }
                });
            } catch (Exception error) { call.reject(error.getMessage()); }
        });
    }
    @Override protected void handleOnDestroy() { worker.shutdown(); }
}
