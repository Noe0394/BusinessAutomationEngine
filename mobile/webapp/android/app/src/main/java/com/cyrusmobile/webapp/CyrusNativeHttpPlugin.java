package com.cyrusmobile.webapp;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;

@CapacitorPlugin(name = "CyrusNativeHttp")
public class CyrusNativeHttpPlugin extends Plugin {
    private static final int MAX_RESPONSE_BYTES = 1024 * 1024;

    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.toLowerCase(Locale.ROOT).startsWith("https://")) {
            call.reject("Une URL HTTPS est requise pour protéger les identifiants.");
            return;
        }
        new Thread(() -> execute(call, url)).start();
    }

    private void execute(PluginCall call, String rawUrl) {
        HttpURLConnection connection = null;
        try {
            String method = call.getData().optString("method", "GET").toUpperCase(Locale.ROOT);
            if (!(method.equals("GET") || method.equals("POST") || method.equals("PUT"))) {
                call.reject("Méthode HTTP non autorisée.");
                return;
            }
            URL url = new URL(rawUrl);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(20000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);

            JSONObject headers = call.getData().optJSONObject("headers");
            if (headers != null) {
                Iterator<String> names = headers.keys();
                while (names.hasNext()) {
                    String name = names.next();
                    String value = headers.optString(name, "");
                    if (!validHeader(name, value) || name.equalsIgnoreCase("host") || name.equalsIgnoreCase("content-length")) continue;
                    connection.setRequestProperty(name, value);
                }
            }
            String authHeader = call.getData().optString("authHeader", "").trim();
            String secretRef = call.getData().optString("secretRef", "").trim();
            if (!secretRef.isEmpty()) {
                if (!validHeader(authHeader, "x")) throw new IllegalArgumentException("En-tête d’authentification invalide.");
                String secret = SecureSecrets.get(getContext(), SecureSecrets.reference(secretRef), rawUrl);
                if (secret == null || secret.isEmpty()) throw new IllegalStateException("Clé API absente du coffre sécurisé.");
                connection.setRequestProperty(authHeader, secret);
            }

            String body = call.getData().optString("body", "");
            if (!body.isEmpty()) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_RESPONSE_BYTES) throw new IllegalArgumentException("Corps de requête trop volumineux.");
                connection.setDoOutput(true);
                if (connection.getRequestProperty("Content-Type") == null) connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }

            int status = connection.getResponseCode();
            InputStream input;
            try { input = status >= 400 ? connection.getErrorStream() : connection.getInputStream(); }
            catch (Exception noBody) { input = connection.getErrorStream(); }
            String responseBody = input == null ? "" : readBounded(input);
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("ok", status >= 200 && status < 300);
            result.put("body", responseBody);
            result.put("contentType", connection.getContentType() == null ? "" : connection.getContentType());
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "Requête API impossible." : error.getMessage(), error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static boolean validHeader(String name, String value) {
        return name != null && name.matches("[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}")
                && value != null && !value.contains("\r") && !value.contains("\n");
    }

    private static String readBounded(InputStream input) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = stream.read(buffer)) != -1) {
                total += count;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("Réponse API trop volumineuse.");
                output.write(buffer, 0, count);
            }
            return output.toString("UTF-8");
        }
    }
}
