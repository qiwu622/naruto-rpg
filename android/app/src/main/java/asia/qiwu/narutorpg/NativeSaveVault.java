package asia.qiwu.narutorpg;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Pure Java atomic save vault & public storage mirroring engine.
 * Keeps up to AUTO_BACKUP_KEEP rolling auto-backups while preserving all manual backups.
 */
final class NativeSaveVault {
    static final int AUTO_BACKUP_KEEP = 3;
    static final String PUBLIC_RELATIVE_PATH = Environment.DIRECTORY_DOCUMENTS + "/NarutoRPG/Saves";
    private static final String INDEX_FILE_NAME = "index.tsv";

    static final class BackupRecord {
        final String id;
        final String kind;
        final String fileName;
        final String mimeType;
        final long bytes;
        final int turn;
        final String character;
        final long createdAt;

        BackupRecord(String id, String kind, String fileName, String mimeType, long bytes, int turn, String character, long createdAt) {
            this.id = id;
            this.kind = "auto".equals(kind) ? "auto" : "manual";
            this.fileName = sanitizeName(fileName);
            this.mimeType = mimeType == null || mimeType.isEmpty() ? "application/gzip" : mimeType;
            this.bytes = Math.max(0L, bytes);
            this.turn = Math.max(0, turn);
            this.character = sanitizeField(character);
            this.createdAt = createdAt;
        }
    }

    static final class StagingSession {
        final String id;
        final String kind;
        final String fileName;
        final String mimeType;
        final File tempFile;
        private FileOutputStream output;
        private long written;

        StagingSession(String id, String kind, String fileName, String mimeType, File stagingDir) throws IOException {
            if (!stagingDir.exists() && !stagingDir.mkdirs()) throw new IOException("无法创建备份暂存目录");
            this.id = id;
            this.kind = "auto".equals(kind) ? "auto" : "manual";
            this.fileName = sanitizeName(fileName);
            this.mimeType = mimeType == null || mimeType.isEmpty() ? "application/gzip" : mimeType;
            this.tempFile = File.createTempFile("vault-stage-", ".tmp", stagingDir);
            this.output = new FileOutputStream(tempFile);
        }

        void append(byte[] data) throws IOException {
            if (output == null) throw new IOException("备份会话已关闭");
            if (written + data.length > FileExportSession.MAX_BYTES) throw new IOException("备份体积超出上限");
            output.write(data);
            written += data.length;
        }

        long closeStream() throws IOException {
            if (output != null) {
                output.flush();
                output.close();
                output = null;
            }
            return written;
        }

        void discard() {
            if (output != null) {
                try { output.close(); } catch (IOException ignored) { }
                output = null;
            }
            if (tempFile.exists()) tempFile.delete();
        }
    }

    final File rootDir;
    final File backupsDir;
    final File stagingDir;
    final File indexFile;

    NativeSaveVault(File rootDir) {
        this.rootDir = rootDir;
        this.backupsDir = new File(rootDir, "backups");
        this.stagingDir = new File(rootDir, "staging");
        this.indexFile = new File(rootDir, INDEX_FILE_NAME);
    }

    static NativeSaveVault forContext(Context context) {
        return new NativeSaveVault(new File(context.getApplicationContext().getFilesDir(), "vault"));
    }

    private void ensureDirs() throws IOException {
        if (!rootDir.exists() && !rootDir.mkdirs()) throw new IOException("无法创建保险箱目录");
        if (!backupsDir.exists() && !backupsDir.mkdirs()) throw new IOException("无法创建备份目录");
        if (!stagingDir.exists() && !stagingDir.mkdirs()) throw new IOException("无法创建暂存目录");
    }

    static String sanitizeName(String name) {
        String clean = (name == null ? "naruto-backup.v2.json.gz" : name).replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (clean.isEmpty()) clean = "naruto-backup.v2.json.gz";
        if (clean.length() > 160) clean = clean.substring(clean.length() - 160);
        return clean;
    }

    private static String sanitizeField(String value) {
        return value == null ? "" : value.replace('\t', ' ').replace('\r', ' ').replace('\n', ' ').trim();
    }

    StagingSession beginBackup(String id, String kind, String fileName, String mimeType) throws IOException {
        ensureDirs();
        return new StagingSession(id, kind, fileName, mimeType, stagingDir);
    }

    BackupRecord commitSession(StagingSession session, int turn, String character, long nowMs) throws IOException {
        ensureDirs();
        long size = session.closeStream();
        if (size <= 0) {
            session.discard();
            throw new IOException("备份内容为空，未覆盖原记录");
        }
        String storedFileName = sanitizeName(session.fileName);
        File target = new File(backupsDir, storedFileName);
        if (target.exists()) {
            storedFileName = sanitizeName(session.id.substring(0, Math.min(8, session.id.length())) + "-" + storedFileName);
            target = new File(backupsDir, storedFileName);
        }
        if (!session.tempFile.renameTo(target)) {
            copyFile(session.tempFile, target);
            session.tempFile.delete();
        }
        BackupRecord record = new BackupRecord(session.id, session.kind, storedFileName, session.mimeType, size, turn, character, nowMs);
        List<BackupRecord> list = readIndex();
        list.add(record);
        if ("auto".equals(record.kind)) {
            pruneExcessAutoBackups(list);
        }
        writeIndexAtomic(list);
        return record;
    }

    private void pruneExcessAutoBackups(List<BackupRecord> records) {
        List<BackupRecord> autos = new ArrayList<>();
        for (BackupRecord r : records) {
            if ("auto".equals(r.kind)) autos.add(r);
        }
        autos.sort(Comparator.comparingLong((BackupRecord r) -> r.createdAt).reversed());
        if (autos.size() <= AUTO_BACKUP_KEEP) return;
        for (int i = AUTO_BACKUP_KEEP; i < autos.size(); i++) {
            BackupRecord stale = autos.get(i);
            File f = resolveBackupFile(stale);
            if (f != null && f.exists()) f.delete();
            for (Iterator<BackupRecord> it = records.iterator(); it.hasNext(); ) {
                if (it.next().id.equals(stale.id)) {
                    it.remove();
                    break;
                }
            }
        }
    }

    File resolveBackupFile(BackupRecord record) {
        if (record == null) return null;
        return new File(backupsDir, record.fileName);
    }

    BackupRecord findById(String id) throws IOException {
        for (BackupRecord r : readIndex()) {
            if (r.id.equals(id)) return r;
        }
        return null;
    }

    synchronized List<BackupRecord> listBackups() throws IOException {
        List<BackupRecord> list = readIndex();
        list.sort(Comparator.comparingLong((BackupRecord r) -> r.createdAt).reversed());
        return list;
    }

    private synchronized List<BackupRecord> readIndex() throws IOException {
        List<BackupRecord> records = new ArrayList<>();
        if (!indexFile.exists()) return records;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(indexFile), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                String[] cols = line.split("\t", -1);
                if (cols.length < 8) continue;
                BackupRecord r = new BackupRecord(
                    cols[0],
                    cols[1],
                    cols[2],
                    cols[3],
                    parseLongSafe(cols[4], 0L),
                    (int) parseLongSafe(cols[5], 0L),
                    cols[6],
                    parseLongSafe(cols[7], 0L)
                );
                if (resolveBackupFile(r).exists()) records.add(r);
            }
        }
        return records;
    }

    private synchronized void writeIndexAtomic(List<BackupRecord> records) throws IOException {
        ensureDirs();
        File tmp = new File(rootDir, INDEX_FILE_NAME + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            StringBuilder sb = new StringBuilder();
            for (BackupRecord r : records) {
                sb.append(sanitizeField(r.id)).append('\t')
                  .append(sanitizeField(r.kind)).append('\t')
                  .append(sanitizeField(r.fileName)).append('\t')
                  .append(sanitizeField(r.mimeType)).append('\t')
                  .append(r.bytes).append('\t')
                  .append(r.turn).append('\t')
                  .append(sanitizeField(r.character)).append('\t')
                  .append(r.createdAt).append('\n');
            }
            out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
        }
        if (indexFile.exists() && !indexFile.delete()) {
            // Best-effort replace on Windows/POSIX
        }
        if (!tmp.renameTo(indexFile)) {
            copyFile(tmp, indexFile);
            tmp.delete();
        }
    }

    private static long parseLongSafe(String s, long fallback) {
        try { return Long.parseLong(s.trim()); } catch (Exception ignored) { return fallback; }
    }

    private static void copyFile(File src, File dst) throws IOException {
        try (FileInputStream in = new FileInputStream(src); FileOutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            out.flush();
        }
    }

    byte[] readChunk(String id, long offset, int length) throws IOException {
        BackupRecord record = findById(id);
        if (record == null) throw new IOException("找不到外部备份记录");
        File file = resolveBackupFile(record);
        if (!file.exists()) throw new IOException("备份文件不存在");
        int capped = Math.min(Math.max(1, length), 512 * 1024);
        try (FileInputStream in = new FileInputStream(file)) {
            long skipped = 0;
            while (skipped < offset) {
                long s = in.skip(offset - skipped);
                if (s <= 0) break;
                skipped += s;
            }
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[Math.min(capped, 32768)];
            int remaining = capped;
            while (remaining > 0) {
                int n = in.read(buf, 0, Math.min(buf.length, remaining));
                if (n == -1) break;
                baos.write(buf, 0, n);
                remaining -= n;
            }
            return baos.toByteArray();
        }
    }

    /** Mirrors the committed vault file to system Documents/NarutoRPG/Saves/ (+ optional custom SAF folder). */
    void mirrorToPublicStorage(Context context, BackupRecord record, Uri customTreeUri) {
        File source = resolveBackupFile(record);
        if (source == null || !source.exists()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            mirrorViaMediaStore(context, record, source);
        } else {
            mirrorToLegacyExternalDir(context, record, source);
        }
        if (customTreeUri != null) {
            mirrorToSafTree(context, record, source, customTreeUri);
        }
    }

    private void mirrorViaMediaStore(Context context, BackupRecord record, File source) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, record.fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, record.mimeType);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, PUBLIC_RELATIVE_PATH);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri itemUri = null;
        try {
            itemUri = resolver.insert(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
            if (itemUri == null) return;
            try (FileInputStream in = new FileInputStream(source);
                 OutputStream out = resolver.openOutputStream(itemUri, "w")) {
                if (out == null) throw new IOException("MediaStore openOutputStream returned null");
                byte[] buf = new byte[32768];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                out.flush();
            }
            ContentValues clearPending = new ContentValues();
            clearPending.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(itemUri, clearPending, null, null);

            if ("auto".equals(record.kind)) {
                pruneMediaStoreAutoMirrors(resolver);
            }
        } catch (Exception ignored) {
            if (itemUri != null) {
                try { resolver.delete(itemUri, null, null); } catch (Exception ignored2) { }
            }
        }
    }

    private void pruneMediaStoreAutoMirrors(ContentResolver resolver) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        Uri collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        String[] projection = { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.DATE_ADDED };
        String selection = MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ? AND " + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?";
        String[] args = { PUBLIC_RELATIVE_PATH + "%", "auto-%" };
        try (Cursor cursor = resolver.query(collection, projection, selection, args, MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            if (cursor == null) return;
            int idx = 0;
            int idCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
            while (cursor.moveToNext()) {
                if (idx >= AUTO_BACKUP_KEEP) {
                    long mediaId = cursor.getLong(idCol);
                    Uri rowUri = ContentUris.withAppendedId(collection, mediaId);
                    try { resolver.delete(rowUri, null, null); } catch (Exception ignored) { }
                }
                idx++;
            }
        } catch (Exception ignored) { }
    }

    private void mirrorToLegacyExternalDir(Context context, BackupRecord record, File source) {
        try {
            File base = context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
            if (base == null) return;
            File dir = new File(base, "NarutoRPG/Saves");
            if (!dir.exists() && !dir.mkdirs()) return;
            copyFile(source, new File(dir, record.fileName));
            if ("auto".equals(record.kind)) {
                File[] files = dir.listFiles((d, name) -> name.startsWith("auto-") && name.endsWith(".json.gz"));
                if (files != null && files.length > AUTO_BACKUP_KEEP) {
                    java.util.Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
                    for (int i = AUTO_BACKUP_KEEP; i < files.length; i++) files[i].delete();
                }
            }
        } catch (Exception ignored) { }
    }

    private void mirrorToSafTree(Context context, BackupRecord record, File source, Uri treeUri) {
        ContentResolver resolver = context.getContentResolver();
        try {
            String treeDocId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri parentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, treeDocId);
            Uri docUri = DocumentsContract.createDocument(resolver, parentUri, record.mimeType, record.fileName);
            if (docUri == null) return;
            try (FileInputStream in = new FileInputStream(source);
                 OutputStream out = resolver.openOutputStream(docUri, "w")) {
                if (out == null) return;
                byte[] buf = new byte[32768];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                out.flush();
            }
        } catch (Exception ignored) { }
    }

    /**
     * Pure-Java emergency archive creator: bundles vault backups and raw WebView storage directories
     * without invoking WebView or IndexedDB APIs. Skips locked/socket files cleanly without aborting.
     */
    static int zipWebViewStorage(File appDataDir, File targetZipFile, List<String> skippedOut) throws IOException {
        int fileCount = 0;
        if (targetZipFile.getParentFile() != null && !targetZipFile.getParentFile().exists()) {
            targetZipFile.getParentFile().mkdirs();
        }
        try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(targetZipFile))) {
            File vaultDir = new File(appDataDir, "files/vault/backups");
            fileCount += addDirectoryToZip(zos, vaultDir, "vault_backups", skippedOut);

            File webViewIdb = new File(appDataDir, "app_webview/Default/IndexedDB");
            fileCount += addDirectoryToZip(zos, webViewIdb, "webview_indexeddb", skippedOut);

            File webViewLs = new File(appDataDir, "app_webview/Default/Local Storage");
            fileCount += addDirectoryToZip(zos, webViewLs, "webview_localstorage", skippedOut);

            File bootPrefs = new File(appDataDir, "shared_prefs/NarutoBootGuard.xml");
            if (bootPrefs.exists() && bootPrefs.isFile()) {
                fileCount += addFileToZip(zos, bootPrefs, "shared_prefs/NarutoBootGuard.xml", skippedOut);
            }

            zos.putNextEntry(new ZipEntry("emergency_manifest.txt"));
            String manifest = "exportedFiles=" + fileCount + "\nskippedFiles=" + (skippedOut == null ? Collections.emptyList() : skippedOut) + "\n";
            zos.write(manifest.getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
            zos.flush();
        }
        return fileCount;
    }

    private static int addDirectoryToZip(ZipOutputStream zos, File dir, String prefix, List<String> skippedOut) {
        if (dir == null || !dir.exists() || !dir.isDirectory()) return 0;
        File[] children = dir.listFiles();
        if (children == null) return 0;
        int count = 0;
        for (File child : children) {
            String entryName = prefix + "/" + child.getName();
            if (child.isDirectory()) {
                count += addDirectoryToZip(zos, child, entryName, skippedOut);
            } else if (child.isFile()) {
                count += addFileToZip(zos, child, entryName, skippedOut);
            }
        }
        return count;
    }

    private static int addFileToZip(ZipOutputStream zos, File file, String entryName, List<String> skippedOut) {
        String name = file.getName();
        if ("LOCK".equals(name) || name.startsWith("Singleton")) {
            if (skippedOut != null) skippedOut.add(entryName + " (lock)");
            return 0;
        }
        try (FileInputStream in = new FileInputStream(file)) {
            zos.putNextEntry(new ZipEntry(entryName));
            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) != -1) zos.write(buf, 0, n);
            zos.closeEntry();
            return 1;
        } catch (IOException err) {
            try { zos.closeEntry(); } catch (IOException ignored) { }
            if (skippedOut != null) skippedOut.add(entryName + " (" + err.getMessage() + ")");
            return 0;
        }
    }
}
