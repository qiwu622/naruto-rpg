package asia.qiwu.narutorpg;

import android.content.Context;
import android.content.SharedPreferences;

/** Tracks repeated failed startups and WebView renderer OOM/crashes to surface native rescue UI. */
final class BootGuard {
    private static final String PREFS_NAME = "NarutoBootGuard";
    private static final String KEY_FAILURES = "consecutive_failures";
    private static final String KEY_RENDER_CRASHED = "render_crashed";
    private static final String KEY_CRASH_REASON = "last_crash_reason";
    private static final String KEY_LAST_LAUNCH = "last_launch_ms";
    private static final String KEY_LAST_HEALTHY = "last_healthy_ms";
    static final int RECOVERY_THRESHOLD = 2;

    interface Store {
        int getInt(String key, int defValue);
        boolean getBoolean(String key, boolean defValue);
        long getLong(String key, long defValue);
        String getString(String key, String defValue);
        void putValues(int failures, boolean renderCrashed, String reason, long lastLaunch, long lastHealthy);
    }

    static final class State {
        final int consecutiveFailures;
        final boolean renderCrashed;
        final String lastCrashReason;
        final long lastLaunchMs;
        final long lastHealthyMs;

        State(int consecutiveFailures, boolean renderCrashed, String lastCrashReason, long lastLaunchMs, long lastHealthyMs) {
            this.consecutiveFailures = consecutiveFailures;
            this.renderCrashed = renderCrashed;
            this.lastCrashReason = lastCrashReason == null ? "" : lastCrashReason;
            this.lastLaunchMs = lastLaunchMs;
            this.lastHealthyMs = lastHealthyMs;
        }

        boolean shouldOfferRecovery() {
            return consecutiveFailures >= RECOVERY_THRESHOLD || renderCrashed;
        }
    }

    private static Store prefsStore(Context context) {
        final SharedPreferences prefs = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return new Store() {
            @Override public int getInt(String key, int defValue) { return prefs.getInt(key, defValue); }
            @Override public boolean getBoolean(String key, boolean defValue) { return prefs.getBoolean(key, defValue); }
            @Override public long getLong(String key, long defValue) { return prefs.getLong(key, defValue); }
            @Override public String getString(String key, String defValue) { return prefs.getString(key, defValue); }
            @Override public void putValues(int failures, boolean renderCrashed, String reason, long lastLaunch, long lastHealthy) {
                prefs.edit()
                    .putInt(KEY_FAILURES, failures)
                    .putBoolean(KEY_RENDER_CRASHED, renderCrashed)
                    .putString(KEY_CRASH_REASON, reason)
                    .putLong(KEY_LAST_LAUNCH, lastLaunch)
                    .putLong(KEY_LAST_HEALTHY, lastHealthy)
                    .commit();
            }
        };
    }

    static State getState(Context context) {
        return getState(prefsStore(context));
    }

    static State getState(Store store) {
        return new State(
            Math.max(0, store.getInt(KEY_FAILURES, 0)),
            store.getBoolean(KEY_RENDER_CRASHED, false),
            store.getString(KEY_CRASH_REASON, ""),
            store.getLong(KEY_LAST_LAUNCH, 0L),
            store.getLong(KEY_LAST_HEALTHY, 0L)
        );
    }

    static State recordLaunchStart(Context context) {
        return recordLaunchStart(prefsStore(context), System.currentTimeMillis());
    }

    static State recordLaunchStart(Store store, long nowMs) {
        State current = getState(store);
        int nextFailures = current.consecutiveFailures + 1;
        store.putValues(nextFailures, current.renderCrashed, current.lastCrashReason, nowMs, current.lastHealthyMs);
        return new State(nextFailures, current.renderCrashed, current.lastCrashReason, nowMs, current.lastHealthyMs);
    }

    static void markHealthy(Context context) {
        markHealthy(prefsStore(context), System.currentTimeMillis());
    }

    static void markHealthy(Store store, long nowMs) {
        State current = getState(store);
        store.putValues(0, false, "", current.lastLaunchMs, nowMs);
    }

    static State recordRenderProcessCrash(Context context, boolean didCrash, int priority) {
        return recordRenderProcessCrash(prefsStore(context), didCrash, priority);
    }

    static State recordRenderProcessCrash(Store store, boolean didCrash, int priority) {
        State current = getState(store);
        int failures = Math.max(RECOVERY_THRESHOLD, current.consecutiveFailures + 1);
        String reason = didCrash ? "WEBVIEW_RENDER_CRASH" : "WEBVIEW_OOM_KILLED_P" + priority;
        store.putValues(failures, true, reason, current.lastLaunchMs, current.lastHealthyMs);
        return new State(failures, true, reason, current.lastLaunchMs, current.lastHealthyMs);
    }

    static void clearCrashFlags(Context context) {
        clearCrashFlags(prefsStore(context));
    }

    static void clearCrashFlags(Store store) {
        State current = getState(store);
        store.putValues(0, false, "", current.lastLaunchMs, current.lastHealthyMs);
    }

    static void recordGracefulFinish(Context context) {
        recordGracefulFinish(prefsStore(context));
    }

    static void recordGracefulFinish(Store store) {
        State current = getState(store);
        if (!current.renderCrashed && current.consecutiveFailures > 0) {
            store.putValues(0, false, "", current.lastLaunchMs, current.lastHealthyMs);
        }
    }
}
