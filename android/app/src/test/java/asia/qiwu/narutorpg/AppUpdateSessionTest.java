package asia.qiwu.narutorpg;

import org.junit.Test;
import static org.junit.Assert.*;

public class AppUpdateSessionTest {
    @Test public void requiresCompleteIntegrityMetadata() {
        String hash = new String(new char[64]).replace('\0', 'a');
        AppUpdateSession.validateSpec(30604, hash, 30000000);
        for (long version : new long[] {0, -1}) assertThrows(IllegalArgumentException.class, () -> AppUpdateSession.validateSpec(version, hash, 10));
        for (long size : new long[] {0, -1}) assertThrows(IllegalArgumentException.class, () -> AppUpdateSession.validateSpec(30604, hash, size));
        for (String invalid : new String[] {null, "", "abc", hash + "a", hash.replace('a', 'z')}) {
            assertThrows(IllegalArgumentException.class, () -> AppUpdateSession.validateSpec(30604, invalid, 10));
        }
    }
}
