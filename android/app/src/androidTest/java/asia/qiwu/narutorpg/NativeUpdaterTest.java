package asia.qiwu.narutorpg;

import android.content.Context;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.concurrent.*;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class NativeUpdaterTest {
    // Invoked separately by the device UI harness; leaves one verified fixture
    // for the real plugin/system installer. Only runs on the dedicated emulator.
    @Test public void prepareInstallerFixture() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File apk = new File(context.getPackageResourcePath());
        AppUpdateSession session = new AppUpdateSession(context);
        try (Fixture fixture = new Fixture(apk)) {
            session.start(session.installedVersion(), hash(apk), apk.length(), fixture.uri());
            JSONObject ready = waitUntilDone(session);
            assertEquals(ready.toString(), "ready", ready.getString("status"));
        }
    }

    @Test public void systemDownloadResumesAndVerifiesTheInstalledSignature() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File apk = new File(context.getPackageResourcePath());
        AppUpdateSession session = new AppUpdateSession(context);
        try (Fixture fixture = new Fixture(apk)) {
            String sha = hash(apk);
            session.start(session.installedVersion(), sha, apk.length(), fixture.uri());
            // Recreate the app-side controller while the system continues download.
            AppUpdateSession reopened = new AppUpdateSession(context);
            JSONObject ready = waitUntilDone(reopened);
            assertEquals(ready.toString(), "ready", ready.getString("status"));
            assertEquals(apk.length(), reopened.verify(true).length());
            reopened.cancel();
            assertEquals("idle", reopened.status().getString("status"));
            reopened.start(reopened.installedVersion(), sha, apk.length(), fixture.uri());
            reopened.cancel();
            assertEquals("idle", new AppUpdateSession(context).status().getString("status"));
        } finally { session.cancel(); }
    }

    @Test public void alteredDownloadCannotReachTheInstaller() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File apk = new File(context.getPackageResourcePath());
        AppUpdateSession session = new AppUpdateSession(context);
        try (Fixture fixture = new Fixture(apk)) {
            session.start(session.installedVersion(), new String(new char[64]).replace('\0', '0'), apk.length(), fixture.uri());
            JSONObject state = waitUntilDone(session);
            assertEquals(state.toString(), "failed", state.getString("status"));
            assertTrue(state.getString("message").contains("校验"));
            try { session.verify(true); fail("Corrupted download must not be installable"); }
            catch (IOException expected) { /* The downloaded file has also been removed. */ }
        } finally { session.cancel(); }
    }

    private static JSONObject waitUntilDone(AppUpdateSession session) throws Exception {
        long deadline = System.currentTimeMillis() + 90000;
        JSONObject status = null;
        while (System.currentTimeMillis() < deadline) {
            status = session.status();
            if (status.optString("status").equals("ready") || status.optString("status").equals("failed")) return status;
            Thread.sleep(250);
        }
        throw new IOException("System download timed out: " + status);
    }
    private static String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream stream = new FileInputStream(file)) {
            byte[] bytes = new byte[65536]; int n;
            while ((n = stream.read(bytes)) >= 0) digest.update(bytes, 0, n);
        }
        StringBuilder value = new StringBuilder();
        for (byte b : digest.digest()) value.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return value.toString();
    }
    private static final class Fixture implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"));
        final ExecutorService workers = Executors.newCachedThreadPool();
        Fixture(File file) throws IOException {
            workers.submit(() -> {
                while (!server.isClosed()) try {
                    Socket socket = server.accept();
                    workers.submit(() -> {
                        try (Socket client = socket; InputStream input = new FileInputStream(file)) {
                            BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream()));
                            for (String line; (line = reader.readLine()) != null && !line.isEmpty();) {}
                            OutputStream output = client.getOutputStream();
                            output.write(("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.android.package-archive\r\nContent-Length: " + file.length() + "\r\nConnection: close\r\n\r\n").getBytes("US-ASCII"));
                            byte[] bytes = new byte[65536]; int n;
                            while ((n = input.read(bytes)) >= 0) output.write(bytes, 0, n);
                        } catch (IOException ignored) { /* Cancellation closes the socket. */ }
                    });
                } catch (IOException stopped) { break; }
            });
        }
        Uri uri() { return Uri.parse("http://127.0.0.1:" + server.getLocalPort() + "/update.apk"); }
        public void close() throws IOException { server.close(); workers.shutdownNow(); }
    }
}
