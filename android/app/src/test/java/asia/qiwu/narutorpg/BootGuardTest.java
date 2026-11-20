package asia.qiwu.narutorpg;

import static org.junit.Assert.*;
import org.junit.Test;

public class BootGuardTest {
    private static final class MemoryStore implements BootGuard.Store {
        int failures;
        boolean crashed;
        String reason = "";
        long lastLaunch;
        long lastHealthy;

        @Override public int getInt(String key, int defValue) { return failures; }
        @Override public boolean getBoolean(String key, boolean defValue) { return crashed; }
        @Override public long getLong(String key, long defValue) {
            return "last_launch_ms".equals(key) ? lastLaunch : lastHealthy;
        }
        @Override public String getString(String key, String defValue) { return reason; }
        @Override public void putValues(int failures, boolean renderCrashed, String reason, long lastLaunch, long lastHealthy) {
            this.failures = failures;
            this.crashed = renderCrashed;
            this.reason = reason == null ? "" : reason;
            this.lastLaunch = lastLaunch;
            this.lastHealthy = lastHealthy;
        }
    }

    @Test
    public void triggersRecoveryOnlyAfterRepeatedConsecutiveBootFailuresOrRenderCrash() {
        MemoryStore store = new MemoryStore();
        BootGuard.State first = BootGuard.recordLaunchStart(store, 1000L);
        assertEquals(1, first.consecutiveFailures);
        assertFalse(first.shouldOfferRecovery());

        BootGuard.State second = BootGuard.recordLaunchStart(store, 2000L);
        assertEquals(2, second.consecutiveFailures);
        assertTrue(second.shouldOfferRecovery());

        BootGuard.markHealthy(store, 3000L);
        BootGuard.State recovered = BootGuard.getState(store);
        assertEquals(0, recovered.consecutiveFailures);
        assertFalse(recovered.renderCrashed);
        assertFalse(recovered.shouldOfferRecovery());

        BootGuard.State oom = BootGuard.recordRenderProcessCrash(store, false, 100);
        assertTrue(oom.renderCrashed);
        assertTrue(oom.shouldOfferRecovery());
        assertEquals("WEBVIEW_OOM_KILLED_P100", oom.lastCrashReason);

        BootGuard.clearCrashFlags(store);
        assertFalse(BootGuard.getState(store).shouldOfferRecovery());
    }

    @Test
    public void gracefulFinishClearsLaunchCounterWithoutErasingRenderCrash() {
        MemoryStore store = new MemoryStore();
        assertEquals(1, BootGuard.recordLaunchStart(store, 1000L).consecutiveFailures);
        BootGuard.recordGracefulFinish(store);
        assertEquals(0, BootGuard.getState(store).consecutiveFailures);
        assertFalse(BootGuard.getState(store).shouldOfferRecovery());

        BootGuard.recordLaunchStart(store, 2000L);
        BootGuard.recordLaunchStart(store, 3000L);
        assertTrue(BootGuard.getState(store).shouldOfferRecovery());

        BootGuard.clearCrashFlags(store);
        BootGuard.recordRenderProcessCrash(store, true, 0);
        BootGuard.recordGracefulFinish(store);
        assertTrue(BootGuard.getState(store).renderCrashed);
        assertTrue(BootGuard.getState(store).shouldOfferRecovery());
    }
}
