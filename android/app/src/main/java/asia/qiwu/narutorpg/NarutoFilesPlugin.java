package asia.qiwu.narutorpg;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "NarutoFiles")
public class NarutoFilesPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, FileExportSession> sessions = new HashMap<>();
    private volatile String pickerId;

    @PluginMethod
    public void beginSave(PluginCall call) {
        worker.execute(() -> {
            try {
                String name = call.getString("fileName", "忍者手记存档.json");
                name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
                if (name.trim().isEmpty() || name.length() > 180) throw new IllegalArgumentException("文件名无效");
                String mime = call.getString("mimeType", "application/octet-stream");
                long size = FileExportSession.requireByteCount(call.getData().opt("size"));
                FileExportSession session = new FileExportSession(getContext().getCacheDir(), name, mime, size);
                String id = UUID.randomUUID().toString();
                sessions.put(id, session);
                JSObject result = new JSObject(); result.put("id", id); call.resolve(result);
            } catch (Exception error) { call.reject(error.getMessage(), "EXPORT_FAILED", error); }
        });
    }

    @PluginMethod
    public void appendSave(PluginCall call) {
        worker.execute(() -> {
            try {
                FileExportSession session = requireSession(call);
                String data = call.getString("data", "");
                if (data.length() > 350000) throw new IllegalArgumentException("导出分片过大");
                long offset = FileExportSession.requireByteCount(call.getData().opt("offset"));
                session.append(offset, Base64.decode(data, Base64.NO_WRAP));
                call.resolve();
            } catch (Exception error) { call.reject(error.getMessage(), "EXPORT_FAILED", error); }
        });
    }

    @PluginMethod
    public void finishSave(PluginCall call) {
        worker.execute(() -> {
            try {
                if (pickerId != null) throw new IllegalStateException("请先完成当前文件保存");
                FileExportSession session = requireSession(call);
                session.finish();
                pickerId = call.getString("id");
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(session.mimeType);
                intent.putExtra(Intent.EXTRA_TITLE, session.fileName);
                getActivity().runOnUiThread(() -> {
                    try { startActivityForResult(call, intent, "saveDocumentResult"); }
                    catch (Exception error) { pickerId = null; call.reject("无法打开系统文件保存窗口", "EXPORT_FAILED", error); }
                });
            } catch (Exception error) { call.reject(error.getMessage(), "EXPORT_FAILED", error); }
        });
    }

    @ActivityCallback
    private void saveDocumentResult(PluginCall call, ActivityResult activityResult) {
        String id = pickerId; pickerId = null;
        worker.execute(() -> {
            FileExportSession session = sessions.remove(id);
            if (session == null) { if (call != null) call.reject("导出会话已结束"); return; }
            try {
                if (call == null) return;
                Uri uri = activityResult.getData() == null ? null : activityResult.getData().getData();
                if (activityResult.getResultCode() != Activity.RESULT_OK || uri == null) {
                    JSObject result = new JSObject(); result.put("cancelled", true); call.resolve(result); return;
                }
                if (!"content".equals(uri.getScheme())) throw new IllegalArgumentException("系统返回了无效文件位置");
                try (FileInputStream input = new FileInputStream(session.file);
                     OutputStream output = getContext().getContentResolver().openOutputStream(uri, "w")) {
                    if (output == null) throw new IllegalStateException("无法写入所选位置");
                    byte[] buffer = new byte[32768]; int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    output.flush();
                }
                JSObject result = new JSObject(); result.put("cancelled", false); result.put("fileName", session.fileName); call.resolve(result);
            } catch (Exception error) { if (call != null) call.reject("文件保存未完成：" + error.getMessage(), "EXPORT_FAILED", error); }
            finally { session.discard(); }
        });
    }

    @PluginMethod
    public void cancelSave(PluginCall call) {
        worker.execute(() -> {
            FileExportSession session = sessions.remove(call.getString("id"));
            if (session != null) session.discard();
            call.resolve();
        });
    }

    @PluginMethod
    public void openDownload(PluginCall call) {
        String url = call.getString("url", "");
        if (!"https://www.qiwu.asia/app/android/naruto-rpg.apk".equals(url)) {
            call.reject("更新下载地址无效"); return;
        }
        getActivity().runOnUiThread(() -> {
            try { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); call.resolve(); }
            catch (Exception error) { call.reject("未找到可用于下载的浏览器", "DOWNLOAD_FAILED", error); }
        });
    }

    private FileExportSession requireSession(PluginCall call) {
        FileExportSession session = sessions.get(call.getString("id"));
        if (session == null) throw new IllegalArgumentException("导出会话不存在");
        return session;
    }

    @Override
    protected void handleOnDestroy() {
        worker.execute(() -> {
            for (FileExportSession session : sessions.values()) session.discard();
            sessions.clear();
        });
        worker.shutdown();
    }
}
