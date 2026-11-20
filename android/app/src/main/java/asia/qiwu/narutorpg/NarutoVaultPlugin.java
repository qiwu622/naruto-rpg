package asia.qiwu.narutorpg;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "NarutoVault")
public class NarutoVaultPlugin extends Plugin {
    private static final String PREFS = "NarutoVaultPrefs";
    private static final String KEY_AUTO = "auto_enabled";
    private static final String KEY_SAF_URI = "saf_tree_uri";
    private static final String KEY_SAF_LABEL = "saf_tree_label";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, NativeSaveVault.StagingSession> sessions = new HashMap<>();
    private NativeSaveVault vault;
    private volatile File pendingShareFile;
    private volatile String pendingShareFileName;

    @Override
    public void load() {
        vault = NativeSaveVault.forContext(getContext());
    }

    private SharedPreferences prefs() {
        return getContext().getApplicationContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
    }

    private Uri getCustomTreeUri() {
        String raw = prefs().getString(KEY_SAF_URI, "");
        return raw == null || raw.isEmpty() ? null : Uri.parse(raw);
    }

    private static JSObject toJson(NativeSaveVault.BackupRecord r) {
        JSObject o = new JSObject();
        o.put("id", r.id);
        o.put("kind", r.kind);
        o.put("fileName", r.fileName);
        o.put("mimeType", r.mimeType);
        o.put("bytes", r.bytes);
        o.put("turn", r.turn);
        o.put("character", r.character);
        o.put("createdAt", r.createdAt);
        return o;
    }

    @PluginMethod
    public void getConfig(PluginCall call) {
        worker.execute(() -> {
            try {
                List<NativeSaveVault.BackupRecord> backups = vault.listBackups();
                JSObject res = new JSObject();
                res.put("autoEnabled", prefs().getBoolean(KEY_AUTO, true));
                res.put("defaultPath", NativeSaveVault.PUBLIC_RELATIVE_PATH);
                res.put("customDirectoryLabel", prefs().getString(KEY_SAF_LABEL, ""));
                res.put("backupCount", backups.size());
                if (!backups.isEmpty()) res.put("latestBackup", toJson(backups.get(0)));
                call.resolve(res);
            } catch (Exception error) {
                call.reject(error.getMessage(), "VAULT_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void setAutoBackup(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        prefs().edit().putBoolean(KEY_AUTO, enabled).apply();
        JSObject res = new JSObject();
        res.put("autoEnabled", enabled);
        call.resolve(res);
    }

    @PluginMethod
    public void chooseBackupDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        getActivity().runOnUiThread(() -> {
            try {
                startActivityForResult(call, intent, "chooseDirectoryResult");
            } catch (Exception error) {
                call.reject("无法打开系统文件夹选择器", "VAULT_PICKER_FAILED", error);
            }
        });
    }

    @ActivityCallback
    private void chooseDirectoryResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            JSObject res = new JSObject();
            res.put("cancelled", true);
            call.resolve(res);
            return;
        }
        try {
            int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            getContext().getContentResolver().takePersistableUriPermission(uri, flags);
            String label = uri.getLastPathSegment();
            if (label == null || label.isEmpty()) label = uri.toString();
            prefs().edit().putString(KEY_SAF_URI, uri.toString()).putString(KEY_SAF_LABEL, label).apply();
            JSObject res = new JSObject();
            res.put("cancelled", false);
            res.put("label", label);
            call.resolve(res);
        } catch (Exception error) {
            call.reject("保存文件夹权限失败：" + error.getMessage(), "VAULT_FAILED", error);
        }
    }

    @PluginMethod
    public void clearBackupDirectory(PluginCall call) {
        prefs().edit().remove(KEY_SAF_URI).remove(KEY_SAF_LABEL).apply();
        JSObject res = new JSObject();
        res.put("cleared", true);
        call.resolve(res);
    }

    @PluginMethod
    public void beginBackup(PluginCall call) {
        worker.execute(() -> {
            try {
                String id = UUID.randomUUID().toString();
                String kind = call.getString("kind", "manual");
                String fileName = call.getString("fileName", "naruto-backup.v2.json.gz");
                String mimeType = call.getString("mimeType", "application/gzip");
                NativeSaveVault.StagingSession session = vault.beginBackup(id, kind, fileName, mimeType);
                sessions.put(id, session);
                JSObject res = new JSObject();
                res.put("id", id);
                call.resolve(res);
            } catch (Exception error) {
                call.reject(error.getMessage(), "VAULT_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void appendBackup(PluginCall call) {
        worker.execute(() -> {
            try {
                String id = call.getString("id", "");
                NativeSaveVault.StagingSession session = sessions.get(id);
                if (session == null) throw new IllegalArgumentException("备份会话不存在");
                String data = call.getString("data", "");
                if (data.length() > 360000) throw new IllegalArgumentException("备份分片过大");
                session.append(Base64.decode(data, Base64.NO_WRAP));
                call.resolve();
            } catch (Exception error) {
                call.reject(error.getMessage(), "VAULT_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void finishBackup(PluginCall call) {
        worker.execute(() -> {
            String id = call.getString("id", "");
            NativeSaveVault.StagingSession session = sessions.remove(id);
            if (session == null) {
                call.reject("备份会话不存在", "VAULT_FAILED");
                return;
            }
            try {
                int turn = call.getData().optInt("turn", 0);
                String character = call.getString("character", "");
                NativeSaveVault.BackupRecord record = vault.commitSession(session, turn, character, System.currentTimeMillis());
                vault.mirrorToPublicStorage(getContext(), record, getCustomTreeUri());
                call.resolve(toJson(record));
            } catch (Exception error) {
                session.discard();
                call.reject(error.getMessage(), "VAULT_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void cancelBackup(PluginCall call) {
        worker.execute(() -> {
            NativeSaveVault.StagingSession session = sessions.remove(call.getString("id", ""));
            if (session != null) session.discard();
            call.resolve();
        });
    }

    @PluginMethod
    public void listBackups(PluginCall call) {
        worker.execute(() -> {
            try {
                JSArray arr = new JSArray();
                for (NativeSaveVault.BackupRecord r : vault.listBackups()) {
                    arr.put(toJson(r));
                }
                JSObject res = new JSObject();
                res.put("backups", arr);
                call.resolve(res);
            } catch (Exception error) {
                call.reject(error.getMessage(), "VAULT_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void readBackupChunk(PluginCall call) {
        worker.execute(() -> {
            try {
                String id = call.getString("id", "");
                long offset = Math.max(0L, call.getData().optLong("offset", 0L));
                int length = call.getData().optInt("length", FileExportSession.CHUNK_BYTES);
                byte[] chunk = vault.readChunk(id, offset, length);
                JSObject res = new JSObject();
                res.put("data", Base64.encodeToString(chunk, Base64.NO_WRAP));
                res.put("eof", chunk.length < length);
                call.resolve(res);
            } catch (Exception error) {
                call.reject(error.getMessage(), "VAULT_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void exportBackup(PluginCall call) {
        worker.execute(() -> {
            try {
                if (pendingShareFile != null) throw new IllegalStateException("请先完成当前文件另存操作");
                NativeSaveVault.BackupRecord record = vault.findById(call.getString("id", ""));
                if (record == null) throw new IllegalArgumentException("找不到指定备份");
                File source = vault.resolveBackupFile(record);
                if (!source.exists()) throw new IllegalStateException("备份文件不存在");
                pendingShareFile = source;
                pendingShareFileName = record.fileName;
                launchSavePicker(call, record.mimeType, record.fileName);
            } catch (Exception error) {
                call.reject(error.getMessage(), "VAULT_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void exportEmergencyBundle(PluginCall call) {
        worker.execute(() -> {
            try {
                if (pendingShareFile != null) throw new IllegalStateException("请先完成当前文件另存操作");
                String zipName = "naruto-emergency-rescue-" + System.currentTimeMillis() + ".zip";
                File zipFile = File.createTempFile("naruto-rescue-", ".zip", getContext().getCacheDir());
                File dataDir = getContext().getApplicationContext().getFilesDir().getParentFile();
                List<String> skipped = new ArrayList<>();
                NativeSaveVault.zipWebViewStorage(dataDir, zipFile, skipped);
                pendingShareFile = zipFile;
                pendingShareFileName = zipName;
                launchSavePicker(call, "application/zip", zipName);
            } catch (Exception error) {
                call.reject("急救数据包创建失败：" + error.getMessage(), "VAULT_FAILED", error);
            }
        });
    }

    private void launchSavePicker(PluginCall call, String mimeType, String displayName) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, displayName);
        getActivity().runOnUiThread(() -> {
            try {
                startActivityForResult(call, intent, "savePickedFileResult");
            } catch (Exception error) {
                cleanupPendingCacheFile();
                call.reject("无法打开系统保存界面", "VAULT_FAILED", error);
            }
        });
    }

    @ActivityCallback
    private void savePickedFileResult(PluginCall call, ActivityResult activityResult) {
        File source = pendingShareFile;
        String fileName = pendingShareFileName;
        pendingShareFile = null;
        pendingShareFileName = null;
        worker.execute(() -> {
            try {
                if (call == null || source == null) return;
                Uri uri = activityResult.getData() == null ? null : activityResult.getData().getData();
                if (activityResult.getResultCode() != Activity.RESULT_OK || uri == null) {
                    JSObject res = new JSObject();
                    res.put("cancelled", true);
                    call.resolve(res);
                    return;
                }
                try (FileInputStream in = new FileInputStream(source);
                     OutputStream out = getContext().getContentResolver().openOutputStream(uri, "w")) {
                    if (out == null) throw new IllegalStateException("无法写入目标文件");
                    byte[] buf = new byte[32768];
                    int n;
                    while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                    out.flush();
                }
                JSObject res = new JSObject();
                res.put("cancelled", false);
                res.put("fileName", fileName);
                call.resolve(res);
            } catch (Exception error) {
                if (call != null) call.reject("保存未完成：" + error.getMessage(), "VAULT_FAILED", error);
            } finally {
                if (source != null && source.getParentFile() != null && source.getParentFile().equals(getContext().getCacheDir())) {
                    source.delete();
                }
            }
        });
    }

    private void cleanupPendingCacheFile() {
        File source = pendingShareFile;
        pendingShareFile = null;
        pendingShareFileName = null;
        if (source != null && source.getParentFile() != null && source.getParentFile().equals(getContext().getCacheDir())) {
            source.delete();
        }
    }

    @Override
    protected void handleOnDestroy() {
        worker.execute(() -> {
            for (NativeSaveVault.StagingSession session : sessions.values()) session.discard();
            sessions.clear();
            cleanupPendingCacheFile();
        });
        worker.shutdown();
    }
}
