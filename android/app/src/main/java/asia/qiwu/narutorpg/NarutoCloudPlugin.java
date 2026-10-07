package asia.qiwu.narutorpg;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** The browser grants access; the Android keystore holds the cloud session. */
@CapacitorPlugin(name = "NarutoCloud")
public class NarutoCloudPlugin extends Plugin {
    static final String ORIGIN = "https://www.qiwu.asia";
    private static final String STORE = "naruto_cloud_session";
    private static final String KEY = "naruto_cloud_session_v1";

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(KEY)) return (SecretKey) store.getKey(KEY, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    static synchronized JSObject readSession(Context context) throws Exception {
        String saved = context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getString("session", null);
        if (saved == null) return null;
        try {
            String[] parts = saved.split(":", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new JSObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception error) {
            context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().remove("session").commit();
            return null; // A restored or invalidated keystore requires login, never a game reset.
        }
    }

    @PluginMethod
    public void getSession(PluginCall call) {
        try {
            JSObject session = readSession(getContext());
            JSObject result = new JSObject();
            result.put("user", session == null ? null : session.optJSONObject("user"));
            call.resolve(result);
        } catch (Exception error) { call.reject("无法读取云端登录，请重新连接"); }
    }

    @PluginMethod
    public synchronized void storeSession(PluginCall call) {
        try {
            String token = call.getString("token", ""); JSObject user = call.getObject("user");
            if (token.length() > 8192 || !token.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")
                || user == null || user.getString("id", "").isEmpty()) throw new IllegalArgumentException();
            JSObject session = new JSObject(); session.put("token", token); session.put("user", user);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
            String saved = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":"
                + Base64.encodeToString(cipher.doFinal(session.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            if (!getContext().getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().putString("session", saved).commit()) throw new IllegalStateException();
            call.resolve();
        } catch (Exception error) { call.reject("无法保存云端登录，请重试"); }
    }

    @PluginMethod
    public void clearSession(PluginCall call) {
        getContext().getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().remove("session").commit(); call.resolve();
    }

    @PluginMethod
    public void openLogin(PluginCall call) {
        String code = call.getString("code", "");
        if (!code.matches("[A-F0-9]{4}-[A-F0-9]{4}")) { call.reject("连接码无效"); return; }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(ORIGIN + "/auth/app/authorize?code=" + code));
            getActivity().startActivity(intent); call.resolve();
        } catch (Exception error) { call.reject("无法打开浏览器，请稍后重试"); }
    }
}
