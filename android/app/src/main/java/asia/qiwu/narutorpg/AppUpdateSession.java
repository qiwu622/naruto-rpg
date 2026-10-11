package asia.qiwu.narutorpg;

import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.Arrays;
import org.json.JSONObject;

/** System-owned downloads survive a closed WebView. This store contains no game data. */
final class AppUpdateSession {
    static final String APK_URL = "https://www.qiwu.asia/app/android/naruto-rpg.apk";
    private final Context context;
    private final DownloadManager downloads;
    private final SharedPreferences prefs;
    private long verifiedId = -1, verifiedModified = -1;

    AppUpdateSession(Context context) {
        this.context = context;
        downloads = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        prefs = context.getSharedPreferences("naruto_app_update", Context.MODE_PRIVATE);
    }

    static void validateSpec(long version, String sha256, long bytes) {
        if (version <= 0 || bytes <= 0 || sha256 == null || !sha256.matches("[a-fA-F0-9]{64}")) {
            throw new IllegalArgumentException("更新校验信息不完整，请重新检测更新");
        }
    }

    long installedVersion() throws PackageManager.NameNotFoundException {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        return versionOf(info);
    }

    private static long versionOf(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    // The bridge always supplies APK_URL. A package-private URI allows the
    // instrumentation test to exercise DownloadManager against a local fixture.
    JSONObject start(long version, String sha256, long bytes, Uri url) throws Exception {
        validateSpec(version, sha256, bytes);
        long installed = installedVersion();
        if (version < installed) throw new IOException("更新版本低于当前版本，请重新检测更新");
        if (downloads == null) throw new IOException("系统下载服务不可用，请启用下载管理器后重试");
        if (prefs.getLong("version", -1) == version && sha256.equalsIgnoreCase(prefs.getString("sha256", ""))) {
            JSONObject existing = status();
            if (!Arrays.asList("idle", "failed").contains(existing.optString("status"))) return existing;
        }
        cancel();
        File directory = new File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "updates");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建更新目录，请检查可用空间");
        File apk = new File(directory, "naruto-" + version + "-" + sha256.substring(0, 12) + ".apk");
        if (apk.exists() && !apk.delete()) throw new IOException("无法清理上次未完成的更新");
        DownloadManager.Request request = new DownloadManager.Request(url)
            .setTitle("忍者手记 · 下载更新")
            .setDescription("下载后返回 App 完成安装，本地存档保留")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setAllowedOverMetered(true)
            .setDestinationUri(Uri.fromFile(apk));
        long id = downloads.enqueue(request);
        if (!prefs.edit().putLong("id", id).putLong("version", version).putLong("sourceVersion", installed)
            .putString("sha256", sha256.toLowerCase(java.util.Locale.ROOT)).putLong("bytes", bytes).putString("file", apk.getAbsolutePath()).commit()) {
            downloads.remove(id);
            throw new IOException("无法记录更新任务，请检查可用空间");
        }
        return status();
    }

    JSONObject status() throws Exception {
        long id = prefs.getLong("id", -1);
        if (id < 0) return new JSONObject().put("status", "idle");
        if (installedVersion() > prefs.getLong("sourceVersion", Long.MAX_VALUE)
            && installedVersion() >= prefs.getLong("version", Long.MAX_VALUE)) {
            cancel(); return new JSONObject().put("status", "idle");
        }
        JSONObject result = new JSONObject().put("versionCode", prefs.getLong("version", 0))
            .put("totalBytes", prefs.getLong("bytes", 0));
        String failure = prefs.getString("failure", "");
        if (!failure.isEmpty()) return result.put("status", "failed").put("message", failure);
        try (Cursor cursor = downloads.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor == null || !cursor.moveToFirst()) return result.put("status", "failed").put("message", "下载任务已被系统清理，请重试");
            long received = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            result.put("receivedBytes", received);
            int state = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (state == DownloadManager.STATUS_SUCCESSFUL) {
                try { verify(false); return result.put("status", "ready"); }
                catch (Exception error) {
                    String message = error.getMessage() == null ? "更新包校验失败，请重新下载" : error.getMessage();
                    prefs.edit().putString("failure", message).commit();
                    downloads.remove(id);
                    return result.put("status", "failed").put("message", message);
                }
            }
            if (state == DownloadManager.STATUS_FAILED) {
                int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                return result.put("status", "failed").put("message", reason == DownloadManager.ERROR_INSUFFICIENT_SPACE
                    ? "空间不足，请腾出空间后重试；本地存档未修改" : "下载失败（" + reason + "），请检查网络后重试");
            }
            return result.put("status", state == DownloadManager.STATUS_PAUSED ? "paused" : "downloading")
                .put("message", state == DownloadManager.STATUS_PAUSED ? "等待网络恢复，下载会自动继续" : "正在下载更新");
        }
    }

    File verify(boolean force) throws Exception {
        long id = prefs.getLong("id", -1), expected = prefs.getLong("bytes", -1);
        File file = new File(prefs.getString("file", ""));
        File directory = new File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "updates");
        if (id < 0 || !file.getCanonicalFile().getParentFile().equals(directory.getCanonicalFile())
            || !file.isFile() || file.length() != expected) throw new IOException("更新包不完整，请重新下载");
        if (!force && id == verifiedId && file.lastModified() == verifiedModified) return file;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream stream = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024]; int length;
            while ((length = stream.read(buffer)) != -1) digest.update(buffer, 0, length);
        }
        StringBuilder hash = new StringBuilder();
        for (byte value : digest.digest()) hash.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        if (!hash.toString().equals(prefs.getString("sha256", ""))) throw new IOException("更新包校验不一致，请重新检测更新后下载");
        PackageManager manager = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo candidate = manager.getPackageArchiveInfo(file.getAbsolutePath(), flags);
        PackageInfo installed = manager.getPackageInfo(context.getPackageName(), flags);
        if (candidate == null || !context.getPackageName().equals(candidate.packageName)
            || versionOf(candidate) != prefs.getLong("version", -1) || versionOf(candidate) < versionOf(installed)) {
            throw new IOException("更新包版本不匹配，请重新检测更新");
        }
        Signature[] incoming = Build.VERSION.SDK_INT >= 28 && candidate.signingInfo != null ? candidate.signingInfo.getApkContentsSigners() : candidate.signatures;
        Signature[] current = Build.VERSION.SDK_INT >= 28 && installed.signingInfo != null ? installed.signingInfo.getApkContentsSigners() : installed.signatures;
        if (incoming == null || current == null || incoming.length == 0 || incoming.length != current.length
            || !Arrays.asList(incoming).containsAll(Arrays.asList(current))) throw new IOException("安装包签名不匹配，已停止安装，当前 App 与存档保留");
        verifiedId = id; verifiedModified = file.lastModified();
        return file;
    }

    void cancel() {
        long id = prefs.getLong("id", -1);
        if (id >= 0 && downloads != null) downloads.remove(id);
        prefs.edit().clear().commit();
        verifiedId = verifiedModified = -1;
    }
}
