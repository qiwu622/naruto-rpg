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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
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
    private final ExecutorService cloudRequests = Executors.newFixedThreadPool(2);
    private final ExecutorService cancellations = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, Session> sessions = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, File> cloudBodies = new ConcurrentHashMap<>();
    private static final long CLOUD_MAX_BYTES = 68L * 1024 * 1024;
    @Override
    public void load() {
        File[] files = getContext().getCacheDir().listFiles((dir, name) -> name.startsWith("cloud-upload-") && name.endsWith(".bin"));
        if (files != null) for (File file : files) file.delete();
    }
    private static final class Session {
        final boolean cloud;
        Session(boolean cloud) { this.cloud = cloud; }
        final AtomicBoolean cancelled = new AtomicBoolean();
        volatile HttpURLConnection connection;
        volatile File body;
        void disconnect() { if (connection != null) connection.disconnect(); }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void request(PluginCall call) {
        String id = call.getString("id", "");
        boolean cloud = Boolean.TRUE.equals(call.getBoolean("cloud", false));
        long sameChannel = sessions.values().stream().filter(session -> session.cloud == cloud).count();
        if (id.isEmpty() || id.length() > 100 || sameChannel >= (cloud ? 8 : 16)) {
            call.reject("网络请求过多或请求标识无效"); return;
        }
        Session session = new Session(cloud);
        if (sessions.putIfAbsent(id, session) != null) { call.reject("请求标识重复"); return; }
        call.setKeepAlive(true);
        (cloud ? cloudRequests : requests).execute(() -> {
            try {
                URL url = new URL(call.getString("url", ""));
                if (cloud && (!NarutoCloudPlugin.ORIGIN.equals(url.getProtocol() + "://" + url.getHost())
                    || (url.getPort() != -1 && url.getPort() != 443) || url.getUserInfo() != null
                    || !(url.getPath().startsWith("/auth/") || url.getPath().startsWith("/api/")))) {
                    throw new IllegalArgumentException("云端地址无效");
                }
                if (!("https".equals(url.getProtocol()) || "http".equals(url.getProtocol())) || url.getUserInfo() != null) {
                    throw new IllegalArgumentException("模型接口地址无效");
                }
                String method = call.getString("method", "POST");
                if (!("POST".equals(method) || "GET".equals(method) || "HEAD".equals(method)
                    || (cloud && ("PUT".equals(method) || "PATCH".equals(method) || "DELETE".equals(method))))) {
                    throw new IllegalArgumentException("模型接口请求方法无效");
                }
                String body = call.getString("body");
                byte[] payload = body == null ? null : body.getBytes(StandardCharsets.UTF_8);
                File binaryBody = cloud ? cloudBodies.remove(call.getString("bodyId", "")) : null;
                session.body = binaryBody;
                JSObject cloudSession = cloud && !Boolean.TRUE.equals(call.getBoolean("anonymous", false))
                    ? NarutoCloudPlugin.readSession(getContext()) : null;
                if (payload != null && payload.length > 16 * 1024 * 1024) throw new IllegalArgumentException("模型请求超过 16 MB");
                JSObject requestHeaders = call.getObject("headers", new JSObject());
                int status = 0;
                for (int redirect = 0; redirect <= 5; redirect++) {
                    if (session.cancelled.get()) throw new InterruptedException();
                    HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                    session.connection = connection;
                    connection.setConnectTimeout(cloud ? 10000 : 30000);
                    // Shared AI timeouts and the user's stop button own cancellation.
                    connection.setReadTimeout(cloud ? 30000 : 0);
                    connection.setInstanceFollowRedirects(false);
                    connection.setRequestMethod(method);
                    connection.setRequestProperty("Accept-Encoding", "identity");
                    for (Iterator<String> keys = requestHeaders.keys(); keys.hasNext();) {
                        String key = keys.next();
                        if (!("host".equalsIgnoreCase(key) || "content-length".equalsIgnoreCase(key) || "accept-encoding".equalsIgnoreCase(key)
                            || (cloud && ("authorization".equalsIgnoreCase(key) || "cookie".equalsIgnoreCase(key))))) {
                            connection.setRequestProperty(key, requestHeaders.getString(key));
                        }
                    }
                    if (cloudSession != null) connection.setRequestProperty("Authorization", "Bearer " + cloudSession.getString("token"));
                    if ((payload != null || binaryBody != null) && ("POST".equals(method) || "PUT".equals(method) || "PATCH".equals(method))) {
                        connection.setDoOutput(true);
                        connection.setFixedLengthStreamingMode(binaryBody == null ? payload.length : binaryBody.length());
                        try (OutputStream output = connection.getOutputStream()) {
                            if (binaryBody == null) output.write(payload);
                            else try (InputStream input = new FileInputStream(binaryBody)) {
                                byte[] buffer = new byte[65536]; int count;
                                while ((count = input.read(buffer)) != -1) {
                                    if (session.cancelled.get()) throw new InterruptedException();
                                    output.write(buffer, 0, count);
                                }
                            }
                        }
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
                    if (status == 303 || ((status == 301 || status == 302) && "POST".equals(method))) { method = "GET"; payload = null; binaryBody = null; }
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
                                if (total > (cloud ? CLOUD_MAX_BYTES : 32 * 1024 * 1024)) throw new IllegalArgumentException("网络响应过大");
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
            } finally { sessions.remove(id); session.disconnect(); if (session.body != null) session.body.delete(); }
        });
    }

    @PluginMethod
    public synchronized void beginCloudBody(PluginCall call) {
        try {
            long cutoff = System.currentTimeMillis() - 5 * 60 * 1000;
            for (Map.Entry<String, File> entry : cloudBodies.entrySet()) {
                if (entry.getValue().lastModified() < cutoff && cloudBodies.remove(entry.getKey(), entry.getValue())) entry.getValue().delete();
            }
            if (cloudBodies.size() >= 4) throw new IllegalStateException();
            File file = File.createTempFile("cloud-upload-", ".bin", getContext().getCacheDir());
            String id = java.util.UUID.randomUUID().toString(); cloudBodies.put(id, file);
            JSObject result = new JSObject(); result.put("id", id); call.resolve(result);
        } catch (Exception error) { call.reject("无法准备云端上传，本地存档仍保留"); }
    }

    @PluginMethod
    public synchronized void appendCloudBody(PluginCall call) {
        try {
            File file = cloudBodies.get(call.getString("id", ""));
            String data = call.getString("data", "");
            if (file == null || data.length() > 360000) throw new IllegalArgumentException();
            byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
            if (file.length() + bytes.length > CLOUD_MAX_BYTES) throw new IllegalArgumentException();
            try (OutputStream output = new FileOutputStream(file, true)) { output.write(bytes); }
            call.resolve();
        } catch (Exception error) { call.reject("云端上传文件过大或不可写，本地存档仍保留"); }
    }

    @PluginMethod
    public synchronized void discardCloudBody(PluginCall call) {
        File file = cloudBodies.remove(call.getString("id", "")); if (file != null) file.delete(); call.resolve();
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
        for (File file : cloudBodies.values()) file.delete(); cloudBodies.clear();
        for (Session session : sessions.values()) {
            session.cancelled.set(true); cancellations.execute(session::disconnect);
        }
        requests.shutdownNow(); cloudRequests.shutdownNow(); cancellations.shutdown();
    }
}
