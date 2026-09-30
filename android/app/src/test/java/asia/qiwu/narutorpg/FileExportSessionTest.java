package asia.qiwu.narutorpg;

import static org.junit.Assert.*;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.Test;

public class FileExportSessionTest {
    @Test
    public void jsonBridgeAcceptsIntegerLongAndWholeDoubleByteCounts() throws Exception {
        assertEquals(720063L, FileExportSession.requireByteCount(Integer.valueOf(720063)));
        assertEquals(262144L, FileExportSession.requireByteCount(Long.valueOf(262144)));
        assertEquals(0L, FileExportSession.requireByteCount(Double.valueOf(0)));
        for (Object invalid : new Object[] { null, "10", -1, 1.5, Double.NaN, Double.POSITIVE_INFINITY, FileExportSession.MAX_BYTES + 1 }) {
            try { FileExportSession.requireByteCount(invalid); fail("invalid byte count was accepted"); }
            catch (java.io.IOException expected) { }
        }
    }
    @Test
    public void orderedChunksPreserveBinaryBytesAndCleanUp() throws Exception {
        File directory = Files.createTempDirectory("naruto-export-test-").toFile();
        FileExportSession session = new FileExportSession(directory, "旧档.json.gz", "application/gzip", 5);
        try {
            session.append(0, new byte[] {0, (byte) 255, 10});
            session.append(3, new byte[] {13, 42});
            session.finish();
            assertArrayEquals(new byte[] {0, (byte) 255, 10, 13, 42}, Files.readAllBytes(session.file.toPath()));
            try { session.append(5, new byte[] {}); fail("finished exports must reject writes"); }
            catch (IOException expected) { }
        } finally { session.discard(); assertFalse(session.file.exists()); directory.delete(); }
    }

    @Test
    public void missingDuplicateAndOversizedChunksDoNotCorruptStaging() throws Exception {
        File directory = Files.createTempDirectory("naruto-export-test-").toFile();
        FileExportSession session = new FileExportSession(directory, "档.json", "application/json", 3);
        try {
            session.append(0, new byte[] {1});
            try { session.finish(); fail("truncated file cannot be offered to the picker"); } catch (IOException expected) { }
            for (int offset : new int[] {0, 2}) {
                try { session.append(offset, new byte[] {7}); fail("out-of-order data must be rejected"); } catch (IOException expected) { }
            }
            try { session.append(1, new byte[] {2, 3, 4}); fail("overrun must be rejected"); } catch (IOException expected) { }
            session.append(1, new byte[] {2, 3}); session.finish();
            assertArrayEquals(new byte[] {1, 2, 3}, Files.readAllBytes(session.file.toPath()));
        } finally { session.discard(); directory.delete(); }
    }
}
