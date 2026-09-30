package asia.qiwu.narutorpg;

import android.util.Base64;
import android.text.TextUtils;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.GZIPInputStream;

/** HTTP streaming only. All model protocol and game logic remain in shared JS. */
@CapacitorPlugin(name = "NarutoHttp")
public class NarutoHttpPlugin extends Plugin {
    private final ExecutorService requests = Executors.newFixedThreadPool(4);
    private final ExecutorService cancellations = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, Session> sessions = new ConcurrentHashMap<>();
    private static final class Session {
        final AtomicBoolean cancelled = new AtomicBoolean();
        volatile HttpURLConnection connection;
        void disconnect() { if (connection != null) connection.disconnect(); }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void request(PluginCall call) {
        String id = call.getString("id", "");
        if (id.isEmpty() || id.length() > 100 || sessions.size() >= 16) {
            call.reject("网络请求过多或请求标识无效"); return;
        }
        Session session = new Session();
        if (sessions.putIfAbsent(id, session) != null) { call.reject("请求标识重复"); return; }
        call.setKeepAlive(true);
        requests.execute(() -> {
            try {
                URL url = new URL(call.getString("url", ""));
                if (!("https".equals(url.getProtocol()) || "http".equals(url.getProtocol())) || url.getUserInfo() != null) {
                    throw new IllegalArgumentException("模型接口地址无效");
                }
                String method = call.getString("method", "POST");
                if (!("POST".equals(method) || "GET".equals(method) || "HEAD".equals(method))) {
                    throw new IllegalArgumentException("模型接口请求方法无效");
                }
                String body = call.getString("body");
                byte[] payload = body == null ? null : body.getBytes(StandardCharsets.UTF_8);
                if (payload != null && payload.length > 16 * 1024 * 1024) throw new IllegalArgumentException("模型请求超过 16 MB");
                JSObject requestHeaders = call.getObject("headers", new JSObject());
                int status = 0;
                for (int redirect = 0; redirect <= 5; redirect++) {
                    if (session.cancelled.get()) throw new InterruptedException();
                    HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                    session.connection = connection;
                    connection.setConnectTimeout(30000);
                    // Shared AI timeouts and the user's stop button own cancellation.
                    connection.setReadTimeout(0);
                    connection.setInstanceFollowRedirects(false);
                    connection.setRequestMethod(method);
                    connection.setRequestProperty("Accept-Encoding", "identity");
                    for (Iterator<String> keys = requestHeaders.keys(); keys.hasNext();) {
                        String key = keys.next();
                        if (!("host".equalsIgnoreCase(key) || "content-length".equalsIgnoreCase(key) || "accept-encoding".equalsIgnoreCase(key))) {
                            connection.setRequestProperty(key, requestHeaders.getString(key));
                        }
                    }
                    if (payload != null && "POST".equals(method)) {
                        connection.setDoOutput(true);
                        connection.setFixedLengthStreamingMode(payload.length);
                        try (OutputStream output = connection.getOutputStream()) { output.write(payload); }
                    }
                    status = connection.getResponseCode();
                    if (!(status == 301 || status == 302 || status == 303 || status == 307 || status == 308)) break;
                    String location = connection.getHeaderField("Location");
                    if (location == null) break;
                    URL next = new URL(url, location);
                    if (!sameOrigin(url, next) || next.getUserInfo() != null) {
                        throw new IllegalArgumentException("模型接口发生跨域重定向，请填写最终 API 地址");
                    }
                    if (redirect == 5) throw new IllegalArgumentException("模型接口重定向过多");
                    connection.disconnect();
                    if (status == 303 || ((status == 301 || status == 302) && "POST".equals(method))) { method = "GET"; payload = null; }
                    url = next;
                }
                if (session.cancelled.get()) throw new InterruptedException();
                HttpURLConnection connection = session.connection;
                boolean gzip = "gzip".equalsIgnoreCase(connection.getContentEncoding());
                JSObject headers = new JSObject();
                for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                    String key = header.getKey();
                    if (key == null || (gzip && ("content-encoding".equalsIgnoreCase(key) || "content-length".equalsIgnoreCase(key)))) continue;
                    headers.put(key, TextUtils.join(", ", header.getValue()));
                }
                JSObject start = new JSObject(); start.put("type", "headers"); start.put("status", status); start.put("headers", headers); start.put("url", url.toString());
                call.resolve(start);
                if (!("HEAD".equals(method) || status == 204 || status == 205 || status == 304)) {
                    InputStream raw = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                    if (raw != null) {
                        try (InputStream input = gzip ? new GZIPInputStream(raw) : raw) {
                            byte[] buffer = new byte[16384]; int count; long total = 0;
                            while ((count = input.read(buffer)) != -1) {
                                if (session.cancelled.get()) throw new InterruptedException();
                                total += count;
                                if (total > 32 * 1024 * 1024) throw new IllegalArgumentException("模型响应超过 32 MB");
                                JSObject chunk = new JSObject(); chunk.put("type", "data");
                                chunk.put("data", Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP)); call.resolve(chunk);
                            }
                        }
                    }
                }
                call.setKeepAlive(false);
                JSObject end = new JSObject(); end.put("type", "end"); call.resolve(end);
            } catch (Exception error) {
                call.setKeepAlive(false);
                if (session.cancelled.get() || error instanceof InterruptedException) call.reject("已取消生成", "ABORT_ERR");
                else call.reject("模型网络请求失败：" + error.getMessage(), "HTTP_FAILED", error);
            } finally { sessions.remove(id); session.disconnect(); }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Session session = sessions.get(call.getString("id", ""));
        if (session != null) { session.cancelled.set(true); cancellations.execute(session::disconnect); }
        call.resolve();
    }

    private static boolean sameOrigin(URL a, URL b) {
        int aPort = a.getPort() == -1 ? a.getDefaultPort() : a.getPort();
        int bPort = b.getPort() == -1 ? b.getDefaultPort() : b.getPort();
        return a.getProtocol().equals(b.getProtocol()) && a.getHost().equalsIgnoreCase(b.getHost()) && aPort == bPort;
    }

    @Override
    protected void handleOnDestroy() {
        for (Session session : sessions.values()) {
            session.cancelled.set(true); cancellations.execute(session::disconnect);
        }
        requests.shutdownNow(); cancellations.shutdown();
    }
}
