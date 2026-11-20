package asia.qiwu.narutorpg;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.junit.Test;

public class NativeSaveVaultTest {
    private static void deleteRecursive(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursive(child);
        }
        file.delete();
    }

    @Test
    public void rollingAutoBackupsKeepLatestThreeWhilePreservingAllManualBackups() throws Exception {
        File tempRoot = Files.createTempDirectory("naruto-vault-test-").toFile();
        try {
            NativeSaveVault vault = new NativeSaveVault(new File(tempRoot, "vault"));

            NativeSaveVault.StagingSession manual = vault.beginBackup("m1", "manual", "manual-save.v2.json.gz", "application/gzip");
            manual.append("MANUAL".getBytes(StandardCharsets.UTF_8));
            vault.commitSession(manual, 120, "漩涡鸣人", 100L);

            for (int i = 1; i <= 5; i++) {
                NativeSaveVault.StagingSession s = vault.beginBackup("a" + i, "auto", "auto-" + i + ".v2.json.gz", "application/gzip");
                s.append(("AUTO_" + i).getBytes(StandardCharsets.UTF_8));
                vault.commitSession(s, 100 + i, "漩涡鸣人", 1000L * i);
            }

            List<NativeSaveVault.BackupRecord> listed = vault.listBackups();
            assertEquals(4, listed.size());
            int autoCount = 0;
            int manualCount = 0;
            List<String> autoNames = new ArrayList<>();
            for (NativeSaveVault.BackupRecord r : listed) {
                if ("auto".equals(r.kind)) { autoCount++; autoNames.add(r.fileName); }
                if ("manual".equals(r.kind)) manualCount++;
            }
            assertEquals(3, autoCount);
            assertEquals(1, manualCount);
            assertTrue(autoNames.contains("auto-5.v2.json.gz"));
            assertTrue(autoNames.contains("auto-4.v2.json.gz"));
            assertTrue(autoNames.contains("auto-3.v2.json.gz"));
            assertFalse(new File(vault.backupsDir, "auto-1.v2.json.gz").exists());
            assertFalse(new File(vault.backupsDir, "auto-2.v2.json.gz").exists());

            byte[] chunk = vault.readChunk("m1", 0L, 64);
            assertEquals("MANUAL", new String(chunk, StandardCharsets.UTF_8));
        } finally {
            deleteRecursive(tempRoot);
        }
    }

    @Test
    public void emergencyZipExportsVaultAndWebViewDataWhileSkippingLockFiles() throws Exception {
        File dataDir = Files.createTempDirectory("naruto-emergency-zip-").toFile();
        File zipOut = File.createTempFile("emergency-", ".zip", dataDir.getParentFile());
        try {
            File idbDir = new File(dataDir, "app_webview/Default/IndexedDB/http_localhost_0.indexeddb.leveldb");
            assertTrue(idbDir.mkdirs());
            Files.write(new File(idbDir, "000003.log").toPath(), "IDB_BYTES".getBytes(StandardCharsets.UTF_8));
            Files.write(new File(idbDir, "LOCK").toPath(), "".getBytes(StandardCharsets.UTF_8));

            File vaultDir = new File(dataDir, "files/vault/backups");
            assertTrue(vaultDir.mkdirs());
            Files.write(new File(vaultDir, "auto-latest.v2.json.gz").toPath(), new byte[] {31, (byte) 139, 8, 0});

            List<String> skipped = new ArrayList<>();
            int exported = NativeSaveVault.zipWebViewStorage(dataDir, zipOut, skipped);
            assertEquals(2, exported);
            assertTrue(skipped.stream().anyMatch(s -> s.contains("LOCK")));

            Set<String> entryNames = new HashSet<>();
            try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(Files.readAllBytes(zipOut.toPath())))) {
                ZipEntry entry;
                while ((entry = zis.getNextEntry()) != null) entryNames.add(entry.getName());
            }
            assertTrue(entryNames.contains("vault_backups/auto-latest.v2.json.gz"));
            assertTrue(entryNames.contains("webview_indexeddb/http_localhost_0.indexeddb.leveldb/000003.log"));
            assertTrue(entryNames.contains("emergency_manifest.txt"));
            assertFalse(entryNames.contains("webview_indexeddb/http_localhost_0.indexeddb.leveldb/LOCK"));
        } finally {
            zipOut.delete();
            deleteRecursive(dataDir);
        }
    }
}
